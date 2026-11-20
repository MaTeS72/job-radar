// Workable's public job search (jobs.workable.com): one query runs across every
// company that hosts its jobs on Workable, and results carry the full text.
//
//   https://jobs.workable.com/api/v1/jobs?query=flutter&location=Europe[&pageToken=..]

import { htmlToText, parseDate } from '../text.mjs';

const API = 'https://jobs.workable.com/api/v1/jobs';
const MODE = { remote: 'remote', hybrid: 'hybrid', on_site: 'onsite' };

export function mapJob(job) {
  const places = [job.location, ...(job.locations || [])]
    .map((l) => (typeof l === 'string' ? l : [l?.city, l?.subregion, l?.countryName].filter(Boolean).join(', ')))
    .filter((place) => place && !/^(telecommute|remote)$/i.test(place));
  return {
    id: String(job.id),
    title: job.title || '',
    url: job.url,
    company: job.company?.title || '',
    location: [...new Set(places)].join('; '),
    remote: MODE[job.workplace] || null,
    postedAt: parseDate(job.created),
    description: htmlToText([job.description, job.requirementsSection, job.benefitsSection].filter(Boolean).join('\n')),
  };
}

export default {
  id: 'workable',
  label: 'Workable job search',

  async list(ctx) {
    const { queries = [], locations = [''], max_pages: maxPages = 2 } = ctx.settings;
    const byId = new Map();
    for (const query of queries) {
      for (const location of locations) {
        let token = '';
        for (let page = 0; page < maxPages; page += 1) {
          const params = new URLSearchParams({ query });
          if (location) params.set('location', location);
          if (token) params.set('pageToken', token);
          let data;
          try {
            data = await ctx.http.json(`${API}?${params}`);
          } catch (err) {
            ctx.log(`"${query}" in ${location || 'anywhere'}: ${err.message}`);
            break;
          }
          for (const job of data.jobs || []) {
            if (job.url && !byId.has(job.id)) byId.set(job.id, { ...mapJob(job), queryHit: query });
          }
          token = data.nextPageToken;
          if (!token) break;
        }
      }
    }
    return [...byId.values()];
  },
};
