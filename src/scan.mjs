// One scan: read every enabled source, open the job pages worth opening, score
// everything against the profile, merge duplicates and sort out what is new.

import { loadConfig } from './config.mjs';
import { createHttp } from './http.mjs';
import { createMatcher } from './match.mjs';
import { jobKey, roleKey } from './keys.mjs';
import { dedupe, foundBy } from './dedupe.mjs';
import { loadKnown } from './careerops.mjs';
import { loadState, readDetail, writeDetail, pruneDetails } from './state.mjs';
import { closeBrowser } from './browser.mjs';

import startupjobs from './sources/startupjobs.mjs';
import jobscz from './sources/jobscz.mjs';
import cocuma from './sources/cocuma.mjs';
import linkedin from './sources/linkedin.mjs';
import workable from './sources/workable.mjs';
import himalayas from './sources/himalayas.mjs';
import remotive from './sources/remotive.mjs';
import weworkremotely from './sources/weworkremotely.mjs';
import hackernews from './sources/hackernews.mjs';
import companies from './sources/companies.mjs';

export const SOURCES = [companies, startupjobs, cocuma, jobscz, workable, himalayas, remotive, weworkremotely, hackernews, linkedin];
// When one role shows up in several places, the earlier source's listing is kept (see dedupe.mjs).
const PRIORITY = Object.fromEntries(SOURCES.map((s, i) => [s.id, i]));

export { loadConfig };

async function runSource(source, { config, http, matcher, now, verbose, useCache }) {
  const settings = config.sources.sources?.[source.id] || {};
  const started = Date.now();
  const notes = [];
  const log = (msg) => { notes.push(msg); if (verbose) console.error(`  [${source.id}] ${msg}`); };
  // Optional time budget per source (max_minutes in sources.yml): slow, rate-limited sites stop there.
  const deadline = settings.max_minutes ? started + settings.max_minutes * 60_000 : Infinity;
  const outOfTime = () => Date.now() > deadline;
  const ctx = { http, settings, config, log, now, outOfTime };
  const out = { id: source.id, label: source.label, listed: 0, opened: 0, cached: 0, jobs: [], notes, error: null };

  let listed;
  try {
    listed = await source.list(ctx);
  } catch (err) {
    out.error = err.message;
    out.seconds = Math.round((Date.now() - started) / 1000);
    return out;
  }
  out.listed = listed.length;

  const jobs = listed.map((job) => ({ ...job, source: source.id, key: jobKey(job.url), live: Boolean(source.live) }));

  // Which job pages are worth a request?
  if (source.detail) {
    const wanted = [];
    for (const job of jobs) {
      if ((job.description || '').length > 200) continue;
      const pre = matcher.preScore(job);
      if (pre.excluded) continue;
      if (pre.worthDetail || (source.detailPolicy === 'generic' && pre.generic)) wanted.push({ job, rank: pre.titleScore });
    }
    wanted.sort((a, b) => b.rank - a.rank || (b.job.postedAt || 0) - (a.job.postedAt || 0));
    const limit = settings.detail_limit ?? config.sources.detail_limit ?? 60;
    let failures = 0;
    for (const { job } of wanted) {
      const cached = useCache ? readDetail(job.key, now) : null;
      if (cached) { Object.assign(job, mergeDetail(job, cached)); out.cached += 1; continue; }
      if (out.opened >= limit || outOfTime()) { out.skippedDetails = (out.skippedDetails || 0) + 1; continue; }
      if (failures >= 3) continue;
      try {
        const detail = await source.detail(job, ctx);
        out.opened += 1;
        failures = 0;
        if (detail) { writeDetail(job.key, detail, now); Object.assign(job, mergeDetail(job, detail)); }
      } catch (err) {
        failures += 1;
        log(`job page failed (${job.title}): ${err.message}`);
        if (failures >= 3) log('three job pages failed in a row; the rest are scored from their titles');
      }
    }
    if (out.skippedDetails) log(`${out.skippedDetails} more job pages were not opened (${outOfTime() ? 'time budget' : `limit ${limit}`}); they are scored from their titles`);
  }

  for (const job of jobs) {
    const verdict = matcher.score(job, { now });
    out.jobs.push({ ...job, ...verdict });
  }
  out.seconds = Math.round((Date.now() - started) / 1000);
  return out;
}

function mergeDetail(job, detail) {
  const merged = {};
  for (const [field, value] of Object.entries(detail)) {
    if (value === undefined || value === null || value === '') continue;
    // The list entry wins for location (boards state it more precisely than the page markup).
    if (field === 'location' && job.location) continue;
    merged[field] = value;
  }
  return merged;
}

/**
 * @param {object} [options]
 * @param {string[]} [options.only] source ids to run (default: all enabled)
 * @param {boolean} [options.verbose]
 * @param {boolean} [options.dry] do not record the results in state
 * @param {boolean} [options.fresh] ignore cached job pages
 */
export async function runScan({ only, verbose = false, dry = false, fresh = false } = {}) {
  const now = Date.now();
  const config = loadConfig();
  const matcher = createMatcher(config.profile);
  const pacing = config.sources.pacing || {};
  const http = createHttp({
    defaultIntervalMs: pacing.default ?? 700,
    intervals: pacing.hosts || {},
    log: (msg) => { if (verbose) console.error(`  [http] ${msg}`); },
  });

  const active = SOURCES.filter((s) => {
    if (only?.length) return only.includes(s.id);
    return config.sources.sources?.[s.id]?.enabled !== false;
  });

  if (verbose) console.error(`Scanning ${active.map((s) => s.id).join(', ')} ...`);
  const results = await Promise.all(active.map(async (source) => {
    const result = await runSource(source, { config, http, matcher, now, verbose, useCache: !fresh });
    if (verbose) {
      console.error(`  [${source.id}] ${result.error ? `FAILED: ${result.error}` : `${result.listed} listed, ${result.opened} pages opened, ${result.seconds} s`}`);
    }
    return result;
  }));
  await closeBrowser();

  const all = results.flatMap((r) => r.jobs);
  const matches = dedupe(all.filter((j) => j.tier === 'strong' || j.tier === 'maybe'), {
    priority: PRIORITY,
    score: (job) => matcher.score(job, { now }),
  }).sort((a, b) => b.score - a.score || (b.postedAt || 0) - (a.postedAt || 0));

  const known = loadKnown();
  const state = loadState();
  const today = new Date(now).toISOString().slice(0, 10);
  // The same role reported earlier under another link (a board then, the company's own site now) is not new.
  const reportedRoles = new Map();
  for (const entry of Object.values(state.jobs)) {
    const role = roleKey(entry.company, entry.title);
    if (role && !reportedRoles.has(role)) reportedRoles.set(role, entry);
  }
  for (const job of matches) {
    job.knownIn = known.find(job) || (job.alsoAt.map((a) => known.find({ ...job, url: a.url })).find(Boolean) ?? null);
    const seen = state.jobs[job.key] || reportedRoles.get(roleKey(job.company, job.title));
    job.firstSeen = seen?.firstSeen || today;
    job.isNew = !seen && !job.knownIn;
    job.pushed = Boolean(seen?.pushedAt);
  }

  if (!dry) {
    for (const job of matches) {
      const seen = state.jobs[job.key] || { firstSeen: today };
      state.jobs[job.key] = {
        ...seen,
        lastSeen: today,
        url: job.url,
        title: job.title,
        company: job.company,
        source: job.source,
        score: job.score,
        tier: job.tier,
      };
    }
    state.runs.push({
      at: new Date(now).toISOString(),
      sources: results.map((r) => ({
        id: r.id, listed: r.listed, opened: r.opened, error: r.error, seconds: r.seconds,
        matched: r.jobs.filter((j) => j.tier === 'strong' || j.tier === 'maybe').length,
      })),
    });
    state.save();
    pruneDetails(now);
  }

  const sources = results.map((r) => ({
    id: r.id, label: r.label, listed: r.listed, opened: r.opened, seconds: r.seconds,
    fits: foundBy(matches, r.id), error: r.error, notes: r.notes,
  }));

  return {
    at: new Date(now).toISOString(),
    today,
    results,
    sources,
    matches,
    excludedCounts: countExclusions(all),
    totals: {
      listed: results.reduce((n, r) => n + r.listed, 0),
      opened: results.reduce((n, r) => n + r.opened, 0),
      strong: matches.filter((j) => j.tier === 'strong').length,
      maybe: matches.filter((j) => j.tier === 'maybe').length,
      fresh: matches.filter((j) => j.isNew).length,
    },
    requests: http.stats(),
    careerOps: known,
  };
}

function countExclusions(jobs) {
  const counts = {};
  for (const job of jobs) {
    if (job.tier !== 'excluded' && job.tier !== 'low') continue;
    const reason = !job.excluded ? 'score too low'
      : job.excluded.startsWith('title') ? 'other profession or level'
      : job.excluded.startsWith('place') ? 'place of work'
      : job.excluded.startsWith('posted') ? 'too old'
      : 'not relevant';
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}
