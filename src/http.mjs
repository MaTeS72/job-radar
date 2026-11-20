// HTTP client with per-host pacing, retries and timeouts.
//
// Every source goes through this, so one place decides how politely each site
// is read: requests to the same host run one at a time with a minimum gap, and
// a 429/5xx answer backs off instead of hammering.

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export class HttpError extends Error {
  constructor(message, { status, url } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} [options]
 * @param {number} [options.defaultIntervalMs] minimum gap between requests to one host
 * @param {Record<string, number>} [options.intervals] per-host gaps (host suffix -> ms)
 * @param {number} [options.timeoutMs]
 * @param {(msg: string) => void} [options.log]
 */
export function createHttp({ defaultIntervalMs = 700, intervals = {}, timeoutMs = 30_000, log = () => {} } = {}) {
  /** @type {Map<string, { chain: Promise<void>, nextAt: number }>} */
  const hosts = new Map();
  /** @type {Map<string, number>} */
  const counts = new Map();

  function intervalFor(host) {
    for (const [suffix, ms] of Object.entries(intervals)) {
      if (host === suffix || host.endsWith(`.${suffix}`)) return ms;
    }
    return defaultIntervalMs;
  }

  /** Run `task` after the host's previous request finished and its gap elapsed. */
  function schedule(host, task) {
    const state = hosts.get(host) || { chain: Promise.resolve(), nextAt: 0 };
    hosts.set(host, state);
    const run = state.chain.then(async () => {
      const wait = state.nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        const gap = intervalFor(host);
        state.nextAt = Date.now() + gap + Math.floor(Math.random() * Math.min(400, gap * 0.25));
      }
    });
    state.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function once(url, { method = 'GET', headers = {}, body, timeout = timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        body,
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': DEFAULT_UA,
          'Accept-Language': 'cs,en;q=0.8',
          Accept: 'text/html,application/json,application/xml;q=0.9,*/*;q=0.8',
          ...headers,
        },
      });
      const text = await res.text();
      return { status: res.status, ok: res.ok, text, url: res.url || url, headers: res.headers };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch a URL as text. Retries 429 and 5xx (and network failures) with backoff.
   *
   * @param {string} url
   * @param {object} [opts]
   * @param {number} [opts.retries] extra attempts after the first one (default 2)
   * @param {number} [opts.backoffMs] first retry delay (default 2500, doubles)
   * @param {number[]} [opts.allowStatus] non-2xx statuses returned instead of thrown
   */
  async function request(url, opts = {}) {
    const { retries = 2, backoffMs = 2500, allowStatus = [], ...init } = opts;
    const host = new URL(url).host.replace(/^www\./, '');
    let attempt = 0;
    for (;;) {
      let res;
      let failure;
      try {
        res = await schedule(host, () => once(url, init));
        counts.set(host, (counts.get(host) || 0) + 1);
      } catch (err) {
        failure = err;
      }
      if (res && (res.ok || allowStatus.includes(res.status))) return res;

      const status = res?.status;
      const retryable = failure || status === 429 || (status >= 500 && status <= 599);
      if (!retryable || attempt >= retries) {
        if (failure) {
          const why = failure.name === 'AbortError' ? 'timed out' : failure.message;
          throw new HttpError(`${host}: ${why}`, { url });
        }
        throw new HttpError(`${host}: HTTP ${status}`, { status, url });
      }
      const retryAfter = Number(res?.headers?.get?.('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 90_000)
        : backoffMs * 2 ** attempt;
      log(`${host}: ${failure ? 'network error' : `HTTP ${status}`}, retrying in ${Math.round(delay / 1000)} s`);
      await sleep(delay);
      attempt += 1;
    }
  }

  return {
    request,
    async text(url, opts) {
      return (await request(url, opts)).text;
    },
    async json(url, opts = {}) {
      const res = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
      try {
        return JSON.parse(res.text);
      } catch {
        throw new HttpError(`${new URL(url).host}: response was not JSON`, { status: res.status, url });
      }
    },
    /** Requests made per host so far (for the run summary). */
    stats() {
      return Object.fromEntries(counts);
    },
  };
}
