// Text helpers shared by every source and by the matcher.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·',
  euro: '€', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', deg: '°',
};

/** Decode HTML entities (named, decimal and hex). */
export function decodeEntities(input) {
  if (!input) return '';
  return String(input).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** Collapse runs of whitespace to single spaces. */
export function squash(input) {
  return String(input ?? '').replace(/\s+/g, ' ').trim();
}

/** HTML fragment or page -> readable plain text (block tags become line breaks). */
export function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/ul|\/ol)\b[^>]*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v ]+/g, ' ');
  s = s.replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** Strip tags from a short fragment (titles, company names). */
export function stripTags(html) {
  return squash(decodeEntities(String(html ?? '').replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')));
}

/**
 * Lowercase, remove diacritics and turn separators into spaces, so that
 * "AI-native", "AI native" and "Vývojář/ka" compare the same way.
 * Keeps `+`, `#` and `.` so "c++", "c#" and ".net" stay recognisable.
 */
export function fold(input) {
  return String(input ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss').replace(/ł/g, 'l').replace(/đ/g, 'd').replace(/ø/g, 'o').replace(/æ/g, 'ae')
    .replace(/[^a-z0-9+#.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function termToPattern(term) {
  const folded = fold(String(term).replace(/\*/g, 'qqstarqq'));
  const escaped = folded
    .replace(/[.+#$]/g, '\\$&')
    .replace(/qqstarqq/g, '[a-z0-9]*')
    .replace(/ /g, '\\s+');
  return `(?<![a-z0-9])${escaped}(?![a-z0-9])`;
}

/**
 * Compile a list of terms into a matcher over folded text.
 * A term is matched on word boundaries; `*` stands for "any letters or digits"
 * (so "mobiln* aplikac*" covers Czech inflection).
 *
 * @param {string[]} terms
 * @returns {{ terms: string[], test(folded: string): boolean, find(folded: string): string[], count(folded: string): number }}
 */
export function compileTerms(terms) {
  const list = (terms || []).map((t) => String(t).trim()).filter(Boolean);
  const compiled = list.map((term) => ({ term, re: new RegExp(termToPattern(term), 'g') }));
  return {
    terms: list,
    test(folded) {
      return compiled.some(({ re }) => { re.lastIndex = 0; return re.test(folded); });
    },
    /** Distinct terms present in the text, in config order. */
    find(folded) {
      const hits = [];
      for (const { term, re } of compiled) {
        re.lastIndex = 0;
        if (re.test(folded)) hits.push(term);
      }
      return hits;
    },
    /** Total number of occurrences of any term. */
    count(folded) {
      let total = 0;
      for (const { re } of compiled) {
        re.lastIndex = 0;
        total += (folded.match(re) || []).length;
      }
      return total;
    },
  };
}

const LEGAL_SUFFIXES = [
  's r o', 'spol s r o', 'a s', 'k s', 'v o s', 'se', 'z s', 'inc', 'llc', 'ltd', 'limited', 'gmbh', 'ag',
  'b v', 'bv', 's a', 'sa', 'sas', 'oy', 'ab', 'plc', 'corp', 'corporation', 'co', 'company', 'holding',
  'czech republic', 'ceska republika', 'cz', 'czechia',
];

/** Company name reduced to a comparison key ("Acme, a.s." -> "acme"). */
export function companyKey(name) {
  let key = fold(name).replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  key = key.replace(/^skupina /, '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (key.endsWith(` ${suffix}`)) {
        key = key.slice(0, -suffix.length - 1).trim();
        changed = true;
      }
    }
  }
  return key;
}

/** Job title reduced to a comparison key (gender markers and noise removed). */
export function titleKey(title) {
  return fold(title)
    .replace(/\b(m z|z m|m f d|f m d|m w d|w m d|m f x|f m x|m f|f m|h f|all genders)\b/g, ' ')
    .replace(/\b(ka|ky|ova)\b/g, ' ')
    .replace(/\./g, ' ')
    .replace(/\bfull stack\b/g, 'fullstack').replace(/\bfront end\b/g, 'frontend').replace(/\bback end\b/g, 'backend')
    .replace(/\bsr\b/g, 'senior')
    .replace(/\s+/g, ' ')
    .trim();
}

const TITLE_NOISE = new Set(['senior', 'junior', 'medior', 'mid', 'the', 'and', 'for', 'pro', 'a', 'of', 'in', 'at', 'to', 'with', 'na', 'v', 's']);

/**
 * True when two titles at the same company very likely name the same opening.
 * Words of the company's own name are ignored ("Product Builder for Acme").
 */
export function similarTitles(a, b, company = '') {
  const own = new Set(companyKey(company).split(' '));
  const tokens = (t) => new Set(titleKey(t).split(' ').filter((w) => w.length > 1 && !TITLE_NOISE.has(w) && !own.has(w)));
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / (A.size + B.size - shared) >= 0.75;
}

/**
 * Key for a long, specific title. Two postings sharing one are the same opening
 * even under different company names (a group and its subsidiary, an agency).
 */
export function longTitleKey(title) {
  const key = titleKey(title);
  return key.split(' ').filter((w) => w.length > 1).length >= 5 ? key : '';
}

/** Parse the many date shapes job sites use into epoch ms (undefined when unreadable). */
export function parseDate(value) {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value < 1e11 ? value * 1000 : value; // seconds vs milliseconds
  }
  const text = String(value).trim();
  if (/^\d{9,13}$/.test(text)) return parseDate(Number(text));
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : undefined;
}

export function isoDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export function daysAgo(ms, now = Date.now()) {
  if (!ms) return undefined;
  return Math.floor((now - ms) / 86_400_000);
}
