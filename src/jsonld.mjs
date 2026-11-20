// Reads schema.org JobPosting blocks, which most job pages embed for Google.

import { htmlToText, parseDate, squash } from './text.mjs';

function flatten(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => flatten(n, out));
  else if (node && typeof node === 'object') {
    out.push(node);
    if (node['@graph']) flatten(node['@graph'], out);
  }
  return out;
}

/** Every JSON-LD object on a page (bad blocks are skipped). */
export function extractJsonLd(html) {
  const items = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of String(html || '').matchAll(re)) {
    try {
      flatten(JSON.parse(m[1].trim()), items);
    } catch {
      // Some sites ship invalid JSON-LD; the page text is the fallback.
    }
  }
  return items;
}

const isType = (item, type) => [].concat(item?.['@type'] || []).includes(type);

function placeToText(place) {
  const list = [].concat(place || []);
  const parts = list.map((p) => {
    const a = p?.address || p || {};
    if (typeof a === 'string') return a;
    return [a.addressLocality, a.addressRegion, a.addressCountry?.name || a.addressCountry]
      .filter((x) => typeof x === 'string' && x.trim()).join(', ');
  }).filter(Boolean);
  return [...new Set(parts)].join('; ');
}

function salaryFrom(base) {
  const value = base?.value;
  if (!base || !value) return undefined;
  const min = Number(value.minValue ?? value.value);
  const max = Number(value.maxValue ?? value.value);
  if (!Number.isFinite(min) && !Number.isFinite(max)) return undefined;
  const unit = String(value.unitText || '').toUpperCase();
  const period = unit.startsWith('MONTH') ? 'month' : unit.startsWith('YEAR') ? 'year' : unit.startsWith('HOUR') ? 'hour' : unit.startsWith('DAY') ? 'day' : unit.toLowerCase();
  return {
    min: Number.isFinite(min) ? min : undefined,
    max: Number.isFinite(max) ? max : undefined,
    currency: base.currency || value.currency,
    period,
  };
}

/**
 * The first JobPosting on a page as normalized fields, or null.
 * @returns {null | { title?: string, description: string, postedAt?: number, closesAt?: number, company?: string, location?: string, remote?: 'remote', salary?: object }}
 */
export function jobPostingFromHtml(html) {
  const posting = extractJsonLd(html).find((item) => isType(item, 'JobPosting'));
  if (!posting) return null;
  const remote = String(posting.jobLocationType || '').toUpperCase().includes('TELECOMMUTE') ? 'remote' : undefined;
  const countries = [].concat(posting.applicantLocationRequirements || [])
    .map((r) => r?.name).filter((n) => typeof n === 'string');
  return {
    title: posting.title ? squash(posting.title) : undefined,
    description: htmlToText(posting.description || ''),
    postedAt: parseDate(posting.datePosted),
    closesAt: parseDate(String(posting.validThrough || '').slice(0, 25)),
    company: posting.hiringOrganization?.name ? squash(posting.hiringOrganization.name) : undefined,
    location: placeToText(posting.jobLocation) || undefined,
    remote,
    countries: countries.length ? countries : undefined,
    salary: salaryFrom(posting.baseSalary),
  };
}

/** Main readable text of a page when there is no JobPosting block. */
export function mainText(html, limit = 9000) {
  let s = String(html || '');
  const main = /<main\b[\s\S]*?<\/main>/i.exec(s) || /<article\b[\s\S]*?<\/article>/i.exec(s);
  if (main) s = main[0];
  s = s.replace(/<(header|footer|nav|form|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  return htmlToText(s).slice(0, limit);
}
