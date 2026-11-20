// The same opening often shows up in several places: on a board and on the
// company's own site, or under two links on one board. They become one entry.
//
// The listing from the earlier source is the record that is kept. From the
// other listing it takes only what it lacks: a fuller description, a place when
// it states none, a posting date, pay, the search hit. It is then scored again,
// so a job's verdict always belongs to exactly the fields stored with it. That
// is what lets "rescore" reproduce a scan.

import { roleKey } from './keys.mjs';
import { longTitleKey, companyKey, titleKey } from './text.mjs';

const isFit = (verdict) => verdict.tier === 'strong' || verdict.tier === 'maybe';
const statesPlace = (job) => Boolean(String(job.location || '').trim() || job.countries?.length);

/**
 * What `other` knows about the job that `kept` lacks. Empty when there is nothing to take.
 * @returns {Record<string, any>}
 */
export function gainsFrom(kept, other) {
  const gains = {};
  if ((other.description || '').length > (kept.description || '').length) gains.description = other.description;
  // A place is taken whole from one listing: where, remote or not, and which
  // countries only make sense together. That the job is offered in Czechia
  // (a Czech board, a Czech company) stays true whichever listing said so.
  if (!statesPlace(kept) && statesPlace(other)) {
    Object.assign(gains, {
      location: other.location,
      remote: other.remote,
      countries: other.countries,
      czechSource: Boolean(kept.czechSource || other.czechSource),
    });
  }
  for (const field of ['postedAt', 'salary', 'queryHit']) {
    if (kept[field] == null && other[field] != null) gains[field] = other[field];
  }
  return gains;
}

/**
 * How many of the entries a source found: the ones kept from it and the ones
 * that list it under "also at". Counted from the merged entries, so a scan and
 * a rescore of it report the same number.
 */
export const foundBy = (entries, sourceId) => entries
  .filter((job) => job.source === sourceId || job.alsoAt?.some((other) => other.source === sourceId)).length;

/**
 * Merge the same posting, or the same role, found more than once.
 *
 * @param {object[]} jobs scored jobs that are fits
 * @param {object} options
 * @param {(job: object) => object} options.score the matcher's verdict for a job
 * @param {Record<string, number>} [options.priority] source id -> rank; the listing of the lower rank is kept
 * @returns {object[]} one entry per opening, each with `alsoAt` (its other links)
 */
export function dedupe(jobs, { score, priority = {} }) {
  const sorted = [...jobs].sort((a, b) => (priority[a.source] ?? 99) - (priority[b.source] ?? 99) || b.score - a.score);
  const byKey = new Map();
  const byRole = new Map();
  const byLong = new Map();
  const byTitle = new Map();
  const kept = [];
  const sameTitleSameCompany = (job) => {
    const company = companyKey(job.company);
    if (!company) return null;
    return (byTitle.get(titleKey(job.title)) || []).find((other) => {
      const known = companyKey(other.company);
      return known && (known.startsWith(`${company} `) || company.startsWith(`${known} `));
    }) || null;
  };
  for (const job of sorted) {
    const role = roleKey(job.company, job.title);
    const long = longTitleKey(job.title);
    const existing = byKey.get(job.key) || (role && byRole.get(role)) || (long && byLong.get(long)) || sameTitleSameCompany(job);
    if (existing) {
      if (existing.source !== job.source && !existing.alsoAt.some((a) => a.url === job.url)) {
        existing.alsoAt.push({ source: job.source, url: job.url });
      }
      const gains = gainsFrom(existing, job);
      if (Object.keys(gains).length) {
        const verdict = score({ ...existing, ...gains });
        // The fuller record replaces the entry only while it is still a fit. When it is not,
        // the entry stays exactly as it was, scored on its own fields, so no job is lost by merging.
        if (isFit(verdict)) Object.assign(existing, gains, verdict);
      }
      continue;
    }
    const entry = { ...job, alsoAt: [] };
    kept.push(entry);
    byKey.set(job.key, entry);
    if (role) byRole.set(role, entry);
    if (long) byLong.set(long, entry);
    const tk = titleKey(job.title);
    byTitle.set(tk, [...(byTitle.get(tk) || []), entry]);
  }
  return kept;
}
