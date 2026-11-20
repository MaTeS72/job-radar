// Himalayas (himalayas.app): remote jobs, each with the list of countries it is
// open to, which settles "can this be done from Czechia?" without guessing.
//
//   https://himalayas.app/jobs/api/search?q=flutter&limit=20&offset=0

import { htmlToText, parseDate } from '../text.mjs';

const API = 'https://himalayas.app/jobs/api/search';
const PAGE = 20;

function placeLabel(countries) {
  if (!countries.length) return 'Remote, worldwide';
  if (countries.length <= 3) return `Remote (${countries.join(', ')})`;
  const cz = countries.some((c) => /czech/i.test(c));
  return cz ? `Remote (Czechia and ${countries.length - 1} other countries)` : `Remote (${countries.slice(0, 3).join(', ')} and ${countries.length - 3} more)`;
}

export function mapJob(job) {
  const countries = Array.isArray(job.locationRestrictions) ? job.locationRestrictions : [];
  const monthly = /month/i.test(job.salaryPeriod || '');
  return {
    id: job.guid,
    title: job.title || '',
    url: job.guid || job.applicationLink,
    company: job.companyName || '',
    // No restriction listed means the job is open worldwide.
    location: placeLabel(countries),
    remote: 'remote',
    countries,
    postedAt: parseDate(job.pubDate),
    description: htmlToText(job.description || job.excerpt || ''),
    salary: job.minSalary || job.maxSalary
      ? { min: job.minSalary || undefined, max: job.maxSalary || undefined, currency: job.currency, period: monthly ? 'month' : String(job.salaryPeriod || '').toLowerCase() }
      : undefined,
  };
}

export default {
  id: 'himalayas',
  label: 'Himalayas (remote)',

  async list(ctx) {
    const { queries = [], max_pages: maxPages = 2 } = ctx.settings;
    const byId = new Map();
    for (const query of queries) {
      for (let page = 0; page < maxPages; page += 1) {
        let data;
        try {
          data = await ctx.http.json(`${API}?${new URLSearchParams({ q: query, limit: String(PAGE), offset: String(page * PAGE) })}`);
        } catch (err) {
          ctx.log(`"${query}": ${err.message}`);
          break;
        }
        const jobs = data.jobs || [];
        for (const job of jobs) {
          if (job.guid && !byId.has(job.guid)) byId.set(job.guid, { ...mapJob(job), queryHit: query });
        }
        if (jobs.length < PAGE) break;
      }
    }
    return [...byId.values()];
  },
};
