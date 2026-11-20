// Turns a scan into the report people read (Markdown) and the data file the
// `push` and `explain` commands use (JSON).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isoDate } from './text.mjs';
import { outDir } from './paths.mjs';
import { SOURCES } from './scan.mjs';

const label = (id) => SOURCES.find((s) => s.id === id)?.label || id;
const clip = (text, max = 70) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const placeOf = (job) => clip(job.place?.label || job.location || 'place not stated');

function pay(salary) {
  if (!salary || (!salary.min && !salary.max)) return '';
  const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const range = salary.min && salary.max && salary.min !== salary.max ? `${k(salary.min)}–${k(salary.max)}` : k(salary.max || salary.min);
  return `${salary.currency || ''} ${range}${salary.period ? ` / ${salary.period}` : ''}`.trim();
}

export function jobLine(job) {
  return `${String(job.score).padStart(3)}  ${clip(job.title, 80)} — ${job.company || 'company not stated'} (${placeOf(job)})`;
}

function jobBlock(job) {
  const facts = [
    placeOf(job),
    job.postedAt ? `posted ${isoDate(job.postedAt)}` : 'date not stated',
    pay(job.salary),
    `via ${label(job.source)}${job.company && job.source === 'companies' ? '' : ''}`,
  ].filter(Boolean);
  const lines = [
    `### ${job.score} · ${job.title} — ${job.company || 'company not stated'}`,
    '',
    `${job.trackLabel} · ${facts.join(' · ')}`,
    '',
    `<${job.url}>`,
  ];
  if (job.alsoAt?.length) lines.push('', `Also at: ${job.alsoAt.map((a) => `[${label(a.source)}](${a.url})`).join(', ')}`);
  lines.push('', `Why: ${job.reasons.join('; ')}`);
  if (job.flags?.length) lines.push('', `Check: ${job.flags.join('; ')}`);
  return lines.join('\n');
}

const compact = (job) => `- ${job.score} · [${job.title} — ${job.company || '?'}](${job.url}) · ${placeOf(job)}${job.knownIn ? ` · ${job.knownIn}` : ''}`;

export function buildMarkdown(scan) {
  const { matches, sources, totals, today } = scan;
  const fresh = matches.filter((j) => j.isNew);
  const strong = fresh.filter((j) => j.tier === 'strong');
  const maybe = fresh.filter((j) => j.tier === 'maybe');
  const seenBefore = matches.filter((j) => !j.isNew && !j.knownIn);
  const inCareerOps = matches.filter((j) => j.knownIn);

  const out = [
    `# Job radar — ${today}`,
    '',
    `${totals.listed.toLocaleString('en')} listings read from ${sources.filter((r) => !r.error).length} sources.`,
    `**${strong.length} new strong fits**, ${maybe.length} new worth a look, ${seenBefore.length} shown in an earlier report, ${inCareerOps.length} already in career-ops.`,
    '',
  ];

  out.push(`## New: strong fit (${strong.length})`, '');
  out.push(strong.length ? strong.map(jobBlock).join('\n\n') : '_Nothing new above the strong threshold._', '');
  out.push(`## New: worth a look (${maybe.length})`, '');
  out.push(maybe.length ? maybe.map(jobBlock).join('\n\n') : '_Nothing new in this band._', '');

  if (seenBefore.length) {
    out.push(`## Still open, shown before (${seenBefore.length})`, '', ...seenBefore.map(compact), '');
  }
  if (inCareerOps.length) {
    out.push(`## Already in career-ops (${inCareerOps.length})`, '', ...inCareerOps.map(compact), '');
  }

  out.push('## Sources', '', '| Source | Listings | Pages opened | Fits | Notes |', '|---|---:|---:|---:|---|');
  for (const r of sources) {
    const note = r.error ? `FAILED: ${r.error}` : (r.notes || []).slice(-2).join(' / ');
    out.push(`| ${r.label} | ${r.listed} | ${r.opened} | ${r.fits} | ${note.replace(/\|/g, '/')} |`);
  }
  out.push('');

  const dropped = Object.entries(scan.excludedCounts || {}).sort((a, b) => b[1] - a[1]);
  if (dropped.length) out.push(`Not shown: ${dropped.map(([reason, n]) => `${n.toLocaleString('en')} ${reason}`).join(', ')}.`, '');
  return out.join('\n');
}

export function writeReport(scan) {
  const OUT_DIR = outDir();
  mkdirSync(OUT_DIR, { recursive: true });
  const markdown = buildMarkdown(scan);
  const dated = join(OUT_DIR, `radar-${scan.today}.md`);
  writeFileSync(dated, markdown);
  writeFileSync(join(OUT_DIR, 'latest.md'), markdown);
  const data = {
    at: scan.at,
    today: scan.today,
    totals: scan.totals,
    sources: scan.sources,
    excludedCounts: scan.excludedCounts,
    // Every field a verdict was computed from is kept whole (descriptions too), so `rescore`
    // can apply a changed profile without reading any site, and gives the scan's own result
    // when the profile is unchanged.
    matches: scan.matches,
  };
  writeFileSync(join(OUT_DIR, 'latest.json'), JSON.stringify(data, null, 1));
  return { dated, latest: join(OUT_DIR, 'latest.md'), json: join(OUT_DIR, 'latest.json') };
}
