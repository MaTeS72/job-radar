// Bridge to career-ops (https://github.com/career-ops-hq/career-ops).
//
// Reading: what career-ops already knows (its inbox, scan history, tracker), so
// the radar never reports a job twice.
// Writing: new matches go into career-ops' own inbox through career-ops' own
// writer, which keeps its file formats, locking and duplicate checks intact.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { jobKey, roleKey } from './keys.mjs';
import { companyKey, similarTitles, longTitleKey } from './text.mjs';

export function dataDir() {
  return process.env.CAREER_OPS_DATA_DIR || join(homedir(), 'career-ops-data');
}

function read(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

/**
 * Everything career-ops has already seen or decided on.
 * @returns {{ available: boolean, find(job): string | null, counts: object }}
 */
export function loadKnown(dir = dataDir()) {
  /** @type {Map<string, string>} */
  const byKey = new Map();
  /** @type {Map<string, string>} */
  const byRole = new Map();
  const counts = { inbox: 0, history: 0, tracker: 0 };

  /** @type {Map<string, { title: string, where: string }[]>} */
  const byCompany = new Map();
  /** @type {Map<string, string>} */
  const byLongTitle = new Map();

  const remember = (url, company, title, where) => {
    if (url) byKey.set(jobKey(url), where);
    const role = roleKey(company, title);
    if (role && !byRole.has(role)) byRole.set(role, where);
    const ck = companyKey(company);
    if (ck && title) byCompany.set(ck, [...(byCompany.get(ck) || []), { title, where }]);
    const long = longTitleKey(title);
    if (long && !byLongTitle.has(long)) byLongTitle.set(long, where);
  };

  // Inbox: "- [ ] url | company | title | ..." and "- [x] #001 | url | company | title | ..."
  for (const line of read(join(dir, 'data', 'pipeline.md')).split('\n')) {
    const m = /^- \[([ xX!])\]\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const cells = m[2].split('|').map((c) => c.trim());
    const at = cells.findIndex((c) => /^https?:\/\//.test(c));
    if (at === -1) continue;
    remember(cells[at], cells[at + 1], cells[at + 2], m[1] === ' ' ? 'in the career-ops inbox' : 'already processed in career-ops');
    counts.inbox += 1;
  }

  // Scan history: only rows that mean "handled" count. A row skipped for its
  // title is exactly what the radar may still want to surface.
  const handled = { added: 'added by a career-ops scan', skipped_dup: 'duplicate in career-ops', skipped_expired: 'closed (career-ops)' };
  const history = read(join(dir, 'data', 'scan-history.tsv')).split('\n');
  for (let i = 1; i < history.length; i += 1) {
    const cols = history[i].split('\t');
    const where = handled[cols[5]];
    if (!where) continue;
    remember(cols[0], cols[4], cols[3], where);
    counts.history += 1;
  }

  // Tracker: "| # | Date | Company | Role | Score | Status | ..."
  for (const line of read(join(dir, 'data', 'applications.md')).split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (!/^\d+$/.test(cells[1] || '')) continue;
    remember(null, cells[3], cells[4], `evaluated in career-ops (${cells[5] || 'no score'}, ${cells[6] || 'no status'})`);
    counts.tracker += 1;
  }

  return {
    available: existsSync(join(dir, 'data')),
    counts,
    find(job) {
      const exact = byKey.get(jobKey(job.url)) || byRole.get(roleKey(job.company, job.title));
      if (exact) return exact;
      // Same company (also "Acme" vs "Acme Data"), near-identical title: the same opening under another link.
      const ck = companyKey(job.company);
      const titles = [job.title, job.titleAlt].filter(Boolean);
      if (ck) {
        for (const [known, roles] of byCompany) {
          if (known !== ck && !known.startsWith(`${ck} `) && !ck.startsWith(`${known} `)) continue;
          const hit = roles.find((r) => titles.some((t) => similarTitles(t, r.title, job.company)));
          if (hit) return hit.where;
        }
      }
      // A long identical title under another company name: a group and its subsidiary, or an agency.
      return titles.map((t) => byLongTitle.get(longTitleKey(t))).find(Boolean) || null;
    },
  };
}

/** Folder of the installed career-ops code (newest version of the Claude Code plugin). */
export function codeDir() {
  if (process.env.CAREER_OPS_CODE_DIR) return process.env.CAREER_OPS_CODE_DIR;
  const base = join(homedir(), '.claude', 'plugins', 'cache', 'career-ops', 'career-ops');
  if (!existsSync(base)) return null;
  const versions = readdirSync(base)
    .filter((name) => existsSync(join(base, name, 'scan.mjs')))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return versions.length ? join(base, versions[versions.length - 1]) : null;
}

/**
 * Add jobs to the career-ops inbox (data/pipeline.md) and its scan history.
 * career-ops skips anything it already has, so pushing twice is harmless.
 *
 * @param {object[]} jobs scored radar jobs
 * @returns {Promise<{ pushed: number, codeDir: string }>}
 */
export async function pushToInbox(jobs, { dir = dataDir() } = {}) {
  const code = codeDir();
  if (!code) throw new Error('career-ops is not installed where expected; set CAREER_OPS_CODE_DIR to its folder');
  process.env.CAREER_OPS_DATA_DIR = dir;
  const scan = await import(pathToFileURL(join(code, 'scan.mjs')).href);
  if (typeof scan.appendToPipeline !== 'function' || typeof scan.appendToScanHistory !== 'function') {
    throw new Error(`career-ops at ${code} no longer exports its inbox writer; nothing was written`);
  }
  const before = read(join(dir, 'data', 'pipeline.md'));
  const offers = jobs.map((job) => ({
    url: job.url,
    title: job.title,
    company: job.company || 'Unknown',
    location: job.place?.label || job.location || '',
    postedAt: job.postedAt,
    source: `radar-${job.source}`,
    description: job.description,
    note: `radar ${job.score} · ${job.trackLabel}${job.flags?.length ? ` · ${job.flags.join('; ')}` : ''}`,
  }));
  await scan.appendToPipeline(offers);
  const after = read(join(dir, 'data', 'pipeline.md'));
  const written = offers.filter((o) => after.includes(o.url) && !before.includes(o.url));
  if (written.length) await scan.appendToScanHistory(written, new Date().toISOString().slice(0, 10), 'added');
  return { pushed: written.length, urls: written.map((o) => o.url), codeDir: code };
}
