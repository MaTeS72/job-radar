// Scores a job against the profile (config/profile.yml with your own profile.yml laid over it).
//
// score = best track (title rule + description evidence)
//         + seniority, place of work, freshness
//         + penalties for stacks and requirements that do not fit
//
// The result always carries the reasons, so the report can say WHY a job is in.

import { compileTerms, fold, daysAgo } from './text.mjs';
import { classifyPlace } from './location.mjs';

const NATIVE_TERMS = compileTerms(['swift', 'swiftui', 'uikit', 'objective c', 'kotlin', 'jetpack compose', 'android sdk', 'xcode', 'coroutines']);
const CROSS_TERMS = compileTerms(['flutter', 'dart', 'react native', 'cross platform', 'multiplatform', 'kmp', 'xamarin', 'maui', 'ionic', 'capacitor', 'expo']);
const ML_TERMS = compileTerms([
  'pytorch', 'tensorflow', 'machine learning', 'deep learning', 'mlops', 'data science', 'model training',
  'fine tuning', 'finetuning', 'computer vision', 'phd', 'scikit', 'pandas', 'spark', 'databricks', 'nlp',
  'neural network*', 'reinforcement learning', 'kubeflow', 'sagemaker', 'feature engineering', 'statistic*',
  'inference', 'gpu*', 'cuda', 'model serving', 'vllm', 'triton', 'quantization', 'hugging face', 'transformers',
]);
const PYTHON = compileTerms(['python']);
const OWN_STACK = compileTerms(['flutter', 'dart', 'typescript', 'javascript', 'react', 'react native', 'node.js', 'nodejs', 'next.js', 'firebase']);
const OTHER_BACKEND = compileTerms(['java', 'spring', 'spring boot', '.net', 'c#', 'asp.net', 'php', 'laravel', 'symfony', 'golang', 'ruby', 'rails', 'scala', 'c++']);

const LANGUAGE_NAMES = '(german|deutsch|french|francais|polish|dutch|spanish|italian|hungarian|romanian|portuguese|swedish|danish|norwegian|finnish)';
const FOREIGN_LANGUAGE_PATTERNS = [
  new RegExp(`(fluent|fluency|native|proficien\\w*|business level|professional level|c1|c2|excellent|advanced|verhandlungssicher\\w*|fliessend\\w*|sehr gute) (level |knowledge |command )?(in |of )?(written and spoken |spoken and written )?${LANGUAGE_NAMES}`),
  new RegExp(`${LANGUAGE_NAMES}( language)?( skills)? (\\w+ ){0,2}(c1|c2|fluent|native|speaker|speaking|required|is a must|is required|mandatory)`),
  /deutschkenntnisse|jezyk polski|znajomosc jezyka|maitrise du francais/,
];

const STOPWORDS = {
  en: ['the', 'and', 'of', 'to', 'with', 'you', 'our', 'we', 'will', 'for', 'your', 'are'],
  cs: ['se', 'na', 'je', 'pro', 've', 'ze', 'nebo', 'jsme', 'budes', 'co', 'nas', 'mas', 'jako', 'pri', 'ktere'],
  de: ['und', 'der', 'die', 'das', 'mit', 'fur', 'wir', 'ist', 'bei', 'oder', 'deine', 'unser', 'eine', 'sowie'],
  pl: ['oraz', 'jest', 'dla', 'nie', 'przy', 'praca', 'doswiadczenie', 'wymagania', 'ktore', 'nasz', 'jak'],
  fr: ['nous', 'vous', 'les', 'des', 'pour', 'avec', 'dans', 'est', 'une', 'vos', 'notre'],
  nl: ['het', 'een', 'van', 'voor', 'met', 'wij', 'jij', 'bent', 'onze', 'ook', 'naar'],
  es: ['para', 'con', 'los', 'las', 'una', 'que', 'del', 'nuestro', 'como', 'por'],
  it: ['per', 'con', 'della', 'che', 'una', 'sono', 'nostro', 'gli', 'delle', 'nel'],
};

/** Guess the language a posting is written in; undefined when the text is too short to tell. */
export function detectLanguage(foldedText) {
  const words = foldedText.split(' ');
  if (words.length < 60) return undefined;
  const counts = {};
  const sets = Object.fromEntries(Object.entries(STOPWORDS).map(([lang, list]) => [lang, new Set(list)]));
  for (const word of words) {
    for (const lang in sets) if (sets[lang].has(word)) counts[lang] = (counts[lang] || 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < 10) return undefined;
  return ranked[0][0];
}

/** Largest "N years of experience" figure a description asks for (undefined when none). */
export function requiredYears(foldedText) {
  let max;
  const re = /(\d{1,2})\s*\+?\s*(?:(?:to|az|bis)\s*\d{1,2}\s*)?(?:years?|yrs?|let|roky|roku|rok|jahren?)(?![a-z])/g;
  for (const m of foldedText.matchAll(re)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 12) {
      const context = foldedText.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
      if (/(experience|zkusenost|praxe|praxi|erfahrung|background|working|hands on|commercial|professional)/.test(context)) {
        max = max === undefined ? n : Math.max(max, n);
      }
    }
  }
  return max;
}

function compileRule(rule) {
  return {
    score: Number(rule.score) || 0,
    tracks: Array.isArray(rule.tracks) ? rule.tracks : null,
    terms: rule.terms ? compileTerms(rule.terms) : null,
    all: Array.isArray(rule.all) ? rule.all.map((group) => compileTerms(group)) : null,
  };
}

/** First term (or term combination) of a rule found in the text, or null. */
function ruleHit(rule, folded) {
  if (rule.all) {
    const hits = rule.all.map((group) => group.find(folded)[0]);
    return hits.every(Boolean) ? hits.join(' + ') : null;
  }
  return rule.terms ? rule.terms.find(folded)[0] || null : null;
}

export function createMatcher(profile) {
  const thresholds = { strong: 65, maybe: 45, detail: 22, ...(profile.thresholds || {}) };
  const adj = profile.adjustments || {};
  const placePoints = adj.place || {};
  const exclude = compileTerms(profile.exclude_title || []);
  const titlePenalties = (profile.title_penalties || []).map(compileRule);
  const seniority = compileTerms(adj.seniority_terms || []);
  const tracks = Object.entries(profile.tracks || {}).map(([id, t]) => ({
    id,
    label: t.label || id,
    bodyCap: Number(t.body_cap) || 30,
    title: (t.title || []).map(compileRule),
    body: (t.body || []).map(compileRule),
    bodyOnly: t.body_only
      ? { titleTerms: compileTerms(t.body_only.title_terms || []), base: Number(t.body_only.base) || 0 }
      : null,
  }));
  const maxAgeDays = Number(profile.max_age_days) || 0;
  const ownYears = Number(profile.experience_years) || 0;
  const salaryTarget = Number(profile.salary?.target_monthly_min) || 0;
  const salaryCurrency = profile.salary?.currency || 'CZK';

  function scoreTracks(title, body) {
    let best = null;
    for (const track of tracks) {
      let titleScore = 0;
      let titleTerm = null;
      for (const rule of track.title) {
        const hit = ruleHit(rule, title);
        if (hit && rule.score > titleScore) { titleScore = rule.score; titleTerm = hit; }
      }
      let bodyScore = 0;
      const bodyTerms = [];
      if (body) {
        for (const rule of track.body) {
          const hit = ruleHit(rule, body);
          if (hit) { bodyScore += rule.score; bodyTerms.push(hit); }
        }
        bodyScore = Math.min(bodyScore, track.bodyCap);
      }
      let base = 0;
      let viaBodyOnly = false;
      if (titleScore > 0) {
        base = titleScore + bodyScore;
      } else if (track.bodyOnly && bodyScore > 0 && track.bodyOnly.titleTerms.test(title)) {
        base = track.bodyOnly.base + bodyScore;
        viaBodyOnly = true;
      }
      if (base > 0 && (!best || base > best.base)) {
        best = { track, base, titleScore, titleTerm, bodyScore, bodyTerms, viaBodyOnly };
      }
    }
    return best;
  }

  /**
   * Cheap check on the list entry alone: is this worth opening the job page for?
   * @returns {{ excluded?: string, titleScore: number, generic: boolean, worthDetail: boolean }}
   */
  function preScore(job) {
    const title = fold([job.title, job.titleAlt].filter(Boolean).join(' | '));
    const blocked = exclude.find(title)[0];
    if (blocked) return { excluded: `title: ${blocked}`, titleScore: 0, generic: false, worthDetail: false };
    const best = scoreTracks(title, '');
    const titleScore = best?.titleScore || 0;
    const generic = tracks.some((t) => t.bodyOnly?.titleTerms.test(title));
    const worthDetail = titleScore >= thresholds.detail || (generic && Boolean(job.queryHit));
    return { titleScore, generic, worthDetail };
  }

  /**
   * Full score.
   * @param {object} job normalized job (title, description?, location?, remote?, postedAt?, salary?, queryHit?)
   * @param {{ now?: number }} [opts]
   */
  function score(job, { now = Date.now() } = {}) {
    const title = fold([job.title, job.titleAlt].filter(Boolean).join(' | '));
    const description = job.description || '';
    // A search hit on a keyword is evidence about the ad's text even before the page is read.
    const body = fold(description || job.queryHit || '');
    const hasDescription = description.length > 200;
    const reasons = [];
    const flags = [];

    const result = (extra) => ({ score: 0, tier: 'excluded', track: null, trackLabel: null, reasons, flags, ...extra });

    const blocked = exclude.find(title)[0];
    if (blocked) return result({ excluded: `title contains "${blocked}"` });

    const age = daysAgo(job.postedAt, now);
    // A listing read from the employer's own board (job.live) is open however long ago it was posted.
    if (maxAgeDays && !job.live && age !== undefined && age > maxAgeDays) {
      return result({ excluded: `posted ${age} days ago` });
    }

    const best = scoreTracks(title, body);
    if (!best) return result({ tier: 'low', excluded: 'no track matched' });

    let total = best.base;
    if (best.titleTerm) reasons.push(`title: ${best.titleTerm} (+${best.titleScore})`);
    else reasons.push(`description only (+${best.track.bodyOnly.base})`);
    if (best.bodyTerms.length) reasons.push(`text: ${best.bodyTerms.slice(0, 6).join(', ')} (+${best.bodyScore})`);

    for (const rule of titlePenalties) {
      if (rule.tracks && !rule.tracks.includes(best.track.id)) continue;
      const hit = ruleHit(rule, title);
      // A different stack in the title matters less when Flutter itself is named there.
      if (hit && !(best.track.id === 'flutter' && best.titleScore >= 60)) {
        total += rule.score;
        reasons.push(`title: ${hit} (${rule.score})`);
      }
    }

    if (seniority.test(title) && adj.seniority) {
      total += adj.seniority;
      reasons.push(`senior level (+${adj.seniority})`);
    }

    const place = classifyPlace({ ...job, description });
    if (!place.fits) return result({ track: best.track.id, trackLabel: best.track.label, excluded: `place: ${place.note}`, place });
    const placeScore = Number(placePoints[place.kind]) || 0;
    total += placeScore;
    if (placeScore) reasons.push(`${place.note} (+${placeScore})`);
    if (['remote-europe-country', 'remote-unknown', 'unknown', 'cz'].includes(place.kind)) flags.push(place.note);

    if (age !== undefined) {
      for (const step of adj.freshness || []) {
        if (step.within !== undefined && age <= step.within) {
          total += step.score; reasons.push(`posted ${age === 0 ? 'today' : `${age} d ago`} (+${step.score})`); break;
        }
        if (step.older_than !== undefined && age > step.older_than) {
          total += step.score; reasons.push(`posted ${age} d ago (${step.score})`); break;
        }
      }
    }

    if (job.live && age !== undefined && age > 60) flags.push(`open for ${age} days`);

    if (hasDescription) {
      if (best.bodyScore === 0 && adj.no_text_support) {
        total += adj.no_text_support;
        flags.push('the text mentions none of the expected topics');
      }
      if (best.track.id === 'flutter' && NATIVE_TERMS.test(body) && !CROSS_TERMS.test(body) && adj.native_only) {
        total += adj.native_only;
        flags.push('native iOS/Android stack, no cross-platform mention');
      }
      const mlHits = ML_TERMS.find(body);
      if (mlHits.length >= 3 && adj.ml_heavy) {
        total += adj.ml_heavy;
        flags.push(`ML-heavy (${mlHits.slice(0, 3).join(', ')})`);
      } else if (best.track.id === 'agentic' && PYTHON.count(body) >= 2 && !OWN_STACK.test(body) && adj.python_stack) {
        total += adj.python_stack;
        flags.push('Python is the main language');
      }
      const otherStack = OTHER_BACKEND.find(body);
      if (otherStack.length >= 2 && !OWN_STACK.test(body) && adj.other_backend) {
        total += adj.other_backend;
        flags.push(`different stack (${otherStack.slice(0, 3).join(', ')})`);
      }
      const years = requiredYears(body);
      if (years !== undefined && ownYears) {
        if (years >= ownYears + 3 && adj.years_over) { total += adj.years_over; flags.push(`asks ${years}+ years`); }
        else if (years > ownYears && adj.years_stretch) { total += adj.years_stretch; flags.push(`asks ${years}+ years`); }
      }
      const language = detectLanguage(body);
      const foreignPosting = language && !['en', 'cs'].includes(language);
      if ((foreignPosting || FOREIGN_LANGUAGE_PATTERNS.some((re) => re.test(body))) && adj.foreign_language) {
        total += adj.foreign_language;
        flags.push(foreignPosting ? `posting written in ${language.toUpperCase()}` : 'another language required');
      }
    } else if (!description) {
      flags.push('description not read');
    }

    const pay = job.salary;
    if (pay && pay.currency === salaryCurrency && pay.period === 'month' && salaryTarget) {
      const top = pay.max || pay.min;
      if (top && top < salaryTarget * 0.8) flags.push(`pay below target (up to ${Math.round(top / 1000)}k ${pay.currency})`);
      else if (pay.min && pay.min >= salaryTarget) { total += 2; reasons.push('pay in target range (+2)'); }
    }

    // Until someone confirms Czechia is allowed, "remote in another country" stays below the strong band.
    if (place.kind === 'remote-europe-country') total = Math.min(total, adj.remote_country_cap ?? thresholds.strong - 1);
    const finalScore = Math.max(0, Math.min(100, Math.round(total)));
    const tier = finalScore >= thresholds.strong ? 'strong' : finalScore >= thresholds.maybe ? 'maybe' : 'low';
    return { score: finalScore, tier, track: best.track.id, trackLabel: best.track.label, reasons, flags, place };
  }

  return { score, preScore, thresholds };
}
