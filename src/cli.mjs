// The commands. radar.mjs starts this file once it has checked the setup.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runScan, SOURCES } from './scan.mjs';
import { loadConfig, addCompanies, initHome } from './config.mjs';
import { writeReport, jobLine } from './report.mjs';
import { createMatcher } from './match.mjs';
import { loadState, readStateFile, writeStateFile } from './state.mjs';
import { CODE_DIR, homeDir, outDir } from './paths.mjs';
import { pushToInbox, dataDir, codeDir } from './careerops.mjs';
import { createHttp } from './http.mjs';
import { explore, findBoardFor, toEntry, toYaml } from './discover.mjs';
import { closeBrowser, browserSource } from './browser.mjs';
import { companyKey } from './text.mjs';
import { detectAts } from './ats.mjs';
import { loadAutoCompanies } from './sources/companies.mjs';
import { jobKey } from './keys.mjs';

const HELP = `job-radar

  node radar.mjs scan                 read every source, write the report (out/latest.md in your data folder)
      --sources a,b                   only these sources (see "sources")
      --push                          also send new strong fits to the career-ops inbox
      --verbose                       show progress per source
      --dry                           do not remember the results (next scan shows them again)
      --fresh                         reread job pages instead of using saved copies

  node radar.mjs push                 send new strong fits of the last scan to career-ops
      --min 60                        use another score floor than "strong"
      --dry                           show what would be sent

  node radar.mjs rescore              apply a changed profile to the last scan, without reading any site
  node radar.mjs sources              sources, and how each did in the last scan
  node radar.mjs explain <text>       how jobs matching <text> were scored in the last scan
  node radar.mjs discover "Name" [homepage or careers URL] [--add] [--cz]
                                      work out how a company's jobs can be read, or say why not
  node radar.mjs discover --file companies.txt [--add]
                                      the same for a list: one "Name | URL | cz" per line

  node radar.mjs init                 create your own settings files (existing ones are left alone)
  node radar.mjs doctor               where the code and your data are, and what is set up

Your settings, the reports and what was already reported live in your data
folder: ~/job-radar-data, or the folder JOB_RADAR_HOME names.
`;

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && ['sources', 'min', 'file'].includes(name)) { flags[name] = next; i += 1; } else flags[name] = true;
    } else rest.push(arg);
  }
  return { flags, rest };
}

const readLatest = () => {
  const latestPath = join(outDir(), 'latest.json');
  if (!existsSync(latestPath)) throw new Error('no scan yet: run "node radar.mjs scan" first');
  return JSON.parse(readFileSync(latestPath, 'utf8'));
};

/**
 * Grow the list of company career sites from what the scan found: for each new
 * strong fit from a board or search source, look for that company's own
 * hiring-system board and keep it when the same job is listed there. From then
 * on the whole board is read directly (state/companies-auto.json).
 * Each company is looked up once (state/company-lookups.json).
 */
async function learnCompanies(matches, config) {
  const auto = loadAutoCompanies();
  const tried = readStateFile('company-lookups.json', {});
  const watched = [...(config.companies?.companies || []), ...auto];
  const haveBoard = new Set(watched.map((c) => `${c.ats}:${String(c.slug).toLowerCase()}`));
  const haveName = new Set(watched.map((c) => companyKey(c.name)));
  const today = new Date().toISOString().slice(0, 10);
  const http = createHttp({ defaultIntervalMs: 300, timeoutMs: 12_000 });
  const added = [];

  const candidates = matches.filter((j) => j.isNew && j.tier === 'strong' && j.source !== 'companies' && j.company);
  for (const job of candidates.slice(0, 25)) {
    const name = companyKey(job.company);
    if (!name || haveName.has(name) || tried[name]) continue;
    // A link that already sits on a hiring system names the board directly.
    const direct = [job.url, job.applyUrl, ...(job.alsoAt || []).map((a) => a.url)].map((u) => detectAts(u)).find(Boolean);
    const found = direct ? { name: job.company, ...direct } : await findBoardFor(job, http);
    tried[name] = today;
    if (!found || haveBoard.has(`${found.ats}:${found.slug.toLowerCase()}`)) continue;
    haveBoard.add(`${found.ats}:${found.slug.toLowerCase()}`);
    haveName.add(name);
    const entry = { name: job.company, ats: found.ats, slug: found.slug, addedFrom: job.source, addedAt: today };
    auto.push(entry);
    added.push(entry);
  }
  writeStateFile('company-lookups.json', tried);
  if (added.length) writeStateFile('companies-auto.json', auto);
  return added;
}

async function push(candidates, { dry }) {
  if (!candidates.length) { console.log('Nothing new to send to career-ops.'); return 0; }
  if (dry) {
    console.log(`Would send ${candidates.length} to the career-ops inbox:`);
    candidates.forEach((j) => console.log(`  ${jobLine(j)}`));
    return 0;
  }
  const result = await pushToInbox(candidates);
  const state = loadState();
  const today = new Date().toISOString().slice(0, 10);
  for (const job of candidates) {
    if (result.urls.includes(job.url) && state.jobs[job.key]) state.jobs[job.key].pushedAt = today;
  }
  state.save();
  console.log(`Sent ${result.pushed} of ${candidates.length} to ${join(dataDir(), 'data', 'pipeline.md')}${result.pushed < candidates.length ? ' (the rest were already there)' : ''}.`);
  return result.pushed;
}

async function cmdScan(flags) {
  const only = typeof flags.sources === 'string' ? flags.sources.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const unknown = (only || []).filter((id) => !SOURCES.some((s) => s.id === id));
  if (unknown.length) throw new Error(`unknown source: ${unknown.join(', ')} (known: ${SOURCES.map((s) => s.id).join(', ')})`);

  const scan = await runScan({ only, verbose: Boolean(flags.verbose), dry: Boolean(flags.dry), fresh: Boolean(flags.fresh) });
  const paths = writeReport(scan);
  const learned = flags.dry ? [] : await learnCompanies(scan.matches, loadConfig()).catch(() => []);

  const fresh = scan.matches.filter((j) => j.isNew);
  const strong = fresh.filter((j) => j.tier === 'strong');
  const maybe = fresh.filter((j) => j.tier === 'maybe');
  console.log(`\n${scan.totals.listed.toLocaleString('en')} listings from ${scan.results.length} sources, ${scan.totals.opened} job pages opened.`);
  console.log(`${strong.length} new strong fits, ${maybe.length} new worth a look, ${scan.matches.length - fresh.length} seen before or already in career-ops.\n`);
  for (const job of strong) console.log(jobLine(job));
  if (maybe.length) { console.log('  ---'); maybe.slice(0, 15).forEach((j) => console.log(jobLine(j))); }
  if (maybe.length > 15) console.log(`  ... ${maybe.length - 15} more in the report`);
  const failed = scan.results.filter((r) => r.error);
  for (const r of failed) console.log(`\nSource failed: ${r.label}: ${r.error}`);
  if (learned.length) console.log(`\nNow also watching the career sites of: ${learned.map((c) => c.name).join(', ')}`);
  console.log(`\nReport: ${paths.latest}`);

  if (flags.push) await push(strong.filter((j) => !j.pushed), { dry: false });
  return failed.length === scan.results.length ? 1 : 0;
}

async function cmdPush(flags) {
  const latest = readLatest();
  const min = flags.min ? Number(flags.min) : null;
  const state = loadState();
  const candidates = latest.matches.filter((j) => !j.knownIn
    && !state.jobs[j.key]?.pushedAt
    && (min !== null ? j.score >= min : j.tier === 'strong'));
  await push(candidates, { dry: Boolean(flags.dry) });
}

/** Score the last scan's fits again with the current profile and rewrite the report. Nothing is fetched. */
function cmdRescore() {
  const latest = readLatest();
  const matcher = createMatcher(loadConfig().profile);
  const now = Date.parse(latest.at);
  const rescored = latest.matches.map((job) => ({ ...job, ...matcher.score(job, { now }) }));
  const matches = rescored.filter((j) => j.tier === 'strong' || j.tier === 'maybe')
    .sort((a, b) => b.score - a.score || (b.postedAt || 0) - (a.postedAt || 0));
  const dropped = rescored.length - matches.length;
  const state = loadState();
  for (const job of rescored) {
    if (!state.jobs[job.key]) continue;
    state.jobs[job.key].score = job.score;
    state.jobs[job.key].tier = job.tier;
  }
  state.save();
  const sources = latest.sources.map((src) => ({ ...src, fits: matches.filter((j) => j.source === src.id).length }));
  const totals = {
    ...latest.totals,
    strong: matches.filter((j) => j.tier === 'strong').length,
    maybe: matches.filter((j) => j.tier === 'maybe').length,
    fresh: matches.filter((j) => j.isNew).length,
  };
  const paths = writeReport({ ...latest, today: latest.today || latest.at.slice(0, 10), matches, sources, totals });
  const fresh = matches.filter((j) => j.isNew);
  console.log(`${fresh.filter((j) => j.tier === 'strong').length} new strong fits, ${fresh.filter((j) => j.tier === 'maybe').length} new worth a look${dropped ? `, ${dropped} no longer a fit` : ''}.`);
  console.log('Only jobs that were fits in the last scan are scored again; run a scan to pick up jobs the old profile dropped.');
  console.log(`\nReport: ${paths.latest}`);
}

const companiesLine = (config) => {
  const { builtIn, yours, skipped } = config.companies.counts;
  const found = loadAutoCompanies().length;
  return `${builtIn} built-in, ${yours} of yours${skipped ? `, ${skipped} built-in left out` : ''}${found ? `, ${found} found by the radar` : ''}`;
};

function cmdSources() {
  const config = loadConfig();
  const last = loadState().runs.at(-1);
  console.log(last ? `Last scan: ${last.at}\n` : 'No scan recorded yet.\n');
  for (const source of SOURCES) {
    const on = config.sources.sources?.[source.id]?.enabled !== false;
    const run = last?.sources.find((s) => s.id === source.id);
    const result = !run ? '' : run.error ? `FAILED: ${run.error}` : `${run.listed} listings, ${run.matched} fits, ${run.seconds} s`;
    console.log(`${on ? 'on ' : 'off'}  ${source.id.padEnd(15)} ${source.label.padEnd(24)} ${result}`);
  }
  console.log(`\nCompanies: ${companiesLine(config)}.`);
  console.log('"node radar.mjs doctor" shows where the settings and results are.');
}

/** Where everything is and what is set up. Changes nothing. */
function cmdDoctor() {
  const version = JSON.parse(readFileSync(join(CODE_DIR, 'package.json'), 'utf8')).version;
  const home = homeDir();
  const config = loadConfig();
  const last = loadState().runs.at(-1);
  const on = SOURCES.filter((s) => config.sources.sources?.[s.id]?.enabled !== false).map((s) => s.id);
  const off = SOURCES.filter((s) => !on.includes(s.id)).map((s) => s.id);
  const rendered = config.companies.companies.filter((c) => c.render && c.enabled !== false).length;
  const browser = browserSource();
  const careerOpsData = existsSync(join(dataDir(), 'data'));
  const careerOpsCode = codeDir();

  console.log(`job-radar ${version}\n`);
  console.log(`Code         ${CODE_DIR}`);
  console.log(`Your data    ${home}${process.env.JOB_RADAR_HOME ? '  (from JOB_RADAR_HOME)' : ''}${existsSync(home) ? '' : '  (not created yet)'}`);
  console.log('\nSettings     the built-in files, with yours laid over them');
  for (const [name, file] of Object.entries(config.files)) {
    console.log(`  ${name.padEnd(14)} ${file.hasYours ? `yours: ${file.yours}` : 'built-in only'}`);
  }
  if (Object.values(config.files).some((file) => !file.hasYours)) {
    console.log('  "node radar.mjs init" creates the missing files of your own, with examples.');
  }
  console.log(`  Built-in files are in ${join(CODE_DIR, 'config')} (an update replaces them; change yours instead).`);
  console.log(`\nCompanies    ${companiesLine(config)}`);
  console.log(`Sources on   ${on.join(', ') || 'none'}${off.length ? `\nSources off  ${off.join(', ')}` : ''}`);
  console.log(`Last scan    ${last ? last.at : 'none yet'}`);
  console.log(`Report       ${join(outDir(), 'latest.md')}${existsSync(join(outDir(), 'latest.md')) ? '' : '  (written by the first scan)'}`);
  console.log(`\nBrowser      ${browser === 'here' ? 'Playwright is installed here'
    : browser === 'career-ops' ? 'Playwright borrowed from career-ops'
      : `not available: the ${rendered} companies marked "render: true" are skipped. To add it, in the code folder: npm i playwright && npx playwright install chromium`}`);
  console.log(`career-ops   ${careerOpsData ? `data found in ${dataDir()}` : 'no data folder found'}; ${careerOpsCode ? 'code found' : 'code not found'}${careerOpsData && careerOpsCode ? '' : '  (optional: only "push" and the "already in career-ops" check use it)'}`);
}

function cmdInit() {
  for (const { path, created } of initHome()) console.log(`${created ? 'Created      ' : 'Already there'} ${path}`);
  console.log('\nEach file holds only what you want different from the built-in settings; the examples inside are commented out.');
}

function cmdExplain(rest) {
  const needle = rest.join(' ').toLowerCase();
  if (!needle) throw new Error('give part of a title, company or URL');
  const latest = readLatest();
  const key = /^https?:/.test(needle) ? jobKey(needle) : null;
  const hits = latest.matches.filter((j) => (key ? j.key === key : `${j.title} ${j.company} ${j.url}`.toLowerCase().includes(needle)));
  if (!hits.length) { console.log('No fit in the last scan matches that. Jobs that were dropped are not kept.'); return; }
  for (const job of hits.slice(0, 10)) {
    console.log(`\n${job.score} (${job.tier}) · ${job.title} — ${job.company}\n${job.url}`);
    console.log(`track: ${job.trackLabel}\nplace: ${job.place?.label} → ${job.place?.note}`);
    console.log(`why:   ${job.reasons.join('; ')}`);
    if (job.flags.length) console.log(`check: ${job.flags.join('; ')}`);
    if (job.knownIn) console.log(`known: ${job.knownIn}`);
  }
}

/** Explore one company and print what was found, or why nothing was. Returns its entry when readable. */
async function discoverOne({ name, url, cz }, http) {
  const result = await explore({ name, url }, http);
  console.log(`\n${name}`);
  for (const step of result.steps) console.log(`  ${step}`);
  if (!result.found) {
    console.log(`  Cannot be read: ${result.reason}.`);
    return null;
  }
  const { found } = result;
  const extra = { country: cz && !found.country ? 'cz' : '' };
  const yaml = toYaml(found, extra);
  console.log(`  Readable: ${found.jobs ? `${found.jobs} open jobs` : 'no openings right now'}${found.sample?.length ? ` (${found.sample.join(' · ').slice(0, 140)})` : ''}`);
  if (found.unverified) {
    console.log(`  Not added: matched by name only. Check it is the right company, then add by hand:\n${yaml}`);
    return null;
  }
  return { yaml, entry: toEntry(found, extra) };
}

async function cmdDiscover(rest, flags) {
  const targets = [];
  if (typeof flags.file === 'string') {
    for (const line of readFileSync(flags.file, 'utf8').split('\n')) {
      const [name, url, country] = line.split('|').map((part) => part.trim());
      if (name && !name.startsWith('#')) targets.push({ name, url: url || undefined, cz: country === 'cz' || Boolean(flags.cz) });
    }
  } else {
    const [name, url] = rest;
    if (!name) throw new Error('usage: node radar.mjs discover "Company name" [homepage or careers URL] [--add] [--cz]\n       node radar.mjs discover --file companies.txt [--add]');
    targets.push({ name, url, cz: Boolean(flags.cz) });
  }

  const config = loadConfig();
  const known = new Set((config.companies?.companies || []).map((c) => String(c.name).toLowerCase()));
  const http = createHttp({ defaultIntervalMs: 400, timeoutMs: 20_000 });
  const entries = [];
  let failed = 0;
  let next = 0;
  // A few companies at a time; pages that need the browser still load one by one.
  const worker = async () => {
    while (next < targets.length) {
      const target = targets[next];
      next += 1;
      try {
        const found = await discoverOne(target, http);
        if (found) entries.push({ name: target.name, ...found }); else failed += 1;
      } catch (err) {
        failed += 1;
        console.log(`\n${target.name}\n  Failed: ${err.message}`);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker));
  } finally {
    await closeBrowser();
  }

  if (!entries.length) {
    if (targets.length === 1 && !targets[0].url) console.log('\nPass the company\'s homepage or careers page as the second argument.');
    return 1;
  }
  const fresh = entries.filter((e) => !known.has(e.name.toLowerCase()));
  if (flags.add) {
    const file = fresh.length ? addCompanies(fresh.map((e) => e.entry)) : config.files['companies.yml'].yours;
    console.log(`\nAdded ${fresh.length} to ${file}${entries.length > fresh.length ? ` (${entries.length - fresh.length} were already watched)` : ''}${failed ? `; ${failed} could not be read` : ''}.`);
  } else {
    console.log(`\nFor your companies.yml (add --add to write them there):\n\n${entries.map((e) => e.yaml).join('\n')}`);
    if (failed && targets.length > 1) console.log(`\n${failed} of ${targets.length} could not be read.`);
  }
  return 0;
}

const { flags, rest } = parseArgs(process.argv.slice(3));
const command = process.argv[2];
try {
  let code = 0;
  if (command === 'scan') code = await cmdScan(flags);
  else if (command === 'push') await cmdPush(flags);
  else if (command === 'sources') cmdSources();
  else if (command === 'rescore') cmdRescore();
  else if (command === 'explain') cmdExplain(rest);
  else if (command === 'discover') code = await cmdDiscover(rest, flags);
  else if (command === 'init') cmdInit();
  else if (command === 'doctor') cmdDoctor();
  else { console.log(HELP); code = command && command !== 'help' && command !== '--help' ? 1 : 0; }
  process.exitCode = code || 0;
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
}
