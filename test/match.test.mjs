import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { createMatcher, requiredYears, detectLanguage } from '../src/match.mjs';
import { classifyPlace } from '../src/location.mjs';
import { fold, compileTerms, companyKey, titleKey } from '../src/text.mjs';

const profile = parse(readFileSync(new URL('../config/profile.yml', import.meta.url), 'utf8'));
const matcher = createMatcher(profile);
const NOW = Date.parse('2026-11-20T10:00:00Z');
const score = (job) => matcher.score({ postedAt: NOW - 2 * 86_400_000, ...job }, { now: NOW });

const LOREM = ' We are a product team that ships a consumer app used by many people every day. You will own features end to end and work closely with design and product.';

test('terms match whole words, without diacritics, with * for endings', () => {
  const t = compileTerms(['mobiln* aplikac*', 'ai native', 'dart', '.net', 'c++']);
  assert.deepEqual(t.find(fold('Vývojář/ka mobilních aplikací')), ['mobiln* aplikac*']);
  assert.deepEqual(t.find(fold('Product Engineer (AI-Native)')), ['ai native']);
  assert.deepEqual(t.find(fold('Industry standards and standart tools')), []);
  assert.deepEqual(t.find(fold('Backend developer (.NET / C++)')), ['.net', 'c++']);
});

test('company and title keys ignore legal forms and gender markers', () => {
  assert.equal(companyKey('Acme, a.s.'), 'acme');
  assert.equal(companyKey('O2 Czech Republic a.s.'), 'o2');
  assert.equal(companyKey('Skupina E.ON'), 'e on');
  assert.equal(titleKey('Technical Product Manager (f/m)'), titleKey('Technical Product Manager'));
});

test('strong: Flutter roles in Prague', () => {
  const r = score({ title: 'Senior Flutter Developer', location: 'Praha', description: `Flutter, Dart and BLoC. iOS and Android apps.${LOREM}` });
  assert.equal(r.tier, 'strong');
  assert.equal(r.track, 'flutter');
  assert.ok(r.score >= 90, `score ${r.score}`);
});

test('strong: generic mobile title with Flutter in the description', () => {
  const r = score({ title: 'Mobile App Developer', location: 'Prague, Czechia', description: `You will move our iOS app to Flutter and ship to the App Store and Google Play.${LOREM}` });
  assert.equal(r.tier, 'strong');
});

test('strong: agentic titles', () => {
  for (const title of ['Product Engineer (AI Native)', 'AI Builder', 'Fullstack Agentic Engineer']) {
    const r = score({ title, location: 'Praha', description: `You work with Claude Code and Codex in parallel, write AGENTS.md and build MCP servers in TypeScript.${LOREM}` });
    assert.equal(r.tier, 'strong', `${title} -> ${r.score}`);
    assert.equal(r.track, 'agentic');
  }
});

test('product roles count only with a mobile or AI angle', () => {
  const mobile = score({ title: 'Technical Product Owner (Mobile Apps)', location: 'Praha', description: `Own the roadmap of our mobile apps on iOS and Android.${LOREM}` });
  assert.ok(mobile.score >= 60, `mobile PO ${mobile.score}`);
  const plain = score({ title: 'Product Manager', location: 'Praha', description: `Own the roadmap of our billing back office.${LOREM}` });
  assert.ok(plain.score < 45, `plain PM ${plain.score}`);
});

test('description alone can qualify a generic engineering title', () => {
  const r = score({ title: 'Software Engineer', location: 'Remote, Europe', remote: 'remote', description: `Our app is built with Flutter and Dart, with a Firebase backend, for iOS and Android.${LOREM}` });
  assert.ok(r.score >= 45, `score ${r.score}`);
  assert.equal(r.track, 'flutter');
  const none = score({ title: 'Software Engineer', location: 'Praha', description: `Java and Spring Boot services on Kubernetes.${LOREM}` });
  assert.ok(none.score < 45);
});

test('native-only mobile roles are flagged and fall below strong', () => {
  const r = score({ title: 'Senior Android Engineer', location: 'Praha', description: `Kotlin, Jetpack Compose, coroutines and the Android SDK. 5 years of experience with native Android.${LOREM}` });
  assert.notEqual(r.tier, 'strong');
  assert.ok(r.flags.some((f) => f.includes('native')));
});

test('ML-heavy AI roles are flagged and fall below strong', () => {
  const r = score({ title: 'AI Engineer', location: 'Praha', description: `PyTorch, model training, MLOps and computer vision. Python is required. PhD is a plus.${LOREM}` });
  assert.notEqual(r.tier, 'strong');
  assert.ok(r.flags.some((f) => f.startsWith('ML-heavy')));
});

test('wrong professions and levels are dropped by title', () => {
  for (const title of ['Junior Flutter Developer', 'QA Automation Engineer (API & Flutter)', 'Data Engineer / DWH Developer', 'Product Designer, AI-Native Products', 'Flutter Intern']) {
    assert.equal(score({ title, location: 'Praha' }).tier, 'excluded', title);
  }
});

test('place of work', () => {
  assert.equal(classifyPlace({ location: 'Praha – Karlín' }).kind, 'prague');
  assert.equal(classifyPlace({ location: 'Praha + 2 další lokality' }).kind, 'prague');
  assert.equal(classifyPlace({ location: 'Brno' }).fits, false);
  assert.equal(classifyPlace({ location: 'Brno', remote: 'remote' }).kind, 'cz-remote');
  assert.equal(classifyPlace({ location: 'Czechia (Remote)' }).kind, 'cz-remote');
  assert.equal(classifyPlace({ location: 'Remote - EMEA', remote: 'remote' }).kind, 'eu-remote');
  assert.equal(classifyPlace({ location: 'European Union', remote: 'remote' }).kind, 'eu-remote');
  assert.equal(classifyPlace({ location: 'Berlin, Germany' }).fits, false);
  assert.equal(classifyPlace({ location: 'Germany', remote: 'remote' }).kind, 'remote-europe-country');
  assert.equal(classifyPlace({ location: 'United States', remote: 'remote' }).fits, false);
  assert.equal(classifyPlace({ location: 'Remote', remote: 'remote', countries: ['Poland', 'Czechia'] }).kind, 'eu-remote');
  assert.equal(classifyPlace({ location: 'Remote', remote: 'remote', countries: ['Philippines'] }).fits, false);
  assert.equal(classifyPlace({ location: 'Remote', remote: 'remote', description: 'Must be based in the United States.' }).fits, false);
  assert.equal(classifyPlace({ location: '', czechSource: true }).kind, 'cz');
  assert.equal(score({ title: 'Flutter Developer', location: 'Brno' }).tier, 'excluded');
});

test('old postings are dropped, missing dates are not', () => {
  assert.equal(score({ title: 'Flutter Developer', location: 'Praha', postedAt: NOW - 60 * 86_400_000 }).tier, 'excluded');
  assert.notEqual(matcher.score({ title: 'Flutter Developer', location: 'Praha' }, { now: NOW }).tier, 'excluded');
});

test('years and language signals', () => {
  assert.equal(requiredYears(fold('At least 8+ years of professional experience with mobile.')), 8);
  assert.equal(requiredYears(fold('Minimálně 3 roky praxe s vývojem.')), 3);
  assert.equal(requiredYears(fold('We have been on the market for 10 years.')), undefined);
  const german = 'Wir suchen eine erfahrene Person und bieten ein tolles Team mit flachen Hierarchien. Du arbeitest mit uns an der App und bist für die Entwicklung zuständig. Das Team ist verteilt und wir treffen uns regelmäßig bei uns im Büro oder remote. Deine Aufgaben sind vielfältig und der Einstieg ist ab sofort möglich. Wir freuen uns auf deine Bewerbung und das Gespräch mit dir. Die Stelle ist unbefristet und die Bezahlung ist fair sowie transparent für alle im Team.';
  assert.equal(detectLanguage(fold(german)), 'de');
  const r = score({ title: 'Flutter Developer', location: 'Remote, Europe', remote: 'remote', description: `Flutter. ${german}` });
  assert.ok(r.flags.some((f) => f.includes('DE')));
  assert.notEqual(r.tier, 'strong');
});

test('preScore decides whether a job page is worth opening', () => {
  assert.equal(matcher.preScore({ title: 'Senior Flutter Engineer' }).worthDetail, true);
  assert.equal(matcher.preScore({ title: 'Software Engineer' }).worthDetail, false);
  assert.equal(matcher.preScore({ title: 'Software Engineer', queryHit: 'flutter' }).worthDetail, true);
  assert.equal(matcher.preScore({ title: 'Sales Manager', queryHit: 'flutter' }).worthDetail, false);
});
