// Jobs.cz: keyword searches over the public listing pages, then the job page's
// JobPosting block for the full text.
//
//   https://www.jobs.cz/prace/?q[]=flutter            nationwide
//   https://www.jobs.cz/prace/praha/?q[]=flutter      one region
//
// The search is full-text, so a hit on "flutter" means the word is in the ad
// even when the title says only "Software Developer". 30 cards per page.
//
// The result count is deliberately not parsed: the site writes it as a word
// when there is one result ("Našli jsme pouze jednu nabídku"), which is what
// breaks parsers that expect a number.

import { stripTags } from '../text.mjs';
import { jobPostingFromHtml, mainText } from '../jsonld.mjs';

const BASE = 'https://www.jobs.cz/prace/';
const PAGE_SIZE = 30;
const MONTHS = ['ledna', 'února', 'března', 'dubna', 'května', 'června', 'července', 'srpna', 'září', 'října', 'listopadu', 'prosince'];

export function parsePostedAt(text, now = Date.now()) {
  const t = String(text || '').trim();
  const date = /^(\d{1,2})\.\s*(\p{L}+)$/u.exec(t);
  if (date) {
    const month = MONTHS.indexOf(date[2].toLowerCase());
    if (month === -1) return undefined;
    const year = new Date(now).getFullYear();
    const ms = new Date(year, month, Number(date[1])).getTime();
    return ms > now ? new Date(year - 1, month, Number(date[1])).getTime() : ms;
  }
  if (/^Přidáno dnes/i.test(t)) return now;
  if (/^Přidáno včera/i.test(t)) return now - 86_400_000;
  const ago = /před (\d+) (minut|hodin)/i.exec(t);
  if (ago) return now - Number(ago[1]) * (ago[2] === 'minut' ? 60_000 : 3_600_000);
  return undefined;
}

export function parseSearchPage(html, now = Date.now()) {
  const cards = String(html).split(/<article\s+class="SearchResultCard[^"]*"/).slice(1);
  const jobs = [];
  for (const card of cards) {
    const id = /data-jobad-id="(\d+)"/.exec(card)?.[1];
    const title = stripTags(/data-test-ad-title="([^"]*)"/.exec(card)?.[1]);
    if (!id || !title) continue;
    jobs.push({
      id,
      title,
      url: `https://www.jobs.cz/rpd/${id}/`,
      company: stripTags(/<span translate="no">([\s\S]*?)<\/span>/.exec(card)?.[1]),
      location: stripTags(/data-test="serp-locality"[^>]*>([\s\S]*?)<\/li>/.exec(card)?.[1]),
      postedAt: parsePostedAt(stripTags(/data-test-ad-status="[^"]*"[^>]*>([^<]*)</.exec(card)?.[1]), now),
      czechSource: true,
    });
  }
  return jobs;
}

function searchUrl(keyword, location, page) {
  const path = location ? `${encodeURIComponent(location)}/` : '';
  return `${BASE}${path}?q%5B%5D=${encodeURIComponent(keyword)}${page > 1 ? `&page=${page}` : ''}`;
}

export default {
  id: 'jobscz',
  label: 'Jobs.cz',

  async list(ctx) {
    const { keywords = [], keywords_nationwide: nationwide = [], location = 'praha', max_pages: maxPages = 3 } = ctx.settings;
    const searches = [
      ...nationwide.map((keyword) => ({ keyword, location: '' })),
      ...keywords.map((keyword) => ({ keyword, location })),
    ];
    const byId = new Map();
    for (const search of searches) {
      for (let page = 1; page <= maxPages; page += 1) {
        let html;
        try {
          html = await ctx.http.text(searchUrl(search.keyword, search.location, page));
        } catch (err) {
          ctx.log(`"${search.keyword}" page ${page}: ${err.message}`);
          break;
        }
        const found = parseSearchPage(html, ctx.now);
        let fresh = 0;
        for (const job of found) {
          if (byId.has(job.id)) continue;
          byId.set(job.id, { ...job, queryHit: search.keyword });
          fresh += 1;
        }
        // A page past the end redirects to the last page: nothing new means stop.
        if (found.length < PAGE_SIZE || fresh === 0) break;
      }
    }
    return [...byId.values()];
  },

  async detail(job, ctx) {
    const res = await ctx.http.request(job.url);
    const posting = jobPostingFromHtml(res.text);
    if (posting) {
      return {
        description: posting.description,
        postedAt: posting.postedAt || job.postedAt,
        closesAt: posting.closesAt,
        salary: posting.salary,
        location: job.location || posting.location,
      };
    }
    // Company-branded ad pages carry no JobPosting block: read the page text.
    return { description: mainText(res.text) };
  },
};
