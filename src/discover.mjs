// Works out how a company's jobs can be read, starting from any of its pages:
// the homepage, the careers page, or a hiring-system board.
//
// It walks the site the way a person would (homepage -> careers -> "open
// positions"), prefers a hiring system's own data when the site runs on one,
// follows job widgets embedded from other services, uses plain requests where
// they work and the headless browser for pages built by JavaScript, and keeps
// a trail of what it saw, so "why can this company not be read?" has an answer.
//
// A site that answers with a captcha or a challenge page is not explored
// further: that is the operator saying no to automated reading. For those the
// company's ads on Jobs.cz are offered instead, when it publishes there.

import { ATS, detectAts } from './ats.mjs';
import { readJobs, findCareersLinks, findListingLinks, detectVendors, blockedBy, orgDomain, isHomepage, jobFrames, saysNoOpenings } from './pagejobs.mjs';
import { renderPage } from './browser.mjs';
import { fold, similarTitles } from './text.mjs';

/** Likely board ids for a company name ("Kiwi.com" -> kiwicom, kiwi-com, kiwi). */
export function slugGuesses(name) {
  const words = fold(name).replace(/\./g, ' ').split(' ').filter(Boolean);
  const guesses = [words.join(''), words.join('-'), words[0]];
  if (words.length > 1) guesses.push(`${words.join('')}hq`, words.slice(0, 2).join(''));
  return [...new Set(guesses.filter((g) => g && g.length >= 2))];
}

/** A board's jobs: an array (possibly empty) when the board exists, null when it does not. */
async function tryBoard(ats, slug, http) {
  try {
    const jobs = await ATS[ats].list(slug, http, {});
    return Array.isArray(jobs) ? jobs : null;
  } catch {
    return null;
  }
}

/** Fetch a page with a plain request. Never throws: an unreachable page is a result too. */
export async function loadStatic(url, http) {
  try {
    const res = await http.request(url, { allowStatus: [401, 403, 404, 410, 429, 500, 503], retries: 0, timeout: 20_000 });
    return { html: res.text, url: res.url || url, status: res.status, frames: [], requests: [], json: [], blocked: blockedBy(res.status, res.text), rendered: false };
  } catch (err) {
    return { html: '', url, status: 0, frames: [], requests: [], json: [], blocked: null, rendered: false, error: err.message };
  }
}

/** Load a page in the headless browser. Never throws. */
export async function loadRendered(url) {
  try {
    const page = await renderPage(url, { capture: true });
    return { ...page, blocked: blockedBy(page.status, page.html), rendered: true };
  } catch (err) {
    return { html: '', url, status: 0, frames: [], requests: [], json: [], blocked: null, rendered: true, error: err.message.split('\n')[0] };
  }
}

/**
 * Explore a company's site for its jobs.
 *
 * @param {{ name: string, url?: string }} target
 * @param {object} http
 * @param {{ maxPages?: number, maxRendered?: number }} [limits]
 * @returns {Promise<{ name: string, found: object|null, steps: string[], vendors: string[], reason: string }>}
 *   `found` is a companies.yml entry ({ ats, slug } or { url, render? }) with `jobs` and `sample`;
 *   `found.unverified` marks a board matched by the company's name alone.
 */
export async function explore(target, http, { maxPages = 10, maxRendered = 4 } = {}) {
  const { name, url: startUrl } = target;
  const steps = [];
  const vendors = new Set();
  const visited = new Set();
  let rendered = 0;
  let opened = 0;
  let wall = null;
  /** @type {null | { url: string, jobs: object[], confident: number, render: boolean, via: string }} */
  let best = null;
  let board = null;
  let emptyBoard = null;
  let emptyPage = null;

  const key = (u) => u.replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();
  const short = (u) => u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 70);
  const bestScore = () => (best ? best.confident * 1000 + best.jobs.length : 0);
  // The address to remember for a page: the one asked for, unless the site moved us to another host.
  // (A list address that bounces to its first job would stop working when that job closes.)
  const stableUrl = (page) => {
    try {
      return page.asked && new URL(page.asked).host === new URL(page.url).host ? page.asked : page.url;
    } catch {
      return page.url;
    }
  };

  // What one loaded page tells us: 'board' when a hiring-system board settled it, else how many jobs it showed.
  const weigh = async (page, label) => {
    detectVendors([page.html, ...page.frames, ...page.requests].join('\n')).forEach((v) => vendors.add(v));
    const hit = detectAts(page.url) || detectAts(page.html) || [...page.frames, ...page.requests].map((u) => detectAts(u)).find(Boolean);
    if (hit) {
      const jobs = await tryBoard(hit.ats, hit.slug, http);
      if (jobs?.length) {
        board = { ats: hit.ats, slug: hit.slug, jobs: jobs.length, sample: jobs.slice(0, 3).map((j) => j.title) };
        steps.push(`${label}: runs on ${ATS[hit.ats].label} (board "${hit.slug}", ${jobs.length} jobs)`);
        return 'board';
      }
      if (jobs && !emptyBoard) {
        emptyBoard = { ats: hit.ats, slug: hit.slug, jobs: 0, sample: [] };
        steps.push(`${label}: runs on ${ATS[hit.ats].label} (board "${hit.slug}"), which lists no openings right now`);
      }
    }
    // A front page links to products and case studies as readily as to jobs: only its careers link is used.
    const read = isHomepage(page.url) ? { jobs: [], confident: 0 } : readJobs(page);
    if (read.jobs.length) {
      steps.push(`${label}: ${read.jobs.length} jobs found as ${read.via}${page.rendered ? ' (in the browser)' : ''}`);
      if (read.confident * 1000 + read.jobs.length > bestScore()) {
        best = { url: stableUrl(page), jobs: read.jobs, confident: read.confident, render: page.rendered, via: read.via };
      }
    }
    // A careers page that says it has nothing open is an answer, not a failure.
    if (!read.jobs.length && !isHomepage(page.url) && !emptyPage && saysNoOpenings(page.html)) {
      emptyPage = { url: stableUrl(page), render: page.rendered };
      steps.push(`${label}: says there are no open positions right now`);
    }
    return read.jobs.length;
  };

  // Open one URL: a plain request first; the browser only when the page loads fine but shows no jobs.
  // `role` says what the page is to us: 'start', 'home', 'careers', 'listing' or 'frame'.
  const open = async (url, role) => {
    if (visited.has(key(url)) || opened >= maxPages) return null;
    visited.add(key(url));
    opened += 1;
    const label = short(url);
    let page = { ...(await loadStatic(url, http)), asked: url };
    if (page.error) { steps.push(`${label}: could not be reached (${page.error})`); return null; }
    if (page.blocked) {
      // Only the company's own entry points decide that the site is closed to us; a stray link does not.
      if (role === 'start' || role === 'home') wall = page.blocked;
      steps.push(`${label}: answers automated requests with ${page.blocked}; not read`);
      return null;
    }
    visited.add(key(page.url));
    const before = bestScore();
    // Some job widgets answer with an error status and the list anyway, so the content is weighed first.
    const seen = page.html ? await weigh(page, label) : 0;
    if (seen === 'board') return page;
    const gotJobs = seen > 0;
    if (page.status >= 400 && !gotJobs) { steps.push(`${label}: does not exist (HTTP ${page.status})`); return null; }

    const front = isHomepage(page.url);
    // The browser is for pages that load fine but show nothing: a careers page without jobs, a front page without links.
    const worthBrowser = front ? findCareersLinks(page.html, page.url).length === 0 : role !== 'home' && !gotJobs;
    if (worthBrowser && rendered < maxRendered) {
      rendered += 1;
      const shown = { ...(await loadRendered(url)), asked: url };
      if (shown.error) steps.push(`${label}: the browser could not load it (${shown.error})`);
      else if (shown.blocked) steps.push(`${label}: answers the browser with ${shown.blocked}; not read`);
      else if (shown.status < 400) {
        visited.add(key(shown.url));
        const shownJobs = await weigh(shown, label);
        if (shownJobs === 'board') return shown;
        page = shown;
        // Jobs shown through another service's widget: read the widget itself.
        if (!shownJobs) {
          for (const frame of jobFrames(shown).slice(0, 2)) {
            if (board) break;
            const inner = await open(frame, 'frame');
            if (inner && bestScore() > before) steps.push(`  (a job widget embedded in ${label})`);
          }
        }
        if (!front && !board && !shownJobs && !emptyPage && bestScore() === before) steps.push(`${label}: no jobs visible, also not in the browser`);
      }
    }
    return page;
  };

  // The careers page may show only a few featured jobs: look for the full list behind it.
  const followListing = async (page) => {
    for (const link of findListingLinks(page.html, page.url).slice(0, 3)) {
      if (board) return;
      const before = bestScore();
      const next = await open(link.url, 'listing');
      if (next && bestScore() > before) steps.push(`  (reached through the link "${link.text || link.url}")`);
    }
  };

  // 0. The address itself may already be a board.
  const direct = startUrl && detectAts(startUrl);
  if (direct) {
    const jobs = await tryBoard(direct.ats, direct.slug, http);
    if (jobs?.length) board = { ats: direct.ats, slug: direct.slug, jobs: jobs.length, sample: jobs.slice(0, 3).map((j) => j.title) };
  }

  if (!board && startUrl) {
    // 1. The page we were given.
    const first = await open(startUrl, 'start');
    if (first && !board && !isHomepage(first.url)) await followListing(first);

    // 2. If that showed no jobs, walk in from the site's front door: homepage -> careers -> list.
    if (!board && !wall && (!best || best.confident < 2)) {
      const roots = [];
      try {
        const u = new URL(startUrl);
        roots.push(`${u.protocol}//${u.host}/`);
        const org = orgDomain(u.host);
        if (u.host.replace(/^www\./, '') !== org) roots.push(`${u.protocol}//${org}/`);
      } catch { /* not a URL */ }
      const pages = first ? [first] : [];
      for (const root of roots) {
        const home = await open(root, 'home');
        if (home) pages.push(home);
      }
      const careers = new Map();
      for (const page of pages) for (const link of findCareersLinks(page.html, page.url)) if (!careers.has(link.url)) careers.set(link.url, link);
      const ranked = [...careers.values()].sort((a, b) => b.score - a.score).slice(0, 4);
      if (!ranked.length && pages.length) steps.push('no link to a careers page was found on the site');
      for (const link of ranked) {
        if (board || (best && best.confident >= 3)) break;
        const page = await open(link.url, 'careers');
        if (page) {
          steps.push(`  (careers page reached through the link "${link.text || link.url}")`);
          if (!board) await followListing(page);
        }
      }
    }
  }

  // 3. A site closed to automated readers: the company's own ads on Jobs.cz, when it publishes there.
  if (!board && !best && wall) {
    const ads = await tryBoard('jobscz', name, http);
    if (ads?.length) {
      board = { ats: 'jobscz', slug: name, jobs: ads.length, sample: ads.slice(0, 3).map((j) => j.title), country: 'cz' };
      steps.push(`Jobs.cz: ${ads.length} ads published by ${ads[0].company || name}; read from there instead`);
    }
  }

  // 4. Without any address to go by: the company's name on each hiring system (cannot be verified).
  if (!board && !best && !emptyBoard && !startUrl) {
    const attempts = [];
    for (const slug of slugGuesses(name)) {
      for (const ats of Object.keys(ATS).filter((a) => a !== 'jobscz')) {
        attempts.push(tryBoard(ats, slug, http).then((jobs) => (jobs?.length ? { ats, slug, jobs } : null)));
      }
    }
    const hits = (await Promise.all(attempts)).filter(Boolean).sort((a, b) => b.jobs.length - a.jobs.length);
    if (hits.length) {
      const hit = hits[0];
      board = { ats: hit.ats, slug: hit.slug, jobs: hit.jobs.length, sample: hit.jobs.slice(0, 3).map((j) => j.title), unverified: true };
      steps.push(`found a ${ATS[hit.ats].label} board named "${hit.slug}" (${hit.jobs.length} jobs) by the company's name alone: check it is the right company`);
    }
  }

  const all = [...vendors];
  if (board) return { name, found: { name, ...board }, steps, vendors: all, reason: '' };
  if (best && best.jobs.length) {
    const found = { name, url: best.url, jobs: best.jobs.length, sample: best.jobs.slice(0, 3).map((j) => j.title) };
    if (best.render) found.render = true;
    return { name, found, steps, vendors: all, reason: '' };
  }
  if (emptyBoard) return { name, found: { name, ...emptyBoard }, steps, vendors: all, reason: '' };
  if (emptyPage) {
    const found = { name, url: emptyPage.url, jobs: 0, sample: [] };
    if (emptyPage.render) found.render = true;
    return { name, found, steps, vendors: all, reason: '' };
  }

  const readable = new Set(Object.values(ATS).map((a) => a.label));
  const unsupported = all.filter((v) => !readable.has(v));
  let reason = 'no openings could be read from its careers page (it may have none right now, or show them only after clicking through the page)';
  if (!startUrl) reason = 'no web address was given, and no hiring system has a board under this name';
  else if (wall) reason = `the site answers automated readers with ${wall}, the radar does not work around that, and the company has no ads of its own on Jobs.cz`;
  else if (steps.some((s) => s.startsWith('no link to a careers page'))) reason = 'no careers page could be found on the site';
  else if (unsupported.length) reason = `the site lists its jobs through ${unsupported.join(', ')}, which the radar cannot read yet`;
  else if (steps.length && steps.every((s) => /does not exist|could not be reached/.test(s))) reason = 'none of the addresses tried exist';
  return { name, found: null, steps, vendors: all, reason };
}

/** Kept for callers that only want the entry. */
export async function discoverCompany(target, http) {
  const result = await explore(target, http);
  return result.found ? { ...result.found, how: result.steps.at(-1) || '' } : null;
}

/**
 * The hiring-system board of the company behind a job found elsewhere.
 * A board counts only when it lists that same job, so a company that merely
 * shares the name is never picked up.
 *
 * @returns {Promise<{ name: string, ats: string, slug: string, url: string } | null>}
 */
export async function findBoardFor(job, http) {
  const attempts = [];
  for (const slug of slugGuesses(job.company)) {
    for (const ats of Object.keys(ATS).filter((a) => a !== 'jobscz')) {
      attempts.push(tryBoard(ats, slug, http).then((jobs) => {
        const same = (jobs || []).find((other) => similarTitles(other.title, job.title, job.company));
        return same ? { name: job.company, ats, slug, url: same.url } : null;
      }));
    }
  }
  return (await Promise.all(attempts)).find(Boolean) || null;
}

/** A company's entry for companies.yml: only the fields the reader needs. */
export function toEntry(found, extra = {}) {
  const entry = { name: found.name };
  if (found.ats) Object.assign(entry, { ats: found.ats, slug: found.slug });
  else entry.url = found.url;
  if (found.render) entry.render = true;
  for (const [key, value] of Object.entries({ country: found.country, ...extra })) if (value) entry[key] = value;
  return entry;
}

/** The same entry as the line to paste into companies.yml. */
export function toYaml(found, extra = {}) {
  const quotedKeys = new Set(['name', 'slug', 'url']);
  const fields = Object.entries(toEntry(found, extra)).map(([key, value]) => `${key}: ${quotedKeys.has(key) ? JSON.stringify(value) : value}`);
  return `  - { ${fields.join(', ')} }`;
}
