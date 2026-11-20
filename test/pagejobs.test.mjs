import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJobLinks, findCareersLinks, findListingLinks, jobsFromJson, readJobs, blockedBy, isHomepage, orgDomain,
  jobFrames, nextPageUrl, detectVendors,
} from '../src/pagejobs.mjs';

const titles = (jobs) => jobs.map((j) => j.title);

test('a button link takes its title from the card around it', () => {
  // A common shape on Czech careers pages: the title is in the card, the link is only a button.
  const html = `
    <div class="card"><h3>Full-Stack Developer / SW Engineer + AI</h3><p>Vývoj už není jen psaní kódu.</p>
      <a href="/prace-u-nas/full-stack-developer-sw-engineer-ai">I AM IN!</a></div>
    <div class="card"><h3>Account Manager (IT)</h3><a href="/prace-u-nas/account-manager-it">JDU DO TOHO!</a></div>
    <div class="card"><h3>Junior vývojář</h3><a href="/prace-u-nas/junior-vyvojar/">Více</a></div>`;
  const jobs = extractJobLinks(html, 'https://www.example.cz/otevrene-pozice');
  assert.deepEqual(titles(jobs), ['Full-Stack Developer / SW Engineer + AI', 'Account Manager (IT)', 'Junior vývojář']);
  assert.ok(jobs.every((j) => !j.guessedTitle));
});

test('an empty overlay link falls back to the words in its address, marked as a guess', () => {
  // Another shape: an <a> with no text laid over the whole card.
  const html = '<a href="/cs/careers/ai-forward-deployed-engineer"></a><a href="/cs/careers/growth-hacker"><svg></svg></a>';
  const jobs = extractJobLinks(html, 'https://example.com/cs/careers');
  assert.deepEqual(titles(jobs), ['Ai forward deployed engineer', 'Growth hacker']);
  assert.ok(jobs.every((j) => j.guessedTitle));
});

test('a front page is never read for jobs, and product or case-study links are not jobs', () => {
  assert.equal(isHomepage('https://example.com/'), true);
  assert.equal(isHomepage('https://example.com/cs'), true);
  assert.equal(isHomepage('https://example.com/en-us/'), true);
  assert.equal(isHomepage('https://example.com/careers'), false);
  const html = `
    <a href="/produkty/ai-chatbot">AI Chatbot</a><a href="/produkty/voicebot">AI Voicebot</a>
    <a href="/prace/unilife">UniLife</a><a href="/prace/ticket-app">Ticket app for iOS</a>
    <a href="/blog/how-we-hire-engineers">How we hire engineers</a>`;
  assert.deepEqual(extractJobLinks(html, 'https://example.com/cs'), []);
});

test('one accidental job-like title does not turn a section into a job list', () => {
  const html = ['IT a technologie', 'Obchod a prodej reklamy', 'PR, Marketing a Média', 'HR, Právo a Finance', 'Odborní specialisté', 'Bratislava', 'Trainee a studenti']
    .map((t, i) => `<a href="/kariera/oblast-${i}/">${t}</a>`).join('');
  assert.deepEqual(extractJobLinks(html, 'https://example.cz/kariera/'), []);
});

test('links of the same shape as confident ones are kept, others are not', () => {
  const html = `
    <a href="/careers/senior-flutter-engineer">Senior Flutter Engineer</a>
    <a href="/careers/barista">Barista</a>
    <a href="/careers/product-manager">Product Manager</a>
    <a href="/about/team">Our team</a>
    <a href="/careers">Careers</a>`;
  assert.deepEqual(titles(extractJobLinks(html, 'https://example.com/careers')), ['Senior Flutter Engineer', 'Barista', 'Product Manager']);
});

test('job links may sit on a hiring site or the company\'s other subdomain', () => {
  const html = `
    <a href="https://www.startupjobs.cz/nabidka/108887/senior-technical-3d-artist-unity">SEE DETAILS</a>
    <a href="https://kariera.example.cz/pozice/flutter-vyvojar/">Flutter vývojář</a>
    <a href="https://unrelated.example.org/jobs/designer">Designer</a>`;
  const jobs = extractJobLinks(html, 'https://www.example.cz/jobs');
  assert.deepEqual(jobs.map((j) => new URL(j.url).host), ['www.startupjobs.cz', 'kariera.example.cz']);
  assert.equal(orgDomain('kariera.example.cz'), 'example.cz');
  assert.equal(orgDomain('www.example.co.uk'), 'example.co.uk');
});

test('on a hiring subdomain every page link can be a job', () => {
  const html = '<a href="/senior-product-designer-nov-2026">Senior Product Designer</a><a href="/customer-support-specialist">Customer Support Specialist</a><a href="/">Home</a>';
  assert.equal(extractJobLinks(html, 'https://join.example.com/jobs').length, 2);
});

test('the careers link on a front page', () => {
  const html = `
    <a href="/produkty">Produkty</a><a href="/cs/kariera">Kariéra</a><a href="https://discord.gg/x">Join Discord</a>
    <a href="/hiring-guides">Global Hiring Guides</a><a href="/blog/careers-in-tech">Careers in tech</a>`;
  const links = findCareersLinks(html, 'https://example.com/cs');
  assert.equal(links[0].url, 'https://example.com/cs/kariera');
  assert.ok(!links.some((l) => /discord|guides|blog/.test(l.url)));
});

test('the full list behind a careers landing page', () => {
  const html = '<a href="/kariera/volne-pozice">Všechny volné pozice</a><a href="/kariera/benefity">Benefity</a><a href="/careers/open-positions">See open roles</a>';
  const links = findListingLinks(html, 'https://example.cz/kariera').map((l) => l.url);
  assert.deepEqual(links.sort(), ['https://example.cz/careers/open-positions', 'https://example.cz/kariera/volne-pozice']);
});

test('jobs carried as data', () => {
  const data = { props: { pageProps: { openings: [
    { title: 'Senior Full Stack Engineer', location: { name: 'Remote, Europe' }, jobUrl: 'https://jobs.example.com/abc', department: 'Engineering' },
    { title: 'Product Designer', location: { name: 'Prague' }, jobUrl: 'https://jobs.example.com/def', department: 'Design' },
  ] } } };
  const jobs = jobsFromJson(data, 'https://example.com/careers');
  assert.deepEqual(titles(jobs), ['Senior Full Stack Engineer', 'Product Designer']);
  assert.equal(jobs[0].hint, 'Remote, Europe');
  // Consent banners and menus are lists of named things too.
  assert.deepEqual(jobsFromJson({ items: [{ name: 'Aggregated data about tag firing', id: 1 }, { name: 'Diagnostic data', id: 2 }] }, 'https://example.com'), []);
  const page = { html: '', url: 'https://example.com/careers', json: [{ url: 'https://cdn.cookielaw.org/consent/x.json', data }] };
  assert.equal(readJobs(page).jobs.length, 0);
  assert.equal(readJobs({ ...page, json: [{ url: 'https://example.com/api/openings', data }] }).jobs.length, 2);
});

test('a bot wall is told apart from an ordinary page', () => {
  assert.equal(blockedBy(403, '<title>Example shop</title><div class="captcha">'), 'a captcha page');
  assert.equal(blockedBy(403, '<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x.js">'), 'a Cloudflare challenge');
  // The protection vendor's script is on ordinary pages as well.
  assert.equal(blockedBy(200, '<title>Example Group</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js">'), null);
  assert.equal(blockedBy(404, '<title>Not found</title>'), null);
});

test('embedded job widgets and paging', () => {
  const page = { frames: [
    'https://www.tribee.cz/widget/company-jobs/v1?id=abc',
    'https://app.recruitis.io/en/zadavatel/widgets/offers/h/123',
    'https://consentcdn.cookiebot.com/sdk/bc-v5.min.html',
    'https://www.youtube.com/embed/x',
    'about:blank',
  ] };
  assert.deepEqual(jobFrames(page), page.frames.slice(0, 2));
  assert.deepEqual(detectVendors(page.frames.join(' ')), ['Recruitis', 'Tribee']);
  assert.equal(nextPageUrl('<a href="/jobs?page=2">2</a><a href="/jobs?page=3">3</a>', 'https://example.com/jobs'), 'https://example.com/jobs?page=2');
  assert.equal(nextPageUrl('<link rel="next" href="/jobs/page/3/">', 'https://example.com/jobs/page/2/'), 'https://example.com/jobs/page/3/');
  assert.equal(nextPageUrl('<a href="/about">About</a>', 'https://example.com/jobs'), null);
});
