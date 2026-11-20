// Reads jobs out of a company's own careers page, whatever it is built with.
//
// Three ways a page can carry its jobs, tried in this order:
//   1. links      ordinary <a href> job links in the HTML
//   2. page data  a JSON blob embedded in the page (Next.js and similar)
//   3. network    JSON the page downloads while it loads (needs the browser)
//
// The same module finds the way TO that page: the careers link on a homepage,
// and the "all open positions" link on a careers landing page.

import { fold, stripTags, decodeEntities, squash } from './text.mjs';

// ── Sites ───────────────────────────────────────────────────────────────────

const TWO_LEVEL_TLDS = new Set(['co.uk', 'org.uk', 'com.au', 'co.nz', 'com.br', 'co.jp', 'com.tr', 'co.za', 'com.mx', 'com.pl', 'co.in', 'com.sg']);

/** "kariera.alza.cz" -> "alza.cz": the part that identifies the organisation. */
export function orgDomain(host) {
  const labels = String(host || '').toLowerCase().replace(/^www\./, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return TWO_LEVEL_TLDS.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

// Hosts where a link is a job posting even though it leaves the company's site.
const JOB_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|recruitee\.com|teamtailor\.com|smartrecruiters\.com|personio\.(de|com)|bamboohr\.com|breezy\.hr|jobs\.cz|prace\.cz|teamio\.com|recruitis\.io|datacruit\.com|welcometothejungle\.com|join\.com|homerun\.co|comeet\.com?|pinpointhq\.com|rippling\.com|gem\.com|applytojob\.com|freshteam\.com|factorialhr\.com|myworkdayjobs\.com|startupjobs\.cz|cocuma\.cz|notion\.site|tribee\.cz|sloneek\.com)$/i;

/** Hiring and job-board systems, for telling the user what a careers page runs on. */
const VENDORS = [
  ['Greenhouse', /greenhouse\.io/i], ['Lever', /lever\.co/i], ['Ashby', /ashbyhq\.com/i],
  ['Workable', /workable\.com/i], ['Recruitee', /recruitee\.com/i], ['Teamtailor', /teamtailor/i],
  ['SmartRecruiters', /smartrecruiters\.com/i], ['Personio', /personio\.(de|com)/i], ['BambooHR', /bamboohr\.com/i],
  ['Breezy', /breezy\.hr/i], ['Teamio (jobs.cz)', /teamio\.com|[a-z0-9-]+\.jobs\.cz|lmc\.eu/i],
  ['Recruitis', /recruitis\.io/i], ['Datacruit', /datacruit\.com/i],
  ['Welcome to the Jungle', /welcometothejungle\.com|wttj\.co/i], ['JOIN', /\bjoin\.com/i],
  ['Homerun', /homerun\.co/i], ['Comeet', /comeet\.com?/i], ['Pinpoint', /pinpointhq\.com/i],
  ['Rippling', /ats\.rippling\.com|rippling\.com\/[a-z-]*jobs/i], ['Gem', /jobs\.gem\.com|api\.gem\.com/i],
  ['Dover', /app\.dover\.(com|io)/i], ['Polymer', /jobs\.polymer\.co/i], ['Zoho Recruit', /zohorecruit|zoho\.[a-z]+\/recruit/i],
  ['JazzHR', /applytojob\.com/i], ['Freshteam', /freshteam\.com/i], ['HiBob', /hibob\.com/i],
  ['Factorial', /factorialhr\./i], ['Workday', /myworkdayjobs\.com/i], ['iCIMS', /icims\.com/i],
  ['SAP SuccessFactors', /successfactors\.(com|eu)|jobs2web/i], ['Taleo', /taleo\.net/i], ['Jobvite', /jobvite\.com/i],
  ['Notion', /notion\.site/i], ['Sloneek', /sloneek\.com/i], ['Nalgoo', /nalgoo\.com/i], ['Tribee', /tribee\.cz/i],
];

export function detectVendors(text) {
  const haystack = String(text || '');
  return VENDORS.filter(([, re]) => re.test(haystack)).map(([name]) => name);
}

/**
 * A bot wall instead of the page: which one, or null.
 * Many ordinary pages carry a protection vendor's script, so the vendor's name
 * alone means nothing: it takes an error status or the challenge page itself.
 */
export function blockedBy(status, html) {
  const h = String(html || '').slice(0, 200_000);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(h)?.[1] || '';
  const refused = status === 401 || status === 403 || status === 429 || status === 503;
  if (/Just a moment|Attention Required|Checking your browser|Verify(ing)? you are human|Access denied|Pardon Our Interruption/i.test(title)) {
    return /cloudflare|cf-chl|cf_chl|cdn-cgi|challenge-platform/i.test(h) ? 'a Cloudflare challenge' : 'a bot check';
  }
  if (!refused) return null;
  if (/cf-chl|cf_chl|challenge-platform|cloudflare/i.test(h)) return 'a Cloudflare challenge';
  if (/captcha-delivery\.com|datadome/i.test(h)) return 'a DataDome challenge';
  if (/px-captcha|perimeterx/i.test(h)) return 'a PerimeterX challenge';
  if (/_Incapsula_Resource|incapsula/i.test(h)) return 'an Imperva challenge';
  if (/captcha|are you a (robot|human)|unusual traffic/i.test(h)) return 'a captcha page';
  return status === 503 ? null : `a refusal (HTTP ${status})`;
}

const NO_OPENINGS = /(no|don.?t have any|do not have any|aren.?t any|there are no|currently no|without any)\s+(open |current |available |vacant )?(positions?|roles?|openings?|vacancies|jobs)\b|not (currently )?hiring|no open roles|aktu[aá]ln[eě] (ne(hled[aá]me|nab[ií]r[aá]me)|nem[aá]me)|moment[aá]ln[eě] (ne(hled[aá]me|nab[ií]r[aá]me)|nem[aá]me)|[žz][aá]dn[eéáý] (voln[eéáý] |otev[řr]en[eéáý] )?(pozic[ei]|m[ií]st[oa]|nab[ií]dk[ay])|nem[aá]me (aktu[aá]ln[eě] )?([žz][aá]dn[eéáý] )?(voln|otev[řr]en)/i;

/** True when a careers page says in words that nothing is open right now. */
export function saysNoOpenings(html) {
  const text = stripTags(String(html || '').replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' '));
  return NO_OPENINGS.test(text);
}

/** True for a site's front page ("/", "/cs", "/en-us"): a place to find the careers link, not jobs. */
export function isHomepage(url) {
  try {
    return /^\/?([a-z]{2}([-_][a-z]{2})?\/?)?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// ── Finding the way to the jobs ─────────────────────────────────────────────

function anchors(html, baseUrl) {
  const base = new URL(baseUrl);
  const out = [];
  for (const m of String(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
    const raw = decodeEntities(href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
    if (!raw || /^(#|mailto:|tel:|javascript:|data:)/i.test(raw)) continue;
    let url;
    try { url = new URL(raw, base); } catch { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    url.hash = '';
    const inner = m[2].replace(/<(style|script|svg)\b[\s\S]*?<\/\1>/gi, ' ');
    out.push({ url, inner, text: stripTags(inner), attrs: m[1], at: m.index });
  }
  return out;
}

const CAREERS_TEXT = /^(careers?|career opportunities|jobs|job openings|open (positions|roles)|join( us| the team| our team)?|we('| a)?re hiring!?|work (with|at|for) us|kari[eé]ra|pr[aá]ce( u n[aá]s)?|voln[áée] (m[ií]sta|pozice)|p[řr]idej(te)? se( k n[aá]m)?|hled[aá]me( kolegy| pos[ií]ly)?|nab[ií]r[aá]me|karriere|stellenangebote)(\s*(hiring|new|↗|→|\d+))?$/i;
const CAREERS_HREF = /(\/|\.|-)(careers?|jobs|kariera|join(-us)?|hiring|work-with-us|pracuj|prace-u-nas|volna-mista|volne-pozice|open-positions|positions|karriere|we-are-hiring)(\/|$|\?|\.)/i;

// A subdomain that exists for hiring: every page on it is about jobs.
const CAREERS_HOST = /^(join|jobs|careers?|kariera|prace|work|hiring|talent)\./i;

/** Links on a page (usually a homepage) that lead to the careers section, best first. */
export function findCareersLinks(html, pageUrl) {
  const here = new URL(pageUrl);
  const org = orgDomain(here.host);
  const scored = new Map();
  for (const a of anchors(html, pageUrl)) {
    const sameOrg = orgDomain(a.url.host) === org;
    if (!sameOrg && !JOB_HOSTS.test(a.url.host)) continue;
    if (a.url.href === here.href) continue;
    let score = 0;
    const words = a.text.split(' ');
    if (CAREERS_TEXT.test(a.text) || CAREERS_TEXT.test(words[0]) || CAREERS_TEXT.test(words.slice(0, 2).join(' '))) score += 3;
    if (CAREERS_HREF.test(a.url.host + a.url.pathname)) score += 2;
    if (CAREERS_HOST.test(a.url.host)) score += 2;
    if (!score) continue;
    if (/blog|news|press|clanek|article|story|podcast|guide|discord|community|forum|docs|help|support/i.test(a.url.host + a.url.pathname)) score -= 4;
    if (score <= 0) continue;
    // Shallow pages are sections; deep ones are single jobs or articles.
    score -= Math.max(0, a.url.pathname.split('/').filter(Boolean).length - 2);
    const key = a.url.href.replace(/\/$/, '');
    if (score > (scored.get(key)?.score ?? 0)) scored.set(key, { url: a.url.href, text: a.text.slice(0, 60), score });
    // "/career/senior-flutter-developer" on a front page: the list itself is one level up.
    const parts = a.url.pathname.split('/').filter(Boolean);
    const at = parts.findIndex((part) => CAREERS_HREF.test(`/${part}/`));
    if (at !== -1 && at < parts.length - 1) {
      const parent = `${a.url.origin}/${parts.slice(0, at + 1).join('/')}`;
      if (parent !== here.href.replace(/\/$/, '') && !scored.has(parent)) scored.set(parent, { url: parent, text: '', score: score + 2 });
    }
  }
  return [...scored.values()].sort((x, y) => y.score - x.score);
}

const LISTING_TEXT = /((open|current|all|view|see|browse|explore|show)\b.{0,24}\b(positions?|roles?|jobs?|openings?|vacanc(y|ies)|opportunit(y|ies)))|((positions?|roles?|jobs?|openings?|vacancies)\b.{0,12}\b(list|board|overview))|voln[áée] (m[ií]sta|pozice)|otev[řr]en[ée] pozice|aktu[aá]ln[ií] (nab[ií]dk[ay]|pozice)|v[šs]echny (pozice|nab[ií]dky)|nab[ií]dk[ay] pr[aá]ce|pracovn[ií] (p[řr][ií]le[žz]itosti|nab[ií]dky|pozice|m[ií]sta)|koho hled[aá]me|(zobrazit|prohl[eé]dnout|uk[aá]zat) (pozice|nab[ií]dky)|offene stellen|stellenangebote|join our team|we('| a)?re hiring/i;
const LISTING_HREF = /(open-?positions|openings|vacancies|\/jobs|positions|volna-mista|volne-pozice|\/pozice|nabidka-prace|nabidky|job-?board|opportunities|stellenangebote|#jobs|#positions|#openings)/i;

/** Links on a careers landing page that lead to the full list of openings, best first. */
export function findListingLinks(html, pageUrl) {
  const here = new URL(pageUrl);
  const org = orgDomain(here.host);
  const scored = new Map();
  for (const a of anchors(html, pageUrl)) {
    const sameOrg = orgDomain(a.url.host) === org;
    if (!sameOrg && !JOB_HOSTS.test(a.url.host)) continue;
    if (a.url.href.replace(/\/$/, '') === here.href.replace(/\/$/, '')) continue;
    let score = 0;
    if (LISTING_TEXT.test(a.text)) score += 3;
    if (LISTING_HREF.test(a.url.pathname + a.url.search)) score += 2;
    if (!sameOrg) score += 1; // a hiring system's board is the list itself
    if (score < 2) continue;
    if (/blog|news|press|clanek|article/i.test(a.url.pathname)) continue;
    const key = a.url.href.replace(/\/$/, '');
    if (score > (scored.get(key)?.score ?? 0)) scored.set(key, { url: a.url.href, text: a.text.slice(0, 60), score });
  }
  return [...scored.values()].sort((x, y) => y.score - x.score);
}

// ── Jobs as links ───────────────────────────────────────────────────────────

const JOB_PATH = /\/(jobs?|careers?|kariera|kariery|pozice|positions?|vacanc(?:y|ies)|openings?|volna-mista|volne-pozice|volna-pozice|otevrene-pozice|nabidka-prace|nabidky-prace|inzerat|open-roles|join-us|open-positions|opportunit(?:y|ies)|stellenangebote|stellen|prace-u-nas|work-with-us|hiring|pracovni-pozice|pracovni-nabidky|pracovni-prilezitosti|job-detail|pd|rpd)\/[^/?#]/i;
const NOT_A_JOB_PATH = /\/(blog|news|novinky|press|about|o-nas|contact|kontakt|privacy|terms|cookies?|gdpr|faq|culture|kultura|benefits|benefity|life|values|hodnoty|events?|akce|podcast|case-stud(y|ies)|pripadove-studie|reference|references|clients?|klienti|products?|produkty?|services?|sluzby|solutions?|reseni|features?|funkce|pricing|cenik|projects?|projekty|portfolio|work|category|kategorie|department|oddeleni|tag|author|page|login|signup|register|search|locations?|pobocky|offices?|teams?|tym|people|lide)(\/|$)/i;
const NAV_TEXT = /^(all jobs|jobs|careers?|kari[eé]ra|open positions|voln[eé] pozice|voln[aá] m[ií]sta|en|cs|cz|de|sk|next|previous|dal[šs][ií]|p[řr]edchoz[ií]|\d+|share|sd[ií]let|linkedin|facebook|instagram|twitter|x|youtube|github|privacy policy|cookies?|home|dom[uů]|contact|kontakt|about( us)?|o n[aá]s|blog|zp[eě]t|back|cart|ko[šs][ií]k|search|hledat|log ?in|sign ?in|sign ?up|p[řr]ihl[aá][šs]en[ií]|menu|faq|help|n[aá]pov[eě]da|open application|spont[aá]nn[ií] [žz][aá]dost|poslat [žz]ivotopis|send (us )?(your )?(cv|resume)|folder:.*)$/i;
// Button wording: the link is a job link, but its text is not the job's title.
const BUTTON_TEXT = /^(view( job| role| position| details?)?|see( job| role| details?| more)?|details?|job details?|apply( now| here| for this (job|role|position))?|learn more|read more|more( info(rmation)?)?|find out more|show more|open|go|zobrazit( v[ií]ce| detail| pozici)?|v[ií]ce( informac[ií]| info)?|detail( pozice| nab[ií]dky)?|cel[yý] inzer[aá]t|m[aá]m z[aá]jem|chci v[eě]d[eě]t v[ií]c|zjistit v[ií]ce|p[řr]e[cč][ií]st|odpov[eě]d[eě]t|reagovat|i am in!?|jdu do toho!?|to je n[eě]co pro m[eě]!?|let.?s go!?|join( us)?|→|›|»|>)$/i;
const FILE_EXT = /\.(pdf|docx?|jpe?g|png|gif|svg|webp|zip|mp4|ics)$/i;

// A title that names a job, in English or Czech (folded, without diacritics).
// Only words for roles: technologies and topics ("AI", "iOS", "data") also name products and case studies.
const ROLE_WORDS = /(?<![a-z])(engineers?|developers?|programmer\w*|architect\w*|designer\w*|manager\w*|leader|lead|director|specialist\w*|analyst\w*|consultant\w*|scientist\w*|researcher\w*|tester\w*|qa|devops|sre|administrator\w*|officer|coordinator|assistant|associate|representative|executive|intern|internship|trainee|recruiter|accountant|writer|editor|marketer|strategist|product owner|scrum master|technician|advocate|controller|buyer|planner|artist|animator|copywriter|lawyer|counsel|hacker|evangelist|head of|vp|chief|cto|cfo|coo|cmo|frontend|backend|fullstack|full stack|vyvojar\w*|programator\w*|inzenyr\w*|architekt\w*|manazer\w*|vedouci|reditel\w*|specialist[aeu]\w*|analytik\w*|konzultant\w*|asistent\w*|koordinator\w*|obchodnik\w*|obchodni zastupce|ucetni|pravnik\w*|personalist\w*|skladnik\w*|ridic\w*|prodavac\w*|technik\w*|lektor\w*|redaktor\w*|grafik\w*|koder\w*|stazist\w*|staz|brigadnik\w*|brigada|referent\w*|poradce|mistr|delnik\w*|kuchar\w*|operator\w*|dispecer\w*|nakupci|recepcni)(?![a-z])/;

/** URL "shape": where a link sits in the site, without its last segment. */
function shapeOf(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  return `${url.host}/${parts.slice(0, -1).join('/')}#${parts.length}`;
}

function cardText(inner) {
  const heading = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(inner)?.[1];
  const chunks = inner.split(/<[^>]+>/).map((c) => stripTags(c)).filter((c) => /[\p{L}\p{N}]/u.test(c));
  let title = (heading ? stripTags(heading) : chunks[0] || '').slice(0, 140).trim();
  // Cards often open with a department or a tag; the title is the first line that names a role.
  if (!heading && title && !ROLE_WORDS.test(fold(title))) {
    const named = chunks.slice(1, 4).find((c) => c.length <= 140 && ROLE_WORDS.test(fold(c)));
    if (named) title = named;
  }
  const hint = chunks.filter((c) => c !== title).join('; ').slice(0, 160);
  return { title, hint };
}

/** "/careers/senior-flutter-engineer-1234" -> "Senior flutter engineer". */
function slugTitle(url) {
  const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
  // An id ("b994b65a-136d-4592-b0dc-8b4c20a7029b") carries no title.
  if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(last) || /^[0-9a-f]{16,}$/i.test(last)) return '';
  const words = last.replace(/\.(html?|php|aspx?)$/i, '').split(/[-_+.]+/).filter((w) => w && !/^\d+$/.test(w));
  if (words.length < 1 || words.join('').length < 4) return '';
  const text = words.join(' ');
  return text[0].toUpperCase() + text.slice(1);
}

/**
 * Title for a link whose own text is a button ("More", "I am in!") or empty:
 * the card's heading just before it when that agrees with the link, otherwise
 * the link's own words (marked as a guess, to be replaced by the job page's own title).
 */
function contextTitle(html, at, url) {
  const fromSlug = slugTitle(url);
  const before = html.slice(Math.max(0, at - 3000), at);
  const headings = [...before.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)];
  const heading = headings.length ? stripTags(headings[headings.length - 1][1]).slice(0, 140) : '';
  if (heading.length >= 4) {
    const slugWords = new Set(fold(fromSlug).split(' ').filter((w) => w.length > 2));
    const shared = fold(heading).split(' ').some((w) => slugWords.has(w));
    if (shared || (!slugWords.size && ROLE_WORDS.test(fold(heading)))) return { title: heading, guessed: false };
  }
  return { title: fromSlug, guessed: true };
}

/**
 * Job links on a careers page.
 *
 * Links that sit in a job-like place AND read like a job title set the pattern;
 * every other link of the same shape is then taken too, so "Barista" next to
 * "Senior Engineer" is kept while "How we hire" on a site with no such
 * pattern is not.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @param {string} [pattern] regular expression a job URL must match (overrides the automatic pick)
 * @returns {{ id: string, title: string, url: string, hint: string }[]}
 */
export function extractJobLinks(html, pageUrl, pattern) {
  const here = new URL(pageUrl);
  const org = orgDomain(here.host);
  const custom = pattern ? new RegExp(pattern, 'i') : null;
  const herePath = here.pathname.replace(/\/+$/, '');
  const source = String(html);
  /** @type {Map<string, { title: string, url: URL, hint: string, seed: boolean, place: boolean }>} */
  const candidates = new Map();

  for (const a of anchors(source, pageUrl)) {
    const { url } = a;
    const sameOrg = orgDomain(url.host) === org;
    const onJobHost = JOB_HOSTS.test(url.host);
    if (!sameOrg && !onJobHost) continue;
    if (FILE_EXT.test(url.pathname)) continue;
    const path = url.pathname.replace(/\/+$/, '');
    if (!custom) {
      if (sameOrg && url.host === here.host && (path === herePath || path === '')) continue;
      if (NOT_A_JOB_PATH.test(url.pathname) && !JOB_PATH.test(url.pathname)) continue;
    }
    const place = custom
      ? custom.test(url.href)
      : (onJobHost && path.split('/').filter(Boolean).length >= 2) || JOB_PATH.test(url.pathname)
        || (url.host === here.host && herePath.length > 1 && !isHomepage(pageUrl) && path.startsWith(`${herePath}/`))
        || (url.host === here.host && CAREERS_HOST.test(here.host) && path.length > 1);
    if (custom && !place) continue;

    let { title, hint } = cardText(a.inner);
    let guessed = false;
    // A button or an empty overlay link: the title is in the card around it.
    if (place && (title.length < 4 || BUTTON_TEXT.test(title))) {
      ({ title, guessed } = contextTitle(source, a.at, url));
      hint = '';
    }
    if (title.length < 4 || NAV_TEXT.test(title) || BUTTON_TEXT.test(title)) continue;

    const hasId = /\d{4,}/.test(url.pathname + url.search);
    const reads = ROLE_WORDS.test(fold(title));
    // A seed is a link we are confident about: job-like place plus a job-like title or a posting id.
    const seed = custom ? true : place && (reads || hasId);
    if (!place && !reads) continue;
    const known = candidates.get(url.href);
    if (!known || (seed && !known.seed) || (reads && !ROLE_WORDS.test(fold(known.title)))) candidates.set(url.href, { title, url, hint, seed, place, guessed });
  }

  const all = [...candidates.values()];
  if (custom) return all.map(toJob);
  // A shape (same place in the site, same depth) is a job list when enough of its links are confident ones.
  const byShape = new Map();
  for (const c of all) {
    if (!c.place) continue;
    const shape = shapeOf(c.url);
    const group = byShape.get(shape) || { seeds: 0, total: 0 };
    group.total += 1;
    if (c.seed) group.seeds += 1;
    byShape.set(shape, group);
  }
  const jobShapes = new Set([...byShape].filter(([, g]) => g.seeds >= Math.max(1, Math.ceil(g.total * 0.34))).map(([shape]) => shape));
  return all.filter((c) => c.place && jobShapes.has(shapeOf(c.url))).map(toJob);
}

function toJob(c) {
  const job = { id: c.url.href, title: c.title, url: c.url.href, hint: c.hint };
  if (c.guessed) job.guessedTitle = true;
  return job;
}

/** A "next page" link of a paginated list, or null. */
export function nextPageUrl(html, pageUrl) {
  const here = new URL(pageUrl);
  const rel = /<(?:a|link)\b[^>]*\brel\s*=\s*["']?next["']?[^>]*>/i.exec(html)?.[0];
  const relHref = rel && /\bhref\s*=\s*["']([^"']+)["']/i.exec(rel)?.[1];
  if (relHref) {
    try { return new URL(decodeEntities(relHref), here).href; } catch { /* fall through */ }
  }
  const current = Number(here.searchParams.get('page') || here.pathname.match(/\/page\/(\d+)/)?.[1] || 1);
  for (const a of anchors(html, pageUrl)) {
    if (orgDomain(a.url.host) !== orgDomain(here.host)) continue;
    const n = Number(a.url.searchParams.get('page') || a.url.pathname.match(/\/page\/(\d+)/)?.[1] || 0);
    if (n === current + 1 && a.url.pathname.replace(/\/page\/\d+\/?$/, '') === here.pathname.replace(/\/page\/\d+\/?$/, '')) return a.url.href;
  }
  return null;
}

// ── Jobs as data ────────────────────────────────────────────────────────────

const TITLE_KEYS = ['title', 'jobTitle', 'job_title', 'positionName', 'position_name', 'position', 'name', 'text', 'headline', 'label', 'role'];
const URL_KEYS = ['url', 'absolute_url', 'absoluteUrl', 'jobUrl', 'job_url', 'hostedUrl', 'careers_url', 'careersUrl', 'publicUrl', 'public_url', 'permalink', 'link', 'href', 'applyUrl', 'apply_url', 'shortlink', 'detailUrl', 'detail_url'];
const SLUG_KEYS = ['slug', 'path', 'uri', 'urlSlug', 'url_slug', 'seoUrl', 'handle'];
const PLACE_KEYS = ['location', 'locations', 'city', 'office', 'offices', 'place', 'region', 'country', 'workplace', 'locality', 'lokalita', 'misto'];
const JOB_HINT_KEYS = /^(department|team|location|locations|city|office|employmentType|employment_type|type|seniority|applyUrl|apply_url|jobUrl|job_url|careers_url|requisition|workplace|workplaceType|remote|contract|salary|commitment|category|published|publishedAt|published_at|createdAt|created_at|datePosted|uvazek|lokalita|oddeleni)$/i;
const TEXT_KEYS = ['description', 'descriptionPlain', 'content', 'body', 'descriptionHtml', 'jobDescription', 'text', 'perex', 'summary'];

const pickString = (obj, keys) => {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = v.cs || v.en || v.name || v.title || v.label || v.value || v.rendered;
      if (typeof inner === 'string' && inner.trim()) return inner.trim();
    }
  }
  return '';
};

function placeText(obj) {
  for (const key of PLACE_KEYS) {
    const v = obj[key];
    if (!v) continue;
    const list = Array.isArray(v) ? v : [v];
    const parts = list.map((p) => (typeof p === 'string' ? p : pickString(p || {}, ['name', 'city', 'label', 'title', 'text', 'location', 'country']))).filter(Boolean);
    if (parts.length) return [...new Set(parts)].join('; ').slice(0, 160);
  }
  return '';
}

function asJob(obj, pageUrl) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const title = squash(decodeEntities(pickString(obj, TITLE_KEYS).replace(/<[^>]+>/g, ' ')));
  if (title.length < 4 || title.length > 140) return null;
  let url = '';
  const link = pickString(obj, URL_KEYS);
  if (link && /^(https?:\/\/|\/)/.test(link)) {
    try { url = new URL(link, pageUrl).href; } catch { /* keep empty */ }
  }
  const slug = url ? '' : pickString(obj, SLUG_KEYS) || (['string', 'number'].includes(typeof obj.id) ? String(obj.id) : '');
  const text = pickString(obj, TEXT_KEYS);
  return {
    title,
    url,
    slug,
    hint: placeText(obj),
    description: text.length > 200 ? text : '',
    keys: Object.keys(obj),
  };
}

/**
 * The most job-like list of records anywhere inside a JSON value.
 * @returns {{ title: string, url: string, slug: string, hint: string, description: string }[]}
 */
export function jobsFromJson(data, pageUrl) {
  let best = [];
  let bestScore = 0;
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) {
      if (node.length >= 1 && node.length <= 2000 && typeof node[0] === 'object') {
        const jobs = node.map((item) => asJob(item, pageUrl)).filter(Boolean);
        if (jobs.length >= Math.max(1, node.length * 0.8)) {
          const reads = jobs.filter((j) => ROLE_WORDS.test(fold(j.title))).length / jobs.length;
          const hinted = jobs.filter((j) => j.keys.some((k) => JOB_HINT_KEYS.test(k))).length / jobs.length;
          const linked = jobs.filter((j) => j.url || j.slug).length / jobs.length;
          // Job lists read like jobs AND carry job-ish fields; menus and articles do not.
          if (reads >= 0.5 && (hinted >= 0.5 || reads >= 0.8) && linked >= 0.5) {
            const score = jobs.length * (reads + hinted);
            if (score > bestScore) { best = jobs; bestScore = score; }
          }
        }
      }
      for (const item of node.slice(0, 500)) visit(item, depth + 1);
      return;
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  visit(data, 0);
  return best.map(({ keys, ...job }) => job);
}

/** JSON blobs embedded in a page (Next.js data, JSON script tags). */
export function embeddedJson(html) {
  const blobs = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of String(html).matchAll(re)) {
    if (m[1].length < 200 || m[1].length > 6_000_000) continue;
    try { blobs.push(JSON.parse(m[1])); } catch { /* not plain JSON (Nuxt's packed format, for one) */ }
  }
  return blobs;
}

/**
 * Give data-only jobs a link: the matching <a> on the page when there is one,
 * otherwise the careers page itself with an anchor that keeps each job distinct.
 */
export function linkDataJobs(jobs, html, pageUrl) {
  const links = anchors(html || '', pageUrl);
  return jobs.map((job) => {
    if (job.url) return { id: job.url, title: job.title, url: job.url, hint: job.hint, description: job.description };
    const slug = String(job.slug || '').replace(/^\/+|\/+$/g, '');
    const byHref = slug && slug.length >= 3 ? links.find((a) => a.url.pathname.includes(slug) || a.url.search.includes(slug)) : null;
    const byText = byHref ? null : links.find((a) => a.text && fold(a.text).includes(fold(job.title)) && a.text.length < job.title.length + 60);
    const hit = byHref || byText;
    const url = hit ? hit.url.href : `${pageUrl.split('#')[0]}#${encodeURIComponent(slug || fold(job.title).replace(/ /g, '-'))}`;
    return { id: url, title: job.title, url, hint: job.hint, description: job.description, approxUrl: !hit };
  });
}

/**
 * Everything one loaded page says about jobs.
 *
 * @param {object} page
 * @param {string} page.html
 * @param {string} page.url
 * @param {{ url: string, data: any }[]} [page.json] JSON the page downloaded (browser only)
 * @param {string} [pattern]
 * @returns {{ jobs: object[], via: 'links'|'page data'|'network'|null }}
 */
export function readJobs(page, pattern) {
  const links = extractJobLinks(page.html, page.url, pattern);
  let data = [];
  let via = null;
  for (const blob of embeddedJson(page.html)) {
    const found = jobsFromJson(blob, page.url);
    if (found.length > data.length) { data = found; via = 'page data'; }
  }
  for (const response of page.json || []) {
    if (NOT_JOB_DATA.test(response.url || '')) continue;
    const found = jobsFromJson(response.data, response.url || page.url);
    if (found.length > data.length) { data = found; via = 'network'; }
  }
  const confident = (jobs) => jobs.filter((j) => ROLE_WORDS.test(fold(j.title))).length;
  // Links carry real URLs, so they win unless the data clearly knows more jobs.
  if (links.length && links.length >= data.length * 0.7) return { jobs: links, via: 'links', confident: confident(links) };
  if (data.length) {
    const jobs = linkDataJobs(data, page.html, page.url);
    return { jobs, via, confident: confident(jobs) };
  }
  return { jobs: links, via: links.length ? 'links' : null, confident: confident(links) };
}

// Consent banners, analytics and chat widgets also download lists of named things.
const NOT_JOB_DATA = /(cookie|consent|onetrust|usercentrics|cookiebot|analytics|segment|hubspot|hs-|intercom|drift|zendesk|sentry|bugsnag|clarity|hotjar|googletagmanager|doubleclick|facebook|linkedin\.com\/li|i18n|locales?\/|translations?)/i;

/** Embedded frames worth opening on their own: job widgets from another service. */
export function jobFrames(page) {
  return [...new Set((page.frames || []).filter((f) => /^https?:/.test(f)
    && (JOB_HOSTS.test(hostOf(f)) || /(job|career|widget|offer|position|vacanc|recruit|pozic|nabid|kariera|hiring)/i.test(f))
    && !NOT_JOB_DATA.test(f) && !/consent|captcha|recaptcha|chat|youtube|vimeo|maps/i.test(f)))];
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}
