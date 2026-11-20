// Headless browser for careers pages that are built by JavaScript and so show
// no jobs in their raw HTML. Used for companies marked `render: true` and while
// exploring a new company's site.
//
// It is NOT a way around bot protection. A site that answers automated
// requests with a captcha or a challenge page has said it does not want to be
// read this way; the radar stops there (see blockedBy in pagejobs.mjs). The
// browser sends an ordinary browser's User-Agent, like the plain requests do
// (http.mjs), and nothing more: no patched fingerprints, no stealth plugins,
// no solving of checks.
//
// Playwright is not a dependency of this project. It is used when it is
// installed here (npm i playwright && npx playwright install chromium), and
// otherwise borrowed from career-ops, which installs it for its own use.
// Without either, companies marked `render: true` are skipped with a note.

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { codeDir } from './careerops.mjs';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let launching = null;
let queue = Promise.resolve();

/** Where the headless browser would come from, without starting it: 'here', 'career-ops' or null. */
export function browserSource() {
  try {
    createRequire(import.meta.url).resolve('playwright');
    return 'here';
  } catch { /* not installed in this folder */ }
  const code = codeDir();
  if (!code) return null;
  try {
    createRequire(join(code, 'package.json')).resolve('playwright');
    return 'career-ops';
  } catch {
    return null;
  }
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const code = codeDir();
    if (!code) throw new Error('no headless browser: install Playwright in this folder (npm i playwright && npx playwright install chromium)');
    const require = createRequire(join(code, 'package.json'));
    return import(pathToFileURL(require.resolve('playwright')).href);
  }
}

async function context() {
  if (!launching) {
    launching = (async () => {
      const mod = await loadPlaywright();
      const chromium = mod.chromium || mod.default?.chromium;
      const browser = await chromium.launch({ headless: true });
      const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US', viewport: { width: 1366, height: 900 } });
      return { browser, ctx };
    })();
    launching.catch(() => { launching = null; });
  }
  return launching;
}

/**
 * Load a page in the headless browser and return what it shows after its
 * scripts ran. Pages are loaded one at a time.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {boolean} [options.capture] also record what the page downloads: request URLs and JSON responses
 * @returns {Promise<{ html: string, url: string, status: number, frames: string[], requests: string[], json: { url: string, data: any }[] }>}
 */
export function renderPage(url, { waitMs = 1800, timeoutMs = 30_000, capture = false } = {}) {
  const run = queue.then(async () => {
    const { ctx } = await context();
    const page = await ctx.newPage();
    const requests = [];
    const json = [];
    const pending = [];
    if (capture) {
      page.on('request', (request) => requests.push(request.url()));
      page.on('response', (response) => {
        const type = response.headers()['content-type'] || '';
        if (!/json/i.test(type)) return;
        pending.push(response.text().then((body) => {
          if (body.length < 300 || body.length > 4_000_000) return;
          json.push({ url: response.url(), data: JSON.parse(body) });
        }).catch(() => {}));
      });
    }
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      // Lists that load as you scroll need the scroll.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(waitMs);
      await Promise.allSettled(pending);
      const html = await page.content();
      const frames = page.frames().filter((f) => f !== page.mainFrame()).map((f) => f.url());
      return { html, url: page.url(), status: response?.status() ?? 0, frames, requests, json };
    } finally {
      await page.close().catch(() => {});
    }
  });
  queue = run.then(() => undefined, () => undefined);
  return run;
}

export async function closeBrowser() {
  if (!launching) return;
  const pending = launching;
  launching = null;
  try { (await pending).browser.close(); } catch { /* already gone */ }
}
