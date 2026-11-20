// StartupJobs.cz: the site's own search API (the one its listing page calls).
//
//   POST https://back.startupjobs.cz/api/search-offers?page=N   body {}
//   GET  https://back.startupjobs.cz/api/offers/{id}            (description, dates, skills)
//
// The whole board is a few hundred offers, so it is read completely and
// filtered here rather than through the site's category pages.

import { htmlToText, parseDate } from '../text.mjs';

const API = 'https://back.startupjobs.cz/api';
const SITE = 'https://www.startupjobs.cz';
const HEADERS = { Accept: 'application/ld+json', 'Content-Type': 'application/json', Origin: SITE, Referer: `${SITE}/` };

const pick = (value) => (value && typeof value === 'object' ? value.cs || value.en || '' : value || '');

function workplace(preferences) {
  const list = (preferences || []).map((p) => (typeof p === 'string' ? p : p?.id));
  if (list.includes('remote')) return 'remote';
  if (list.includes('hybrid')) return 'hybrid';
  return list.length ? 'onsite' : null;
}

function salary(raw) {
  if (!raw || (!raw.min && !raw.max)) return undefined;
  // Amounts come in hundredths (5000000 = CZK 50,000).
  const amount = (v) => (v ? Math.round(Number(v) / 100) : undefined);
  return { min: amount(raw.min), max: amount(raw.max), currency: raw.currency, period: raw.period };
}

export function mapOffer(offer) {
  const cs = pick(offer.name);
  const en = offer.name?.en && offer.name.en !== cs ? offer.name.en : undefined;
  const slug = pick(offer.slug);
  return {
    id: String(offer.id),
    title: cs,
    titleAlt: en,
    url: `${SITE}/nabidka/${offer.id}/${slug}`,
    company: offer.company?.name || '',
    location: (offer.locations || []).map((l) => pick(l.name)).filter(Boolean).join('; '),
    remote: workplace(offer.locationPreferences),
    salary: salary(offer.salary),
    seniority: (offer.seniorities || []).map((s) => (typeof s === 'string' ? s : s?.id)).filter(Boolean),
    contracts: (offer.contracts || []).map((c) => (typeof c === 'string' ? c : c?.id)).filter(Boolean),
    czechSource: true,
  };
}

export default {
  id: 'startupjobs',
  label: 'StartupJobs.cz',
  // Whatever is listed here is open: the posting date does not expire a job.
  live: true,
  // Small board with a cheap API: also open generic engineering titles.
  detailPolicy: 'generic',

  async list(ctx) {
    const maxPages = ctx.settings.max_pages || 40;
    const jobs = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const data = await ctx.http.json(`${API}/search-offers?page=${page}`, { method: 'POST', body: '{}', headers: HEADERS });
      const members = data.member || data['hydra:member'] || [];
      jobs.push(...members.map(mapOffer));
      if (!members.length || !data.view?.next) break;
    }
    return jobs;
  },

  async detail(job, ctx) {
    const data = await ctx.http.json(`${API}/offers/${job.id}`, { headers: HEADERS });
    const skills = (data.requiredSkills || []).map((s) => pick(s.skill?.name)).filter(Boolean);
    const languages = (data.requiredLanguages || [])
      .map((l) => `${l.language?.name?.en || pick(l.language?.name)}${l.level ? ` (${l.level})` : ''}`)
      .filter(Boolean);
    const parts = [htmlToText(pick(data.description))];
    if (data.field?.name) parts.push(`Field: ${data.field.name.en || pick(data.field.name)}`);
    if (skills.length) parts.push(`Skills: ${skills.join(', ')}`);
    if (languages.length) parts.push(`Languages: ${languages.join(', ')}`);
    return {
      description: parts.filter(Boolean).join('\n\n'),
      postedAt: parseDate(data.publishedAt) || parseDate(data.createdAt),
      applyUrl: data.applyUrl || undefined,
    };
  },
};
