// We Work Remotely: category RSS feeds. Each item is "Company: Role" with a
// region ("Anywhere in the World", "Europe Only", "USA Only").

import { decodeEntities, htmlToText, parseDate, squash } from '../text.mjs';

const tag = (item, name) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(item);
  return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim() : '';
};

export function parseFeed(xml) {
  const jobs = [];
  for (const item of String(xml).split(/<item>/).slice(1)) {
    const raw = decodeEntities(tag(item, 'title'));
    const split = raw.indexOf(': ');
    const url = tag(item, 'link') || tag(item, 'guid');
    if (!raw || !url) continue;
    jobs.push({
      id: url,
      title: squash(split === -1 ? raw : raw.slice(split + 2)),
      company: squash(split === -1 ? '' : raw.slice(0, split)),
      url,
      location: `Remote (${decodeEntities(tag(item, 'region')) || 'region not stated'})`,
      remote: 'remote',
      postedAt: parseDate(tag(item, 'pubDate')),
      description: htmlToText(decodeEntities(tag(item, 'description'))),
    });
  }
  return jobs;
}

export default {
  id: 'weworkremotely',
  label: 'We Work Remotely',

  async list(ctx) {
    const byId = new Map();
    for (const feed of ctx.settings.feeds || []) {
      try {
        for (const job of parseFeed(await ctx.http.text(feed))) if (!byId.has(job.id)) byId.set(job.id, job);
      } catch (err) {
        ctx.log(`${feed}: ${err.message}`);
      }
    }
    return [...byId.values()];
  },
};
