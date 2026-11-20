// LinkedIn: the public job search that signed-out visitors see.
//
//   /jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=..&location=..&start=N   10 cards a page
//   /jobs-guest/jobs/api/jobPosting/{id}                                             one job's text
//
// No account, no cookies. LinkedIn answers 429 when read quickly, so this host
// is paced at one request every 20 s (config/sources.yml) and the number of
// searches, pages and opened jobs is capped. It is an unofficial endpoint:
// expect it to change, and keep the volume low.
//
// Off in the built-in settings: LinkedIn's terms do not allow automated
// reading, so turning this source on is each user's own decision.

import { htmlToText, stripTags, parseDate } from '../text.mjs';

const BASE = 'https://www.linkedin.com/jobs-guest/jobs/api';
const HEADERS = { 'Accept-Language': 'en-US,en;q=0.8', Accept: 'text/html' };

export function parseCards(html) {
  const jobs = [];
  for (const card of String(html).split(/<li\b[^>]*>/).slice(1)) {
    const id = /urn:li:jobPosting:(\d+)/.exec(card)?.[1];
    const title = stripTags(/class="base-search-card__title"[^>]*>([\s\S]*?)<\/h3>/.exec(card)?.[1]);
    if (!id || !title) continue;
    jobs.push({
      id,
      title,
      url: `https://www.linkedin.com/jobs/view/${id}/`,
      company: stripTags(/class="base-search-card__subtitle"[^>]*>([\s\S]*?)<\/h4>/.exec(card)?.[1]),
      location: stripTags(/class="job-search-card__location"[^>]*>([\s\S]*?)<\/span>/.exec(card)?.[1]),
      postedAt: parseDate(/<time[^>]*datetime="([^"]+)"/.exec(card)?.[1]),
    });
  }
  return jobs;
}

export function parsePosting(html) {
  const description = htmlToText(/class="show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<button|<\/section)/.exec(html)?.[1]
    || /class="show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1]
    || '');
  const criteria = {};
  const re = /description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>\s*<span[^>]*>([\s\S]*?)<\/span>/g;
  for (const m of String(html).matchAll(re)) criteria[stripTags(m[1]).toLowerCase()] = stripTags(m[2]);
  return { description, criteria };
}

function searchUrl(search, windowDays, start) {
  const params = new URLSearchParams({ keywords: search.keywords, location: search.location || 'Czechia' });
  params.set('f_TPR', `r${Math.max(1, windowDays) * 86_400}`);
  if (search.remote) params.set('f_WT', '2');
  params.set('start', String(start));
  return `${BASE}/seeMoreJobPostings/search?${params}`;
}

export default {
  id: 'linkedin',
  label: 'LinkedIn',

  async list(ctx) {
    const { searches = [], window_days: windowDays = 14, pages = 2 } = ctx.settings;
    const byId = new Map();
    let blocked = false;
    for (const search of searches) {
      if (blocked || ctx.outOfTime()) break;
      const maxPages = search.pages || pages;
      for (let page = 0; page < maxPages; page += 1) {
        if (ctx.outOfTime()) break;
        let html;
        try {
          html = await ctx.http.text(searchUrl(search, windowDays, page * 10), { headers: HEADERS, retries: 2, backoffMs: 30_000 });
        } catch (err) {
          ctx.log(`"${search.keywords}" (${search.location || 'Czechia'}): ${err.message}`);
          // A lasting 429 means the whole host is cooling down: stop instead of digging deeper.
          if (err.status === 429) blocked = true;
          break;
        }
        const found = parseCards(html);
        for (const job of found) {
          if (!byId.has(job.id)) byId.set(job.id, { ...job, remote: search.remote ? 'remote' : null, queryHit: search.keywords });
        }
        if (found.length < 10) break;
      }
    }
    if (blocked) ctx.log('stopped early: LinkedIn is rate limiting; results so far are kept');
    else if (ctx.outOfTime()) ctx.log('stopped early: time budget used up (max_minutes); results so far are kept');
    return [...byId.values()];
  },

  async detail(job, ctx) {
    const html = await ctx.http.text(`${BASE}/jobPosting/${job.id}`, { headers: HEADERS, retries: 1, backoffMs: 30_000 });
    const { description, criteria } = parsePosting(html);
    const extra = Object.entries(criteria).map(([k, v]) => `${k}: ${v}`).join('\n');
    return { description: [description, extra].filter(Boolean).join('\n\n') };
  },
};
