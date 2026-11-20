import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSearchPage, parsePostedAt } from '../src/sources/jobscz.mjs';
import { parseListing } from '../src/sources/cocuma.mjs';
import { parseCards } from '../src/sources/linkedin.mjs';
import { mapOffer } from '../src/sources/startupjobs.mjs';
import { mapComment } from '../src/sources/hackernews.mjs';
import { parseFeed } from '../src/sources/weworkremotely.mjs';
import { extractJobLinks } from '../src/sources/companies.mjs';
import { detectAts } from '../src/ats.mjs';
import { jobPostingFromHtml } from '../src/jsonld.mjs';
import { jobKey, roleKey } from '../src/keys.mjs';
import { similarTitles, longTitleKey } from '../src/text.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-20T10:00:00Z');

test('jobs.cz: a page that states its result count as a word still parses', () => {
  const jobs = parseSearchPage(fixture('jobscz-search.html'), NOW);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Mobile & Web Developer');
  assert.equal(jobs[0].url, 'https://www.jobs.cz/rpd/2000000001/');
  assert.equal(jobs[0].company, 'Example Apps s.r.o.');
  assert.equal(jobs[0].location, 'Brno – střed');
  assert.equal(new Date(jobs[0].postedAt).getMonth(), 10); // "16. listopadu"
});

test('jobs.cz: posting dates', () => {
  assert.equal(parsePostedAt('Přidáno dnes', NOW), NOW);
  assert.equal(parsePostedAt('Přidáno včera', NOW), NOW - 86_400_000);
  assert.equal(new Date(parsePostedAt('4. prosince', NOW)).getFullYear(), 2025); // a future day means last year
  assert.equal(parsePostedAt('Končí za 2 dny', NOW), undefined);
});

test('cocuma: listing cards', () => {
  const jobs = parseListing(fixture('cocuma-listing.html'));
  assert.equal(jobs.length, 2);
  for (const job of jobs) assert.match(job.url, /^https:\/\/www\.cocuma\.cz\/job\/[^/]+\/\d+\/$/);
  assert.deepEqual(jobs.map((j) => [j.title, j.company, j.location]), [
    ['Senior Flutter Developer', 'Example Studio', 'Praha'],
    ['Product Manager', 'Sample Foods', 'Brno'],
  ]);
});

test('linkedin: signed-out search cards', () => {
  const jobs = parseCards(fixture('linkedin-search.html'));
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].url, 'https://www.linkedin.com/jobs/view/4000000001/');
  assert.deepEqual([jobs[0].title, jobs[0].company, jobs[0].location], ['Mobile App Developer', 'Example Apps', 'Prague, Prague, Czechia']);
  assert.equal(new Date(jobs[0].postedAt).toISOString().slice(0, 10), '2026-10-26');
});

test('startupjobs: offer mapping', () => {
  const job = mapOffer(JSON.parse(fixture('startupjobs-offer.json')));
  assert.match(job.url, /^https:\/\/www\.startupjobs\.cz\/nabidka\/100001\/[a-z0-9-]+$/);
  assert.equal(job.remote, 'remote');
  assert.equal(job.czechSource, true);
  assert.equal(job.company, 'Example Labs, s.r.o.');
  assert.equal(job.location, 'Praha, Česko');
  assert.deepEqual(job.salary, { min: 90000, max: 130000, currency: 'CZK', period: 'month' }, 'amounts are converted from hundredths');
});

test('hacker news: only conventional posts become jobs', () => {
  const post = mapComment({ objectID: '1', created_at_i: 1, comment_text: 'Acme (YC W24) | Senior Product Engineer | REMOTE (Europe) | Full-time<p>We build things.' });
  assert.equal(post.company, 'Acme');
  assert.equal(post.title, 'Senior Product Engineer');
  assert.equal(post.remote, 'remote');
  assert.match(post.location, /Europe/);
  assert.equal(mapComment({ objectID: '2', comment_text: "I'm a full-stack engineer looking for work." }), null);
});

test('we work remotely: feed items', () => {
  const xml = '<rss><channel><item><title>Acme: Senior Flutter Engineer</title><region>Europe Only</region><link>https://weworkremotely.com/remote-jobs/acme-senior-flutter-engineer</link><pubDate>Wed, 18 Nov 2026 10:00:00 +0000</pubDate><description>&lt;p&gt;Flutter&lt;/p&gt;</description></item></channel></rss>';
  const [job] = parseFeed(xml);
  assert.equal(job.company, 'Acme');
  assert.equal(job.title, 'Senior Flutter Engineer');
  assert.equal(job.location, 'Remote (Europe Only)');
  assert.equal(job.description, 'Flutter');
});

test('careers pages: job links, titles and place hints', () => {
  const html = `
    <a href="/careers">Careers</a>
    <a href="/careers/senior-flutter-engineer"><style>.x{color:red}</style><h3>Senior Flutter Engineer</h3><span>Praha, full-time</span></a>
    <a href="/careers/product-manager"><div>Product manager</div><div>Remote</div></a>
    <a href="/blog/hiring">How we hire</a>
    <a href="mailto:jobs@example.com">Write to us</a>`;
  const links = extractJobLinks(html, 'https://example.com/careers');
  assert.deepEqual(links.map((l) => l.title), ['Senior Flutter Engineer', 'Product manager']);
  assert.equal(links[0].hint, 'Praha, full-time');
  assert.equal(links[0].url, 'https://example.com/careers/senior-flutter-engineer');
});

test('hiring systems are recognised in links and page source', () => {
  assert.deepEqual(detectAts('https://jobs.ashbyhq.com/acme/123'), { ats: 'ashby', slug: 'acme' });
  assert.deepEqual(detectAts('<iframe src="https://boards.greenhouse.io/embed/job_board?for=acme">'), { ats: 'greenhouse', slug: 'acme' });
  assert.deepEqual(detectAts('https://acme.recruitee.com/o/qa'), { ats: 'recruitee', slug: 'acme' });
  assert.equal(detectAts('https://example.com/careers'), null);
});

test('JobPosting blocks', () => {
  const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"Dev","description":"<p>Flutter &amp; Dart</p>","datePosted":"2026-11-02T10:30:33+01:00","validThrough":"2026-12-02T23:59:59.999+01:00T23:59","hiringOrganization":{"name":"Acme"},"jobLocation":{"address":{"addressLocality":"Brno","addressCountry":"CZE"}},"baseSalary":{"currency":"CZK","value":{"minValue":50000,"maxValue":75000,"unitText":"MONTH"}}}</script>`;
  const job = jobPostingFromHtml(html);
  assert.equal(job.description, 'Flutter & Dart');
  assert.equal(job.location, 'Brno, CZE');
  assert.deepEqual(job.salary, { min: 50000, max: 75000, currency: 'CZK', period: 'month' });
  assert.equal(new Date(job.postedAt).toISOString().slice(0, 10), '2026-11-02');
});

test('one key per posting, whatever the link looks like', () => {
  assert.equal(jobKey('https://cz.linkedin.com/jobs/view/mobile-app-developer-at-example-apps-4000000001?position=1'), jobKey('https://www.linkedin.com/jobs/view/4000000001/'));
  assert.equal(jobKey('https://www.startupjobs.cz/nabidka/100001/ai-builder'), jobKey('https://www.startupjobs.cz/nabidka/100001/other-slug'));
  assert.equal(jobKey('https://www.jobs.cz/rpd/2000000001/?searchId=abc&rps=233'), 'jobscz:2000000001');
  assert.equal(jobKey('https://Example.com/Careers/Dev/?utm_source=x#apply'), 'example.com/careers/dev');
  assert.equal(roleKey('Acme, a.s.', 'Product Manager (m/ž)'), roleKey('Acme', 'Product Manager'));
});

test('the same opening is recognised under a slightly different title', () => {
  assert.ok(similarTitles('Product Engineer — AI-first 🚀', 'Product Engineer — AI-first (Junior / Medior)'));
  assert.ok(similarTitles('Product Builder for Acme', 'Product Builder', 'Acme'));
  assert.ok(similarTitles('Sr. AI FullStack Developer', 'Senior AI Full-Stack Developer'));
  assert.ok(!similarTitles('Product Manager', 'Senior Product Manager – AI'));
  assert.ok(longTitleKey('AI Product Engineer - AI Applications & Platforms'));
  assert.equal(longTitleKey('AI Engineer'), '');
});
