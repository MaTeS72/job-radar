// Identity of a job: one key per posting URL, and one per company + role, so
// the same opening found on a board, on LinkedIn and on the company site is
// reported once.

import { companyKey, titleKey } from './text.mjs';

const TRACKING_PARAMS = /^(utm_.*|gh_src|lever-source.*|source|src|ref|refid|trk|trackingid|searchid|rps|position|pagenum|originalsubdomain|lang|locale|campaign|fbclid|gclid|mc_cid|mc_eid)$/i;

const ID_PATTERNS = [
  [/startupjobs\.(?:cz|com)\/(?:nabidka|offer|job)\/(\d+)/i, 'startupjobs'],
  [/jobs\.cz\/(?:rpd|pd|fp)\/(\d+)/i, 'jobscz'],
  [/jobs\.cz\/nabidka\/([0-9a-f-]{36})/i, 'jobscz-uuid'],
  [/linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/i, 'linkedin'],
  [/cocuma\.cz\/job\/[^/]+\/(\d+)/i, 'cocuma'],
  [/greenhouse\.io\/(?:embed\/job_app\?[^#]*token=|[^/]+\/jobs\/)(\d+)/i, 'greenhouse'],
  [/[?&]gh_jid=(\d+)/i, 'greenhouse'],
  [/jobs\.(?:eu\.)?lever\.co\/[^/]+\/([0-9a-f-]{36})/i, 'lever'],
  [/jobs\.ashbyhq\.com\/[^/]+\/([0-9a-f-]{36})/i, 'ashby'],
  [/jobs\.workable\.com\/view\/([A-Za-z0-9]+)/i, 'workable'],
  [/apply\.workable\.com\/[^/]+\/j\/([A-Z0-9]+)/i, 'workable-job'],
  [/jobs\.smartrecruiters\.com\/[^/]+\/(\d+)/i, 'smartrecruiters'],
  [/news\.ycombinator\.com\/item\?id=(\d+)/i, 'hn'],
];

/** Stable key for a posting URL (site + posting id where the site has one). */
export function jobKey(url) {
  const raw = String(url || '').trim();
  for (const [re, prefix] of ID_PATTERNS) {
    const m = re.exec(raw);
    if (m) return `${prefix}:${m[1].toLowerCase()}`;
  }
  try {
    const u = new URL(raw);
    for (const name of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(name)) u.searchParams.delete(name);
    }
    u.searchParams.sort();
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    const query = u.searchParams.toString();
    return `${u.host.replace(/^www\./, '').toLowerCase()}${path}${query ? `?${query}` : ''}`;
  } catch {
    return raw.toLowerCase();
  }
}

/** Key for "the same role at the same company", whatever site it was found on. */
export function roleKey(company, title) {
  const c = companyKey(company);
  const t = titleKey(title);
  return c && t ? `${c}|${t}` : '';
}
