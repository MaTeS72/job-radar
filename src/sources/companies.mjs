// Company career sites, read directly: the built-in list in config/companies.yml,
// your own companies.yml laid over it (src/config.mjs), and the companies the
// radar added by itself (state/companies-auto.json in your data folder).
//
// A company is either on a known hiring system (`ats` + `slug`), which gives a
// clean list with full texts, or has its own careers page (`url`), where the
// jobs are read out of the page (src/pagejobs.mjs).

import { ATS, detectAts } from '../ats.mjs';
import { jobPostingFromHtml, mainText } from '../jsonld.mjs';
import { readJobs, nextPageUrl, blockedBy, saysNoOpenings } from '../pagejobs.mjs';
import { stripTags } from '../text.mjs';
import { readStateFile } from '../state.mjs';
import { renderPage, browserSource } from '../browser.mjs';

export { extractJobLinks } from '../pagejobs.mjs';

const PLACE_WORDS = /(praha|prague|brno|ostrava|plze[nň]|olomouc|bratislava|remote|hybrid|home ?office|on-?site|z domu|na d[aá]lku|czech|[čc]esk|slovak|europe|evropa|emea|worldwide)/i;

export function loadAutoCompanies() {
  const found = readStateFile('companies-auto.json', []);
  return Array.isArray(found) ? found : [];
}

/** One careers page as the reader wants it, by plain request or in the browser. */
async function loadPage(url, entry, ctx) {
  if (entry.render) {
    const page = await renderPage(url, { capture: true });
    const wall = blockedBy(page.status, page.html);
    if (wall) throw new Error(`the site answers with ${wall}; not read`);
    return page;
  }
  const res = await ctx.http.request(url, { allowStatus: [403, 404, 410, 429, 503] });
  const wall = blockedBy(res.status, res.text);
  if (wall) throw new Error(`the site answers automated requests with ${wall}; not read`);
  return { html: res.text, url: res.url || url, status: res.status, frames: [], requests: [], json: [] };
}

async function readCompany(entry, ctx) {
  const base = { company: entry.name, czechSource: entry.country === 'cz' };
  if (entry.ats && ATS[entry.ats]) {
    const jobs = await ATS[entry.ats].list(entry.slug, ctx.http, entry);
    return jobs.map((job) => ({ ...job, ...base, czechSource: base.czechSource || Boolean(job.czechSource), ats: entry.ats }));
  }
  if (!entry.url) throw new Error('needs either ats + slug or url');

  const byUrl = new Map();
  const seenPages = new Set();
  let url = entry.url;
  let nothingOpen = false;
  // A long list may run over several pages.
  for (let n = 0; n < (entry.max_pages || 6) && url && !seenPages.has(url); n += 1) {
    seenPages.add(url);
    const page = await loadPage(url, entry, ctx);
    if (n === 0 && !entry.link_pattern) {
      const embedded = detectAts(page.html) || [...page.frames, ...page.requests].map((u) => detectAts(u)).find(Boolean);
      if (embedded) {
        // The system's own list is the better source, but only when it answers and has the jobs.
        const fromBoard = await ATS[embedded.ats].list(embedded.slug, ctx.http, entry).catch(() => []);
        if (fromBoard.length) {
          ctx.log(`${entry.name}: careers page runs on ${ATS[embedded.ats].label} ("${embedded.slug}"); set ats/slug in its entry to skip this lookup`);
          return fromBoard.map((job) => ({ ...job, ...base, ats: embedded.ats }));
        }
      }
    }
    const { jobs } = readJobs(page, entry.link_pattern);
    if (n === 0 && !jobs.length) nothingOpen = saysNoOpenings(page.html);
    // Some job widgets answer with an error status and the list anyway; an error page without jobs is a failure.
    if (!jobs.length && page.status >= 400) throw new Error(`HTTP ${page.status} for ${url}`);
    const fresh = jobs.filter((job) => !byUrl.has(job.url));
    fresh.forEach((job) => byUrl.set(job.url, job));
    if (!fresh.length) break;
    url = nextPageUrl(page.html, page.url);
  }
  // A page that says it has nothing open is working as intended; silence from a page that should list jobs is worth a note.
  if (!byUrl.size && !nothingOpen) {
    ctx.log(`${entry.name}: no jobs found on ${entry.url}; run "node radar.mjs discover ${JSON.stringify(entry.name)} ${entry.url}" to see why`);
  }
  // A place printed on the job's own card beats the company-wide default from companies.yml.
  return [...byUrl.values()].map(({ hint, ...job }) => ({
    ...job, ...base, location: PLACE_WORDS.test(hint || '') ? hint : (entry.location || hint || ''), page: true, render: Boolean(entry.render),
  }));
}

export default {
  id: 'companies',
  label: 'Company career sites',
  // Whatever is listed here is open: the posting date does not expire a job.
  live: true,
  detailPolicy: 'generic',

  async list(ctx) {
    const configured = ctx.config.companies?.companies || [];
    const taken = new Set(configured.map((c) => `${c.ats}:${c.slug}`));
    const auto = loadAutoCompanies().filter((c) => !taken.has(`${c.ats}:${c.slug}`));
    const wanted = [...configured, ...auto].filter((c) => c.enabled !== false);
    // Pages built by JavaScript need the headless browser; without one they are left out, with one note.
    const needBrowser = wanted.filter((c) => c.render && !c.ats);
    const skipped = needBrowser.length && !browserSource() ? needBrowser : [];
    const entries = wanted.filter((c) => !skipped.includes(c));

    const jobs = [];
    let failed = 0;
    let next = 0;
    // A few companies at a time; requests to one host still go one by one (http.mjs).
    const worker = async () => {
      while (next < entries.length) {
        const entry = entries[next];
        next += 1;
        try {
          jobs.push(...(await readCompany(entry, ctx)));
        } catch (err) {
          failed += 1;
          ctx.log(`${entry.name}: ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (skipped.length) {
      const one = skipped.length === 1;
      ctx.log(`${skipped.length} ${one ? 'company needs' : 'companies need'} a headless browser and ${one ? 'was' : 'were'} skipped (${skipped.map((c) => c.name).join(', ')}); to read them, in the code folder: npm i playwright && npx playwright install chromium`);
    }
    ctx.log(`${entries.length} companies read${auto.length ? ` (${auto.length} added by the radar)` : ''}${failed ? `, ${failed} failed` : ''}`);
    return jobs.filter((j) => j.title && j.url);
  },

  async detail(job, ctx) {
    if (job.detailUrl && ATS[job.ats]?.detail) return ATS[job.ats].detail(job, ctx.http);
    // A job known only from the page's data has no page of its own to open.
    if (job.approxUrl) return null;
    const html = job.render ? (await renderPage(job.url)).html : await ctx.http.text(job.url);
    const posting = jobPostingFromHtml(html);
    // A title guessed from the link's wording gives way to the one on the job's own page.
    const heading = stripTags(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || '');
    const real = job.guessedTitle ? [posting?.title, heading].find((t) => t && t.length >= 4 && t.length <= 140) : undefined;
    if (posting?.description) {
      return {
        title: real,
        description: posting.description,
        postedAt: posting.postedAt,
        salary: posting.salary,
        location: posting.location,
        remote: posting.remote,
      };
    }
    return { title: real, description: mainText(html) };
  },
};
