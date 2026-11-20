import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { overlay, mergeCompanies, loadConfig, addCompanies, initHome, FILES } from '../src/config.mjs';
import { homeDir, CODE_DIR } from '../src/paths.mjs';

const emptyHome = () => mkdtempSync(join(tmpdir(), 'job-radar-test-'));
const homeWith = (files) => {
  const home = emptyHome();
  mkdirSync(join(home, 'config'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(home, 'config', name), text);
  return home;
};

test('your settings are laid over the built-in ones: maps merge, other values replace', () => {
  const base = { thresholds: { strong: 65, maybe: 50 }, max_age_days: 45, exclude_title: ['junior', 'intern'] };
  const merged = overlay(base, { thresholds: { strong: 70 }, max_age_days: 30, exclude_title: ['qa'] });
  assert.deepEqual(merged, { thresholds: { strong: 70, maybe: 50 }, max_age_days: 30, exclude_title: ['qa'] });
  assert.deepEqual(base.thresholds, { strong: 65, maybe: 50 }, 'the built-in values are not changed in place');
  assert.deepEqual(overlay(base, undefined), base);
  assert.deepEqual(overlay(base, {}), base);
});

test('name+ adds to a list and name- takes out of it', () => {
  const base = { exclude_title: ['junior', 'Designer', 'qa'], tracks: { flutter: { title: [{ score: 62, terms: ['flutter'] }] } } };
  const merged = overlay(base, {
    'exclude_title+': ['wordpress', 'JUNIOR'],
    'exclude_title-': ['designer'],
    tracks: { flutter: { 'title+': [{ score: 40, terms: ['kotlin multiplatform'] }] } },
  });
  assert.deepEqual(merged.exclude_title, ['junior', 'qa', 'wordpress'], 'no duplicate, and names are compared without case');
  assert.equal(merged.tracks.flutter.title.length, 2);
  assert.equal('exclude_title+' in merged, false);
  // A single value is taken as a list of one; a list that does not exist yet is started.
  assert.deepEqual(overlay({}, { 'exclude_title+': 'sap' }).exclude_title, ['sap']);
  assert.deepEqual(overlay({ a: 1 }, { extra: { 'words+': ['x'] } }).extra, { words: ['x'] });
  // A full replacement and an addition in one file: the addition lands on the replacement.
  assert.deepEqual(overlay(base, { exclude_title: ['a'], 'exclude_title+': ['b'] }).exclude_title, ['a', 'b']);
  assert.throws(() => overlay({ thresholds: { strong: 65 } }, { 'thresholds+': [1] }), /"thresholds" is not a list/);
});

test('your companies add to the built-in list, replace by name, or leave one out', () => {
  const base = { companies: [{ name: 'Acme', ats: 'ashby', slug: 'acme' }, { name: 'Beta', url: 'https://beta.example/jobs' }, { name: 'Gamma', ats: 'lever', slug: 'gamma' }] };
  const own = { companies: [{ name: 'acme', ats: 'greenhouse', slug: 'acme-inc' }, { name: 'Delta', url: 'https://delta.example/careers' }], skip: ['GAMMA'] };
  const merged = mergeCompanies(base, own);
  assert.deepEqual(merged.companies.map((c) => `${c.name}:${c.ats || 'page'}`), ['Beta:page', 'acme:greenhouse', 'Delta:page']);
  assert.deepEqual(merged.counts, { builtIn: 1, yours: 2, skipped: 2 });
  assert.deepEqual(mergeCompanies(base, undefined).counts, { builtIn: 3, yours: 0, skipped: 0 });
  assert.deepEqual(mergeCompanies(base, {}).companies, base.companies);
});

test('without settings of your own the built-in ones are used as they are', () => {
  const config = loadConfig({ home: emptyHome() });
  assert.ok(config.profile.thresholds.strong > config.profile.thresholds.maybe);
  assert.ok(config.companies.companies.length > 50);
  assert.equal(config.companies.counts.yours, 0);
  assert.ok(Object.values(config.files).every((file) => !file.hasYours));
});

test('the built-in settings hold nothing personal and leave LinkedIn off', () => {
  const config = loadConfig({ home: emptyHome() });
  assert.equal(config.profile.experience_years, undefined, 'years of experience belong in your own profile.yml');
  assert.equal(config.profile.salary, undefined, 'a pay target belongs in your own profile.yml');
  assert.equal(config.sources.sources.linkedin.enabled, false);
});

test('a small file of your own changes only what it names', () => {
  const home = homeWith({
    'profile.yml': 'experience_years: 7\nsalary: { currency: EUR, target_monthly_min: 5000 }\nthresholds: { strong: 70 }\nexclude_title+: [wordpress]\n',
    'sources.yml': 'sources:\n  linkedin:\n    enabled: true\n  remotive:\n    enabled: false\n',
    'companies.yml': 'companies:\n  - { name: "Acme Test Co", url: "https://acme.example/careers" }\nskip: ["Canonical"]\n',
  });
  const builtIn = loadConfig({ home: emptyHome() });
  const config = loadConfig({ home });
  assert.equal(config.profile.experience_years, 7);
  assert.equal(config.profile.salary.target_monthly_min, 5000);
  assert.deepEqual(config.profile.thresholds, { ...builtIn.profile.thresholds, strong: 70 });
  assert.equal(config.profile.exclude_title.length, builtIn.profile.exclude_title.length + 1);
  assert.deepEqual(config.profile.tracks, builtIn.profile.tracks);
  assert.equal(config.sources.sources.linkedin.enabled, true);
  assert.deepEqual(config.sources.sources.linkedin.searches, builtIn.sources.sources.linkedin.searches, 'turning a source on keeps its searches');
  assert.equal(config.sources.sources.remotive.enabled, false);
  assert.deepEqual(config.sources.pacing, builtIn.sources.pacing);
  assert.equal(config.companies.companies.length, builtIn.companies.companies.length);
  assert.ok(config.companies.companies.some((c) => c.name === 'Acme Test Co'));
  assert.ok(!config.companies.companies.some((c) => c.name === 'Canonical'));
  assert.ok(Object.values(config.files).every((file) => file.hasYours));
});

test('a mistake in your file is reported with the file name', () => {
  const home = homeWith({ 'profile.yml': 'thresholds: { strong: 70\nmaybe: [' });
  assert.throws(() => loadConfig({ home }), (err) => err.message.includes(join(home, 'config', 'profile.yml')));
  const wrongKind = homeWith({ 'profile.yml': 'thresholds+: [1]\n' });
  assert.throws(() => loadConfig({ home: wrongKind }), /profile\.yml: "thresholds\+" changes a list/);
});

test('init creates your files once, and the untouched templates change nothing', () => {
  const home = emptyHome();
  assert.deepEqual(initHome({ home }).map((f) => f.created), [true, true, true]);
  assert.deepEqual(loadConfig({ home }).profile, loadConfig({ home: emptyHome() }).profile);
  assert.deepEqual(loadConfig({ home }).sources, loadConfig({ home: emptyHome() }).sources);
  writeFileSync(join(home, 'config', 'profile.yml'), 'experience_years: 3\n');
  assert.deepEqual(initHome({ home }).map((f) => f.created), [false, false, false]);
  assert.equal(readFileSync(join(home, 'config', 'profile.yml'), 'utf8'), 'experience_years: 3\n', 'an existing file is left alone');
  assert.deepEqual(FILES, ['profile.yml', 'sources.yml', 'companies.yml']);
});

test('a found company is written to your companies.yml, which keeps what was there', () => {
  const home = emptyHome();
  const path = addCompanies([{ name: 'Acme Test Co', ats: 'ashby', slug: 'acme-test', country: 'cz' }], { home });
  assert.equal(path, join(home, 'config', 'companies.yml'));
  let text = readFileSync(path, 'utf8');
  assert.match(text, /^# Your companies/, 'a new file starts from the template');
  assert.match(text, /- \{ name: "Acme Test Co", ats: ashby, slug: "acme-test", country: cz \}/);

  writeFileSync(path, `${text}\nskip: ["Canonical"]   # not for me\n`);
  addCompanies([{ name: 'Beta Test Co', url: 'https://beta.example/careers', render: true, country: '' }], { home });
  text = readFileSync(path, 'utf8');
  assert.match(text, /- \{ name: "Beta Test Co", url: "https:\/\/beta\.example\/careers", render: true \}/);
  assert.match(text, /# not for me/);
  const config = loadConfig({ home });
  assert.deepEqual(config.companies.companies.slice(-2).map((c) => c.name), ['Acme Test Co', 'Beta Test Co']);
  assert.ok(!config.companies.companies.some((c) => c.name === 'Canonical'), 'the skip list written after the companies still works');
});

test('your data folder: ~/job-radar-data, or wherever JOB_RADAR_HOME points', () => {
  assert.equal(homeDir({}), join(homedir(), 'job-radar-data'));
  assert.equal(homeDir({ JOB_RADAR_HOME: '/tmp/radar-home' }), '/tmp/radar-home');
  assert.equal(homeDir({ JOB_RADAR_HOME: '~/somewhere/radar' }), join(homedir(), 'somewhere', 'radar'));
  assert.throws(() => homeDir({ JOB_RADAR_HOME: CODE_DIR }), /code folder/);
});
