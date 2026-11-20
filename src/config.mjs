// Settings come in two layers:
//
//   built-in   config/*.yml next to the code. They change with the code.
//   yours      <your data>/config/*.yml, holding only what you want different.
//
// Your file is laid over the built-in one: a map is merged key by key, any
// other value replaces the built-in value. For a list, `name+:` adds entries
// and `name-:` takes entries out, so one extra word does not mean copying a
// list of a hundred. companies.yml has its own rule (see mergeCompanies).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, parseDocument, isSeq, isMap as isYamlMap, isScalar, Scalar } from 'yaml';
import { BUILT_IN_CONFIG_DIR, TEMPLATE_DIR, configDir, homeDir } from './paths.mjs';

export const FILES = ['profile.yml', 'sources.yml', 'companies.yml'];

const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => (typeof a === 'string' && typeof b === 'string'
  ? a.trim().toLowerCase() === b.trim().toLowerCase()
  : JSON.stringify(a) === JSON.stringify(b));

/**
 * Lay `own` over `base`.
 * @param {string} [where] path of the key being merged, for error messages
 */
export function overlay(base, own, where = '') {
  if (own === undefined) return base;
  if (!isMap(own)) return own;
  // A map of yours laid over something that is not a map starts from nothing.
  const under = isMap(base) ? base : {};
  const out = { ...under };
  const edits = [];
  for (const [key, value] of Object.entries(own)) {
    const edit = /^(.+)([+-])$/.exec(key);
    if (edit) edits.push({ name: edit[1], add: edit[2] === '+', items: Array.isArray(value) ? value : [value] });
    else out[key] = overlay(under[key], value, where ? `${where}.${key}` : key);
  }
  // Additions and removals apply to the list as it stands after plain keys, additions first.
  for (const { name, add, items } of edits.sort((a, b) => Number(b.add) - Number(a.add))) {
    const list = out[name] ?? [];
    if (!Array.isArray(list)) {
      throw new Error(`"${where ? `${where}.` : ''}${name}${add ? '+' : '-'}" changes a list, but "${name}" is not a list`);
    }
    out[name] = add
      ? [...list, ...items.filter((item) => !list.some((have) => same(have, item)))]
      : list.filter((have) => !items.some((item) => same(have, item)));
  }
  return out;
}

const nameOf = (entry) => String(entry?.name || '').trim().toLowerCase();

/**
 * Your companies.yml adds to the built-in list:
 *   companies:  entries of your own; one with a built-in company's name replaces that entry
 *   skip:       names of built-in companies you do not want read
 */
export function mergeCompanies(base, own) {
  const builtIn = Array.isArray(base?.companies) ? base.companies : [];
  const mine = Array.isArray(own?.companies) ? own.companies : [];
  const skip = new Set((Array.isArray(own?.skip) ? own.skip : []).map((name) => String(name).trim().toLowerCase()));
  const replaced = new Set(mine.map(nameOf));
  const kept = builtIn.filter((entry) => !skip.has(nameOf(entry)) && !replaced.has(nameOf(entry)));
  return {
    companies: [...kept, ...mine],
    counts: { builtIn: kept.length, yours: mine.length, skipped: builtIn.length - kept.length },
  };
}

function readYaml(path) {
  if (!existsSync(path)) return undefined;
  try {
    return parse(readFileSync(path, 'utf8')) ?? {};
  } catch (err) {
    throw new Error(`cannot read ${path}: ${String(err.message).split('\n')[0]}`);
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.home] folder with your own settings in config/ (default: your data folder)
 * @param {string} [options.builtIn] folder with the built-in settings
 * @returns {{ profile: object, sources: object, companies: { companies: object[], counts: object }, files: Record<string, { builtIn: string, yours: string, hasYours: boolean }> }}
 */
export function loadConfig({ home = homeDir(), builtIn = BUILT_IN_CONFIG_DIR } = {}) {
  const files = {};
  const layers = (name) => {
    const yours = join(configDir(home), name);
    const own = readYaml(yours);
    files[name] = { builtIn: join(builtIn, name), yours, hasYours: own !== undefined };
    return { base: readYaml(join(builtIn, name)) ?? {}, own };
  };
  const merged = (name) => {
    const { base, own } = layers(name);
    try {
      return overlay(base, own);
    } catch (err) {
      throw new Error(`${files[name].yours}: ${err.message}`);
    }
  };
  const profile = merged('profile.yml');
  const sources = merged('sources.yml');
  const { base, own } = layers('companies.yml');
  return { profile, sources, companies: mergeCompanies(base, own), files };
}

/**
 * Create your settings files from the templates. A file that exists is left alone.
 * @returns {{ path: string, created: boolean }[]}
 */
export function initHome({ home = homeDir(), templates = TEMPLATE_DIR } = {}) {
  mkdirSync(configDir(home), { recursive: true });
  return FILES.map((name) => {
    const path = join(configDir(home), name);
    if (existsSync(path)) return { path, created: false };
    writeFileSync(path, readFileSync(join(templates, name), 'utf8'));
    return { path, created: true };
  });
}

const quoted = (doc, value) => {
  const node = doc.createNode(value);
  if (isScalar(node) && typeof value === 'string') node.type = Scalar.QUOTE_DOUBLE;
  return node;
};

/** One company as a one-line entry, strings quoted like the built-in file. */
function entryNode(doc, entry) {
  const node = doc.createNode({});
  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    node.set(key, ['name', 'slug', 'url', 'location', 'link_pattern'].includes(key) ? quoted(doc, value) : value);
  }
  node.flow = true;
  return node;
}

/**
 * Add companies to your companies.yml, keeping whatever is already written there.
 * @returns {string} the file that was written
 */
export function addCompanies(entries, { home = homeDir(), templates = TEMPLATE_DIR } = {}) {
  const path = join(configDir(home), 'companies.yml');
  const doc = parseDocument(readFileSync(existsSync(path) ? path : join(templates, 'companies.yml'), 'utf8'));
  if (doc.errors.length) throw new Error(`cannot read ${path}: ${doc.errors[0].message.split('\n')[0]}`);
  if (doc.contents !== null && !isYamlMap(doc.contents)) throw new Error(`${path} must hold "companies:" and, if you like, "skip:"`);
  let list = doc.contents === null ? undefined : doc.get('companies');
  if (!isSeq(list)) {
    list = doc.createNode([]);
    list.flow = false;
    doc.set('companies', list);
  }
  for (const entry of entries) list.add(entryNode(doc, entry));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, doc.toString({ lineWidth: 0 }));
  return path;
}
