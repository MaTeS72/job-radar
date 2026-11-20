// Remotive (remotive.com): remote jobs with the region each one accepts.
//
//   https://remotive.com/api/remote-jobs?search=flutter
//
// Remotive asks API users to keep it to a few requests a day, so each query is
// one request and there is no paging.

import { htmlToText, parseDate } from '../text.mjs';

export function mapJob(job) {
  return {
    id: String(job.id),
    title: job.title || '',
    url: job.url,
    company: job.company_name || '',
    location: `Remote (${job.candidate_required_location || 'region not stated'})`,
    remote: 'remote',
    postedAt: parseDate(job.publication_date),
    description: htmlToText(job.description || ''),
  };
}

export default {
  id: 'remotive',
  label: 'Remotive (remote)',

  async list(ctx) {
    const byId = new Map();
    for (const query of ctx.settings.queries || []) {
      let data;
      try {
        data = await ctx.http.json(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}`);
      } catch (err) {
        ctx.log(`"${query}": ${err.message}`);
        continue;
      }
      for (const job of data.jobs || []) {
        if (job.url && !byId.has(job.id)) byId.set(job.id, { ...mapJob(job), queryHit: query });
      }
    }
    return [...byId.values()];
  },
};
