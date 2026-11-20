import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dedupe, gainsFrom, foundBy } from '../src/dedupe.mjs';
import { createMatcher } from '../src/match.mjs';
import { jobKey } from '../src/keys.mjs';
import { writeReport } from '../src/report.mjs';

// A small profile of the test's own, so tuning the built-in one does not move these numbers.
const profile = {
  thresholds: { strong: 65, maybe: 50, detail: 22 },
  max_age_days: 45,
  exclude_title: ['junior'],
  tracks: {
    flutter: {
      label: 'Flutter / mobile',
      body_cap: 30,
      title: [{ score: 60, terms: ['flutter'] }, { score: 46, terms: ['mobile developer'] }],
      body: [{ score: 20, terms: ['flutter'] }, { score: 6, terms: ['dart'] }],
    },
  },
  adjustments: {
    place: { prague: 10, 'cz-remote': 10, cz: 6, 'eu-remote': 8, 'remote-unknown': 3, unknown: 0 },
    freshness: [{ within: 7, score: 4 }, { older_than: 30, score: -4 }],
    no_text_support: -15,
  },
  experience_years: 5,
  salary: { currency: 'CZK', target_monthly_min: 100000 },
};
const matcher = createMatcher(profile);
const NOW = Date.parse('2026-11-20T10:00:00.123Z');
const DAY = 86_400_000;
const score = (job) => matcher.score(job, { now: NOW });
const PRIORITY = { companies: 0, startupjobs: 1, hackernews: 2, linkedin: 3 };
const merge = (jobs) => dedupe(jobs, { score, priority: PRIORITY });

const FILLER = ' We are a product team and ship an app that many people use every day. You own features from the first idea to the release and work closely with design.';
const FLUTTER_AD = `The app is built with Flutter and Dart for iOS and Android.${FILLER}${FILLER}`;
const PLAIN_AD = `You join the team that builds our app and looks after its releases.${FILLER}${FILLER}`;

/** A listing as a source hands it over, with its verdict, the way the scan passes it to dedupe. */
const listing = (source, fields) => {
  const job = { source, key: jobKey(fields.url), live: source === 'companies' || source === 'startupjobs', ...fields };
  return { ...job, ...score(job) };
};
const VERDICT = ['score', 'tier', 'track', 'trackLabel', 'reasons', 'flags', 'place'];
const verdictOf = (job) => Object.fromEntries(VERDICT.map((field) => [field, job[field]]));
/** The rule this file is about: scoring what is stored gives the verdict that is stored. */
const assertReproducible = (job) => {
  const stored = JSON.parse(JSON.stringify(job));
  assert.deepEqual(verdictOf({ ...stored, ...score(stored) }), verdictOf(stored), `${job.title} (${job.url})`);
};

const ownSite = (fields = {}) => listing('companies', {
  title: 'Mobile Developer', company: 'Acme', url: 'https://acme.example/careers/mobile-developer', czechSource: true, ...fields,
});
const onBoard = (fields = {}) => listing('startupjobs', {
  title: 'Mobile Developer', company: 'Acme s.r.o.', url: 'https://www.startupjobs.cz/nabidka/100001/mobile-developer',
  location: 'Praha', czechSource: true, description: FLUTTER_AD, postedAt: NOW - 2 * DAY,
  salary: { min: 110000, max: 140000, currency: 'CZK', period: 'month' }, ...fields,
});

test('what one listing knows and the other lacks', () => {
  const bare = { title: 'Mobile Developer', description: '' };
  const full = { title: 'Mobile Developer', description: FLUTTER_AD, location: 'Praha', remote: 'hybrid', czechSource: true, postedAt: 5, salary: { min: 1 }, queryHit: 'flutter' };
  assert.deepEqual(gainsFrom(bare, full), {
    description: FLUTTER_AD, location: 'Praha', remote: 'hybrid', countries: undefined, czechSource: true, postedAt: 5, salary: { min: 1 }, queryHit: 'flutter',
  });
  assert.deepEqual(gainsFrom(full, bare), {});
  assert.deepEqual(gainsFrom(full, { ...full, description: 'short', postedAt: 9, salary: { min: 2 }, location: 'Brno' }), {}, 'nothing it already has is replaced');
  assert.deepEqual(gainsFrom({ ...full, description: 'short' }, full), { description: FLUTTER_AD }, 'the fuller text is taken');
  assert.deepEqual(gainsFrom({ ...bare, remote: 'remote' }, { location: '', remote: 'onsite' }), {}, 'a listing that states no place has none to give');
  // A Czech company's own listing without a place, and a remote board that says only "Remote".
  const fromBoard = gainsFrom({ ...bare, czechSource: true }, { location: 'Remote', remote: 'remote' });
  assert.equal(fromBoard.czechSource, true, 'that the job is offered in Czechia is not lost with the place');
  assert.equal(gainsFrom(bare, { location: 'Remote', remote: 'remote' }).czechSource, false);
});

test('the company listing takes text, place, date and pay from the board listing and is scored again', () => {
  const site = ownSite();
  const board = onBoard();
  assert.equal(site.tier, 'maybe', 'on its own the site listing is scored on its title');
  assert.ok(site.flags.includes('description not read'));

  const [job, ...rest] = merge([board, site]);
  assert.equal(rest.length, 0);
  assert.equal(job.url, site.url, 'the link of the earlier source is kept');
  assert.equal(job.company, 'Acme');
  assert.deepEqual(job.alsoAt, [{ source: 'startupjobs', url: board.url }]);
  assert.equal(job.description, FLUTTER_AD);
  assert.equal(job.location, 'Praha');
  assert.equal(job.postedAt, board.postedAt);
  assert.deepEqual(job.salary, board.salary);
  assert.equal(job.place.kind, 'prague');
  assert.equal(job.tier, 'strong');
  assert.ok(!job.flags.includes('description not read'));
  assert.ok(job.reasons.some((reason) => reason.startsWith('posted')), 'the date it took counts in its score');
  assertReproducible(job);
});

test('a listing with its own text and place keeps them and takes only what it lacks', () => {
  const site = ownSite({ description: `${FLUTTER_AD}${FILLER}`, location: 'Praha – Karlín' });
  const board = onBoard({ location: 'Remote, Europe', remote: 'remote' });
  const [job] = merge([site, board]);
  assert.equal(job.description, `${FLUTTER_AD}${FILLER}`);
  assert.equal(job.location, 'Praha – Karlín');
  assert.equal(job.place.kind, 'prague');
  assert.equal(job.postedAt, board.postedAt);
  assert.equal(job.score, site.score + 4 + 2, 'four points for the date and two for the pay it took');
  assertReproducible(job);
});

test('a place is taken whole from one listing', () => {
  // The site says only "on site"; the board says it is a remote job run from Brno.
  const site = ownSite({ remote: 'onsite', description: FLUTTER_AD });
  const board = onBoard({ location: 'Brno', remote: 'remote', description: 'Flutter.' });
  const [job] = merge([site, board]);
  assert.equal(job.location, 'Brno');
  assert.equal(job.remote, 'remote', 'not "Brno" from one listing with "on site" from the other');
  assert.equal(job.place.kind, 'cz-remote');
  assertReproducible(job);
});

test('when the fuller record would no longer be a fit, the entry stays as it was', () => {
  const site = ownSite();
  // Same page under a tracking link, with a stronger title and a text that names none of the topics.
  const post = listing('hackernews', {
    title: 'Flutter Mobile Developer', company: 'Acme', url: `${site.url}?utm_source=hn`, location: 'Praha', description: PLAIN_AD,
  });
  assert.equal(post.key, site.key);
  assert.equal(post.tier, 'maybe', 'the post is a fit thanks to its own title');
  assert.equal(score({ ...site, ...gainsFrom(site, post) }).tier, 'low', 'the site title with the post text is not');

  const [job, ...rest] = merge([post, site]);
  assert.equal(rest.length, 0, 'the job is still listed once');
  assert.deepEqual(verdictOf(job), verdictOf(site));
  assert.equal(job.description, undefined);
  assert.equal(job.location, undefined);
  assert.deepEqual(job.alsoAt, [{ source: 'hackernews', url: post.url }]);
  assertReproducible(job);
});

test('a rescore with an unchanged profile gives the scan\'s own verdicts', () => {
  // The topic word sits past the first 12,000 characters: the stored text must not be cut short.
  const longAd = `${PLAIN_AD}${FILLER.repeat(90)} We write the app in Flutter.`;
  assert.ok(longAd.indexOf('Flutter') > 12_000);
  const jobs = [
    ownSite(),
    onBoard(),
    listing('linkedin', { title: 'Mobile Developer', company: 'Acme', url: 'https://www.linkedin.com/jobs/view/4000000001/', location: 'Prague, Czechia', postedAt: NOW - 40 * DAY }),
    listing('companies', { title: 'Senior Flutter Developer', company: 'Beta Labs', url: 'https://beta.example/jobs/flutter', location: 'Praha', description: FLUTTER_AD }),
    listing('linkedin', { title: 'Senior Flutter Developer', company: 'Beta Labs', url: 'https://www.linkedin.com/jobs/view/4000000002/', location: 'Prague, Czechia', postedAt: NOW - 3 * DAY, description: `${FLUTTER_AD}${FILLER}` }),
    listing('startupjobs', { title: 'Mobile Developer', company: 'Gamma', url: 'https://www.startupjobs.cz/nabidka/100002/mobile-developer', location: 'Praha', czechSource: true, description: longAd }),
    listing('hackernews', { title: 'Flutter Developer', company: 'Delta', url: 'https://delta.example/jobs/1', location: 'Remote (Europe)', remote: 'remote', queryHit: 'flutter' }),
  ];
  assert.ok(jobs.every((job) => job.tier === 'strong' || job.tier === 'maybe'), 'every listing is a fit before merging');
  const matches = merge(jobs);
  assert.deepEqual(matches.map((job) => `${job.company}: ${job.alsoAt.length}`).sort(), ['Acme: 2', 'Beta Labs: 1', 'Delta: 0', 'Gamma: 0']);
  matches.forEach(assertReproducible);
  // A job found by two sources counts for both, and the count needs nothing but the merged entries.
  assert.deepEqual(['companies', 'startupjobs', 'linkedin', 'hackernews', 'cocuma'].map((id) => foundBy(matches, id)), [2, 2, 2, 1, 0]);

  // Through the report's data file, which is what the rescore command reads.
  const homeBefore = process.env.JOB_RADAR_HOME;
  process.env.JOB_RADAR_HOME = mkdtempSync(join(tmpdir(), 'job-radar-test-'));
  const at = new Date(NOW).toISOString();
  let paths;
  try {
    paths = writeReport({ at, today: at.slice(0, 10), matches, sources: [], totals: { listed: jobs.length }, excludedCounts: {} });
  } finally {
    if (homeBefore === undefined) delete process.env.JOB_RADAR_HOME; else process.env.JOB_RADAR_HOME = homeBefore;
  }
  const latest = JSON.parse(readFileSync(paths.json, 'utf8'));
  assert.equal(latest.matches.find((job) => job.company === 'Gamma').description, longAd, 'the text is stored whole');
  for (const stored of latest.matches) {
    assert.deepEqual(verdictOf({ ...stored, ...matcher.score(stored, { now: Date.parse(latest.at) }) }), verdictOf(stored), stored.title);
  }
});
