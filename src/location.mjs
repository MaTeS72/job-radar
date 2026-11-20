// Decides whether a job's place of work fits: Prague, remote from Czechia, or
// remote across Europe. Everything else is either out or flagged for a look.

import { fold } from './text.mjs';

const PRAGUE = /(?<![a-z])(praha|prague|prag|praze|prahy)(?![a-z])/;

const CZ_OTHER_CITIES = [
  'brno', 'brne', 'ostrava', 'ostrave', 'plzen', 'plzni', 'pilsen', 'olomouc', 'olomouci', 'liberec', 'hradec kralove',
  'pardubice', 'pardubicich', 'zlin', 'ceske budejovice', 'usti nad labem', 'jihlava', 'karlovy vary', 'mlada boleslav',
  'kladno', 'opava', 'frydek', 'havirov', 'most', 'teplice', 'decin', 'prostejov', 'prerov', 'kolin', 'tabor',
  'trebic', 'znojmo', 'pisek', 'kromeriz', 'vsetin', 'uherske hradiste', 'chrastany', 'beroun', 'ricany',
  'nymburk', 'melnik', 'pribram', 'benesov', 'kutna hora', 'jablonec', 'trutnov', 'chomutov', 'sokolov', 'cheb',
  'karvina', 'trinec', 'novy jicin', 'koprivnice', 'sumperk', 'vyskov', 'breclav', 'hodonin', 'blansko', 'zdar',
  // regions
  'south moravia*', 'jihomoravsk*', 'moravia', 'morava', 'moravskoslezsk*', 'silesia*', 'south bohemia*', 'jihocesk*',
  'west bohemia*', 'plzensk*', 'karlovarsk*', 'usteck*', 'libereck*', 'kralovehradeck*', 'pardubick*', 'vysocina',
  'zlinsk*', 'olomouck*', 'central bohemia*', 'stredocesk*',
];
const CZ_COUNTRY = /(?<![a-z])(czechia|czech republic|czech|cesko|ceska republika|cesku|ceske republice|cr|cz|cze)(?![a-z])/;

const REMOTE_WORDS = /(?<![a-z])(remote|remotely|home office|homeoffice|home based|work from home|wfh|z domu|na dalku|prace z domova|telecommut\w*|distributed|anywhere|worldwide)(?![a-z])/;
const EUROPE_WORDS = /(?<![a-z])(europe|european union|eu|emea|eea|cet|cest|central europe|eastern europe|cee|worldwide|anywhere|global|globally|international)(?![a-z])/;

// Countries inside Europe: "remote, Germany" usually means "resident in Germany",
// so these are flagged rather than accepted or dropped.
const EUROPE_COUNTRIES = [
  'germany', 'deutschland', 'austria', 'osterreich', 'switzerland', 'schweiz', 'poland', 'polska', 'slovakia',
  'slovensko', 'hungary', 'netherlands', 'belgium', 'france', 'spain', 'portugal', 'italy', 'ireland',
  'united kingdom', 'uk', 'england', 'scotland', 'denmark', 'sweden', 'norway', 'finland', 'estonia', 'latvia',
  'lithuania', 'romania', 'bulgaria', 'greece', 'croatia', 'slovenia', 'serbia', 'ukraine', 'luxembourg',
  'cyprus', 'malta', 'iceland', 'turkey',
  // capitals and hubs that stand in for the country in location strings
  'berlin', 'munich', 'munchen', 'hamburg', 'vienna', 'wien', 'zurich', 'warsaw', 'krakow', 'wroclaw',
  'bratislava', 'budapest', 'amsterdam', 'brussels', 'paris', 'madrid', 'barcelona', 'lisbon', 'milan', 'rome',
  'dublin', 'london', 'copenhagen', 'stockholm', 'oslo', 'helsinki', 'tallinn', 'riga', 'vilnius', 'bucharest',
  'sofia', 'athens', 'zagreb', 'ljubljana', 'belgrade', 'kyiv', 'istanbul', 'limassol',
];

const OUTSIDE_EUROPE = [
  'united states', 'usa', 'us', 'u s', 'america', 'north america', 'canada', 'mexico', 'latam', 'latin america',
  'brazil', 'argentina', 'colombia', 'chile', 'peru', 'india', 'pakistan', 'bangladesh', 'philippines',
  'indonesia', 'vietnam', 'singapore', 'malaysia', 'thailand', 'japan', 'china', 'korea', 'australia',
  'new zealand', 'apac', 'asia', 'africa', 'nigeria', 'kenya', 'egypt', 'south africa', 'saudi arabia', 'uae',
  'dubai', 'israel', 'qatar',
  'new york', 'san francisco', 'seattle', 'austin', 'boston', 'chicago', 'los angeles', 'toronto', 'vancouver',
  'bangalore', 'bengaluru', 'hyderabad', 'mumbai', 'delhi', 'tel aviv', 'riyadh', 'cairo', 'lagos', 'sydney',
  'ind', 'chennai', 'pune', 'noida', 'gurgaon', 'gurugram', 'kolkata', 'ahmedabad', 'jordan', 'amman', 'lebanon',
  'kuwait', 'bahrain', 'oman', 'iraq', 'iran', 'morocco', 'tunisia', 'algeria', 'ghana', 'ethiopia', 'uganda',
  'tanzania', 'sri lanka', 'nepal', 'taiwan', 'hong kong', 'cambodia', 'kazakhstan', 'uzbekistan', 'georgia',
  'armenia', 'azerbaijan', 'costa rica', 'uruguay', 'ecuador', 'venezuela', 'bolivia', 'paraguay', 'guatemala',
  'panama', 'dominican republic', 'puerto rico', 'jamaica', 'americas', 'north american', 'south america',
  'middle east', 'mena', 'gcc', 'est', 'edt', 'pst', 'pdt', 'cst', 'us hours', 'us time zone*', 'us timezone*',
  'texas', 'california', 'florida', 'washington', 'denver', 'atlanta', 'miami', 'dallas', 'houston', 'ontario',
  'montreal', 'sao paulo', 'buenos aires', 'bogota', 'mexico city', 'manila', 'jakarta', 'karachi', 'lahore',
  'islamabad', 'dhaka', 'tokyo', 'seoul', 'shanghai', 'beijing', 'shenzhen', 'melbourne', 'auckland', 'nairobi',
  'johannesburg', 'cape town', 'abu dhabi', 'doha', 'amer', 'amers', 'namer', 'anz', 'mys', 'sgp', 'phl', 'jpn',
  'kuala lumpur', 'bra', 'mex', 'twn', 'kor', 'chn', 'aus', 'nzl', 'isr', 'are', 'sau', 'zaf',
];

function wordListRegex(list) {
  return new RegExp(`(?<![a-z])(${list.map((w) => w.replace(/\*/g, '[a-z]*').replace(/ /g, '\\s+')).join('|')})(?![a-z])`);
}
const CZ_CITY_RE = wordListRegex(CZ_OTHER_CITIES);
const EUROPE_COUNTRY_RE = wordListRegex(EUROPE_COUNTRIES);
const OUTSIDE_RE = wordListRegex(OUTSIDE_EUROPE);

const PLACE_FILLER = new Set([
  'flexible', 'friendly', 'first', 'fully', 'full', 'time', 'part', 'option', 'optional', 'possible', 'only', 'work',
  'working', 'job', 'position', 'role', 'and', 'hybrid', 'onsite', 'site', 'office', 'based', 'team', 'company', 'wide',
  'the', 'from', 'within', 'with', 'for', 'not', 'stated', 'region', 'location', 'locations', 'multiple', 'various',
  'any', 'all', 'our', 'you', 'can', 'are', 'employment', 'contract', 'permanent', 'freelance', 'available',
]);

const US_ONLY = /(us only|usa only|u s only|united states only|us based|based in the (us|united states)|must (be|reside|live) (located |based )?in the (us|united states|u s)|authorized to work in the (us|united states|u s)|us citizens?|us work authorization|north america only|canada only|latam only|india only)/;
const EUROPE_OK = /(remote (in|within|across|from) (europe|the eu|emea|eea)|europe(an)? (time ?zones?|based|remote)|emea (remote|based|time ?zones?)|anywhere in (europe|the eu|emea|the world)|based in (europe|the eu|emea)|cet ?[+-−±]|(european|eu) (countries|residents?)|work from anywhere|fully remote.{0,40}(europe|eu|emea|worldwide))/;

/**
 * @typedef {'prague'|'cz-remote'|'cz'|'eu-remote'|'remote-europe-country'|'remote-unknown'|'unknown'|'cz-other'|'abroad'|'remote-restricted'} PlaceKind
 */

/**
 * @param {object} job
 * @param {string} [job.location] free-text location
 * @param {'remote'|'hybrid'|'onsite'|null} [job.remote] workplace type when the source states it
 * @param {string[]} [job.countries] countries a remote job is open to (empty = no restriction stated)
 * @param {string} [job.description]
 * @param {boolean} [job.czechSource] true for boards that only list jobs in Czechia
 * @returns {{ kind: PlaceKind, fits: boolean, label: string, note?: string }}
 */
export function classifyPlace(job) {
  const loc = fold(job.location || '');
  const body = fold((job.description || '').slice(0, 6000));
  const countries = (job.countries || []).map((c) => fold(c));

  const prague = PRAGUE.test(loc);
  const czCity = CZ_CITY_RE.test(loc);
  const czCountry = CZ_COUNTRY.test(loc);
  const remote = job.remote === 'remote' || REMOTE_WORDS.test(loc);
  const hybrid = job.remote === 'hybrid' || /hybrid/.test(loc);
  const europeWord = EUROPE_WORDS.test(loc);
  const europeCountry = EUROPE_COUNTRY_RE.test(loc);
  const outside = OUTSIDE_RE.test(loc);
  const label = (job.location || '').trim() || (remote ? 'Remote' : 'not stated');

  if (prague) {
    const mode = remote ? 'remote possible' : hybrid ? 'hybrid' : '';
    return { kind: 'prague', fits: true, label, note: mode ? `Prague, ${mode}` : 'Prague' };
  }

  if (czCity || czCountry || (job.czechSource && !europeCountry && !outside)) {
    if (remote) return { kind: 'cz-remote', fits: true, label, note: 'remote from Czechia' };
    // On a Czech board, a named place that is not Prague is somewhere else in the country.
    const namedPlace = job.czechSource && loc && !czCountry;
    if (czCity || namedPlace) return { kind: 'cz-other', fits: false, label, note: 'outside Prague and not remote' };
    return { kind: 'cz', fits: true, label, note: 'Czechia, city not stated' };
  }

  if (remote) {
    if (countries.length) {
      const openToCz = countries.some((c) => CZ_COUNTRY.test(c) || EUROPE_WORDS.test(c));
      if (openToCz) return { kind: 'eu-remote', fits: true, label, note: 'remote, open to Czechia' };
      return { kind: 'remote-restricted', fits: false, label, note: 'remote, but not open to Czechia' };
    }
    // The location line decides first; the description is consulted only when the line is neutral.
    if (europeWord) return { kind: 'eu-remote', fits: true, label, note: 'remote in Europe' };
    if (outside && !europeCountry) return { kind: 'remote-restricted', fits: false, label, note: 'remote, outside Europe' };
    if (europeCountry) {
      if (EUROPE_OK.test(body)) return { kind: 'eu-remote', fits: true, label, note: 'remote in Europe (per the description)' };
      return { kind: 'remote-europe-country', fits: true, label, note: 'remote in another European country, check that Czechia is allowed' };
    }
    if (US_ONLY.test(body) && !EUROPE_OK.test(body)) {
      return { kind: 'remote-restricted', fits: false, label, note: 'remote, limited to another region' };
    }
    // "Remote" plus a place we cannot put in Europe ("Remote, AMER", "PT to ET overlap") is tied to that place.
    const residue = loc.replace(new RegExp(REMOTE_WORDS.source, 'g'), ' ').split(' ').filter((w) => w.length >= 3 && !PLACE_FILLER.has(w));
    if (residue.length) return { kind: 'remote-restricted', fits: false, label, note: 'remote, tied to another region' };
    if (EUROPE_OK.test(body)) return { kind: 'eu-remote', fits: true, label, note: 'remote in Europe' };
    return { kind: 'remote-unknown', fits: true, label, note: 'remote, region not stated' };
  }

  if (europeCountry || outside) return { kind: 'abroad', fits: false, label, note: 'on site abroad' };
  if (europeWord) return { kind: 'remote-unknown', fits: true, label, note: 'Europe-wide, place of work unclear' };
  // A named place that is neither Prague, Czechia, remote nor Europe-wide is an office somewhere else.
  if (loc) return { kind: 'abroad', fits: false, label, note: 'on site elsewhere' };
  return { kind: 'unknown', fits: true, label, note: 'place of work not stated' };
}
