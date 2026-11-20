// Readers for the hiring systems company career sites run on. Each takes a
// company's board id ("slug") and returns that company's open jobs, read from
// the same public endpoint the company's own careers page uses.

import { htmlToText, decodeEntities, parseDate, squash, stripTags, companyKey } from './text.mjs';
import { parseSearchPage } from './sources/jobscz.mjs';

const xmlTag = (block, name) => {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? m[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').trim() : '';
};

const mode = (remote, hybrid) => (remote ? 'remote' : hybrid ? 'hybrid' : null);

export const ATS = {
  greenhouse: {
    label: 'Greenhouse',
    boardUrl: (slug) => `https://job-boards.greenhouse.io/${slug}`,
    patterns: [/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i, /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/i],
    async list(slug, http) {
      const data = await http.json(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
      return (data.jobs || []).map((j) => ({
        id: String(j.id),
        title: j.title,
        url: j.absolute_url,
        location: j.location?.name || '',
        postedAt: parseDate(j.first_published || j.updated_at),
        description: htmlToText(decodeEntities(j.content || '')),
      }));
    },
  },

  lever: {
    label: 'Lever',
    boardUrl: (slug) => `https://jobs.lever.co/${slug}`,
    patterns: [/jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/i],
    async list(slug, http, entry) {
      const host = entry?.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
      const data = await http.json(`https://${host}/v0/postings/${slug}?mode=json`);
      return (Array.isArray(data) ? data : []).map((j) => ({
        id: j.id,
        title: j.text,
        url: j.hostedUrl || j.applyUrl,
        location: [j.categories?.location, ...(j.categories?.allLocations || [])].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('; '),
        remote: mode(j.workplaceType === 'remote', j.workplaceType === 'hybrid'),
        postedAt: parseDate(j.createdAt),
        description: [j.descriptionPlain, ...(j.lists || []).map((l) => `${l.text}\n${htmlToText(l.content)}`), j.additionalPlain].filter(Boolean).join('\n\n'),
      }));
    },
  },

  ashby: {
    label: 'Ashby',
    boardUrl: (slug) => `https://jobs.ashbyhq.com/${slug}`,
    patterns: [/jobs\.ashbyhq\.com\/([a-z0-9._%-]+)/i, /api\.ashbyhq\.com\/posting-api\/job-board\/([a-z0-9._%-]+)/i],
    async list(slug, http) {
      const data = await http.json(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
      return (data.jobs || []).filter((j) => j.isListed !== false).map((j) => ({
        id: j.id,
        title: j.title,
        url: j.jobUrl,
        location: [j.location, ...(j.secondaryLocations || []).map((l) => l.location)].filter(Boolean).join('; '),
        remote: mode(j.isRemote || j.workplaceType === 'Remote', j.workplaceType === 'Hybrid'),
        postedAt: parseDate(j.publishedAt),
        description: j.descriptionPlain || htmlToText(j.descriptionHtml || ''),
      }));
    },
  },

  recruitee: {
    label: 'Recruitee',
    boardUrl: (slug) => `https://${slug}.recruitee.com`,
    patterns: [/\/\/([a-z0-9-]+)\.recruitee\.com/i],
    async list(slug, http) {
      const data = await http.json(`https://${slug}.recruitee.com/api/offers/`);
      return (data.offers || []).map((j) => ({
        id: String(j.id),
        title: j.title,
        url: j.careers_url,
        location: j.location || [j.city, j.country].filter(Boolean).join(', '),
        remote: mode(j.remote, j.hybrid),
        postedAt: parseDate(j.published_at || j.created_at),
        description: htmlToText([j.description, j.requirements].filter(Boolean).join('\n')),
      }));
    },
  },

  teamtailor: {
    label: 'Teamtailor',
    boardUrl: (slug) => `https://${slug}.teamtailor.com/jobs`,
    patterns: [/\/\/([a-z0-9-]+)\.teamtailor\.com/i],
    async list(slug, http) {
      const xml = await http.text(`https://${slug}.teamtailor.com/jobs.rss`);
      return xml.split(/<item>/).slice(1).map((item) => {
        const remoteStatus = xmlTag(item, 'remoteStatus').toLowerCase();
        const places = [...item.matchAll(/<tt:location>([\s\S]*?)<\/tt:location>/g)]
          .map((m) => [xmlTag(m[1], 'tt:city'), xmlTag(m[1], 'tt:country')].filter(Boolean).join(', '));
        const url = xmlTag(item, 'link');
        return {
          id: xmlTag(item, 'guid') || url,
          title: decodeEntities(xmlTag(item, 'title')),
          url,
          location: [...new Set(places)].join('; '),
          remote: mode(remoteStatus === 'fully', remoteStatus === 'hybrid' || remoteStatus === 'temporary'),
          postedAt: parseDate(xmlTag(item, 'pubDate')),
          description: htmlToText(decodeEntities(xmlTag(item, 'description'))),
        };
      });
    },
  },

  workable: {
    label: 'Workable',
    boardUrl: (slug) => `https://apply.workable.com/${slug}/`,
    patterns: [/apply\.workable\.com\/([a-z0-9-]+)/i, /\/\/([a-z0-9-]+)\.workable\.com/i],
    async list(slug, http) {
      const data = await http.json(`https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`);
      return (data.jobs || []).map((j) => ({
        id: j.shortcode,
        title: j.title,
        url: j.url || j.shortlink,
        location: [j.city, j.state, j.country].filter(Boolean).join(', '),
        remote: mode(j.telecommuting, false),
        postedAt: parseDate(j.published_on || j.created_at),
        description: htmlToText(j.description || ''),
      }));
    },
  },

  smartrecruiters: {
    label: 'SmartRecruiters',
    boardUrl: (slug) => `https://jobs.smartrecruiters.com/${slug}`,
    patterns: [/(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/i, /api\.smartrecruiters\.com\/v1\/companies\/([A-Za-z0-9_-]+)/i],
    async list(slug, http) {
      const jobs = [];
      for (let offset = 0; offset < 500; offset += 100) {
        const data = await http.json(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100&offset=${offset}`);
        for (const j of data.content || []) {
          jobs.push({
            id: String(j.id),
            title: j.name,
            url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
            location: [j.location?.city, j.location?.region, j.location?.country?.toUpperCase()].filter(Boolean).join(', '),
            remote: mode(j.location?.remote, j.location?.hybrid),
            postedAt: parseDate(j.releasedDate),
            detailUrl: `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${j.id}`,
          });
        }
        if ((data.content || []).length < 100) break;
      }
      return jobs;
    },
    async detail(job, http) {
      const data = await http.json(job.detailUrl);
      const sections = Object.values(data.jobAd?.sections || {}).map((s) => `${s.title || ''}\n${htmlToText(s.text || '')}`);
      return { description: sections.join('\n\n') };
    },
  },

  personio: {
    label: 'Personio',
    boardUrl: (slug) => `https://${slug}.jobs.personio.com`,
    patterns: [/\/\/([a-z0-9-]+)\.jobs\.personio\.(?:de|com)/i],
    async list(slug, http, entry) {
      const tld = entry?.tld || 'com';
      const xml = await http.text(`https://${slug}.jobs.personio.${tld}/xml?language=en`);
      return xml.split(/<position>/).slice(1).map((pos) => {
        const id = xmlTag(pos, 'id');
        const descriptions = [...pos.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/g)]
          .map((m) => `${xmlTag(m[1], 'name')}\n${htmlToText(decodeEntities(xmlTag(m[1], 'value')))}`);
        return {
          id,
          title: decodeEntities(xmlTag(pos, 'name')),
          url: `https://${slug}.jobs.personio.${tld}/job/${id}`,
          location: decodeEntities(xmlTag(pos, 'office')),
          postedAt: parseDate(xmlTag(pos, 'createdAt')),
          description: descriptions.join('\n\n'),
        };
      });
    },
  },

  bamboohr: {
    label: 'BambooHR',
    boardUrl: (slug) => `https://${slug}.bamboohr.com/careers`,
    patterns: [/\/\/([a-z0-9-]+)\.bamboohr\.com/i],
    async list(slug, http) {
      const data = await http.json(`https://${slug}.bamboohr.com/careers/list`);
      return (data.result || []).map((j) => ({
        id: String(j.id),
        title: j.jobOpeningName,
        url: `https://${slug}.bamboohr.com/careers/${j.id}`,
        location: [j.location?.city, j.location?.state, j.atsLocation?.country].filter(Boolean).join(', '),
        remote: mode(j.isRemote, j.locationType === '2'),
        detailUrl: `https://${slug}.bamboohr.com/careers/${j.id}/detail`,
      }));
    },
    async detail(job, http) {
      const data = await http.json(job.detailUrl);
      const opening = data.result?.jobOpening || {};
      return { description: htmlToText(opening.description || ''), postedAt: parseDate(opening.datePosted) };
    },
  },

  // Not a hiring system: the company's own ads on Jobs.cz, for companies whose site
  // cannot be read. `slug` is the company name as searched; ads by other
  // advertisers that merely mention the name are left out.
  jobscz: {
    label: 'Jobs.cz (company ads)',
    boardUrl: (slug) => `https://www.jobs.cz/prace/?q%5B%5D=${encodeURIComponent(slug)}`,
    patterns: [],
    async list(slug, http, entry) {
      const want = companyKey(entry?.match || slug);
      const mine = (card) => {
        const company = companyKey(card.company);
        return company && want && (company === want || company.startsWith(`${want} `) || want.startsWith(`${company} `));
      };
      const byId = new Map();
      for (let page = 1; page <= (entry?.max_pages || 12); page += 1) {
        const url = `https://www.jobs.cz/prace/?q%5B%5D=${encodeURIComponent(slug)}${page > 1 ? `&page=${page}` : ''}`;
        const cards = parseSearchPage(await http.text(url));
        const fresh = cards.filter((card) => !byId.has(card.id));
        fresh.forEach((card) => byId.set(card.id, card));
        // The company's own ads come first; a page without any means the rest only mention the name.
        if (cards.length < 30 || !fresh.length || !fresh.some(mine)) break;
      }
      return [...byId.values()].filter(mine);
    },
  },

  breezy: {
    label: 'Breezy',
    boardUrl: (slug) => `https://${slug}.breezy.hr`,
    patterns: [/\/\/([a-z0-9-]+)\.breezy\.hr/i],
    async list(slug, http) {
      const data = await http.json(`https://${slug}.breezy.hr/json`);
      return (Array.isArray(data) ? data : []).map((j) => ({
        id: j.id,
        title: j.name,
        url: j.url,
        location: j.location?.name || [j.location?.city, j.location?.country?.name].filter(Boolean).join(', '),
        remote: mode(j.location?.is_remote, false),
        postedAt: parseDate(j.published_date),
      }));
    },
  },
};

/**
 * Find a known hiring system in a URL or in a careers page's HTML.
 * @returns {{ ats: string, slug: string } | null}
 */
export function detectAts(text) {
  const haystack = String(text || '');
  for (const [ats, def] of Object.entries(ATS)) {
    for (const re of def.patterns) {
      const m = re.exec(haystack);
      if (!m) continue;
      const slug = decodeURIComponent(m[1]);
      if (['www', 'app', 'api', 'help', 'support', 'careers', 'jobs', 'embed', 'js', 'cdn', 'assets'].includes(slug.toLowerCase())) continue;
      return { ats, slug };
    }
  }
  return null;
}

export { stripTags, squash };
