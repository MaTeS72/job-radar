// Cocuma.cz: curated Czech companies. The listing has no working keyword search
// (its ?search= does not filter), so every page of the board is read.
//
//   https://www.cocuma.cz/jobs/            page 1
//   https://www.cocuma.cz/jobs/page/N/     page N

import { stripTags } from '../text.mjs';
import { mainText } from '../jsonld.mjs';

const SITE = 'https://www.cocuma.cz';

export function parseListing(html) {
  const jobs = [];
  const re = /<a\s+class="[^"]*job-thumbnail[^"]*"\s+href="(\/job\/[^"]+\/(\d+)\/)"[^>]*title="([^"]*)"[\s\S]*?<\/a>/g;
  for (const m of String(html).matchAll(re)) {
    const card = m[0];
    jobs.push({
      id: m[2],
      url: `${SITE}${m[1]}`,
      title: stripTags(m[3]),
      company: stripTags(/job-thumbnail-company[^>]*>([\s\S]*?)<\/p>/.exec(card)?.[1]),
      location: stripTags(/job-thumbnail-city[^>]*>([\s\S]*?)<\/p>/.exec(card)?.[1]),
      czechSource: true,
    });
  }
  return jobs;
}

export default {
  id: 'cocuma',
  label: 'Cocuma',
  // Whatever is listed here is open: the posting date does not expire a job.
  live: true,
  detailPolicy: 'generic',

  async list(ctx) {
    const maxPages = ctx.settings.max_pages || 20;
    const byId = new Map();
    for (let page = 1; page <= maxPages; page += 1) {
      const url = page === 1 ? `${SITE}/jobs/` : `${SITE}/jobs/page/${page}/`;
      let html;
      try {
        html = await ctx.http.text(url, { allowStatus: [404] });
      } catch (err) {
        ctx.log(`page ${page}: ${err.message}`);
        break;
      }
      const found = parseListing(html);
      const fresh = found.filter((job) => !byId.has(job.id));
      fresh.forEach((job) => byId.set(job.id, job));
      if (!fresh.length) break;
    }
    return [...byId.values()];
  },

  async detail(job, ctx) {
    return { description: mainText(await ctx.http.text(job.url)) };
  },
};
