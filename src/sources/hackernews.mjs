// Hacker News "Ask HN: Who is hiring?": the current monthly thread, searched
// through the public Algolia API. Posts are free text; the convention is a
// first line of "Company | Role | Location | Remote | ...".

import { htmlToText, squash } from '../text.mjs';

const API = 'https://hn.algolia.com/api/v1/search_by_date';
const ROLE_WORDS = /(engineer|developer|designer|manager|lead|founder|architect|scientist|head of|product|programmer)/i;

const PLACE_WORDS = /(remote|on-?site|hybrid|europe|emea|\beu\b|worldwide|anywhere|usa?\b|uk\b|\b[A-Z][a-z]+, [A-Z]{2}\b|london|berlin|new york|san francisco|sf\b|nyc\b|prague|amsterdam|paris)/i;

/** A post in the thread's convention ("Company | Role | Place | ..."), or null for anything else. */
export function mapComment(hit) {
  const text = htmlToText(hit.comment_text || '');
  const first = squash(text.split('\n')[0] || '').slice(0, 300);
  const parts = first.split(/\s*[|•]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const roles = parts.slice(1).filter((p) => ROLE_WORDS.test(p) && p.length <= 90);
  if (!roles.length) return null;
  const places = parts.slice(1).filter((p) => !roles.includes(p) && PLACE_WORDS.test(p) && p.length <= 80);
  return {
    id: String(hit.objectID),
    title: roles.slice(0, 2).join(' / '),
    company: parts[0].replace(/\s*\(.*?\)\s*$/, '').slice(0, 60),
    url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    location: places.join(', ').slice(0, 120),
    remote: /\bremote\b/i.test(first) ? 'remote' : null,
    postedAt: hit.created_at_i ? hit.created_at_i * 1000 : undefined,
    description: text,
  };
}

export default {
  id: 'hackernews',
  label: 'HN Who is hiring',

  async list(ctx) {
    const stories = await ctx.http.json(`${API}?tags=story,author_whoishiring&hitsPerPage=6`);
    const thread = (stories.hits || []).find((h) => /^Ask HN: Who is hiring\?/i.test(h.title || ''));
    if (!thread) throw new Error('current "Who is hiring?" thread not found');
    const byId = new Map();
    for (const query of ctx.settings.queries || []) {
      try {
        const data = await ctx.http.json(`${API}?${new URLSearchParams({ tags: `comment,story_${thread.objectID}`, query, hitsPerPage: '60' })}`);
        for (const hit of data.hits || []) {
          // Top-level posts only: replies are discussion, not openings.
          if (String(hit.parent_id) !== String(thread.objectID)) continue;
          const job = byId.has(hit.objectID) ? null : mapComment(hit);
          if (job) byId.set(hit.objectID, { ...job, queryHit: query });
        }
      } catch (err) {
        ctx.log(`"${query}": ${err.message}`);
      }
    }
    return [...byId.values()];
  },
};
