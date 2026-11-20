// What the radar remembers between runs, in your data folder (see paths.mjs):
//   state/jobs.json     every match it has reported (so a later run shows only new ones)
//   state/details/      job page texts, kept 14 days so a rerun does not refetch them
//   state/runs.json     per-source result of recent runs

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { stateDir } from './paths.mjs';

const detailDir = () => join(stateDir(), 'details');
const DETAIL_TTL_MS = 14 * 86_400_000;

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1));
  renameSync(tmp, path);
}

export function loadState() {
  const dir = stateDir();
  const jobs = readJson(join(dir, 'jobs.json'), {});
  const runs = readJson(join(dir, 'runs.json'), []);
  return {
    jobs,
    runs,
    save() {
      writeJson(join(dir, 'jobs.json'), jobs);
      writeJson(join(dir, 'runs.json'), runs.slice(-30));
    },
  };
}

/** A small JSON file of the radar's own in state/ (the companies it found, the lookups it made). */
export const readStateFile = (name, fallback) => readJson(join(stateDir(), name), fallback);
export const writeStateFile = (name, value) => writeJson(join(stateDir(), name), value);

const detailPath = (key) => join(detailDir(), `${createHash('sha1').update(key).digest('hex')}.json`);

/** Cached job page fields, or null when missing or older than 14 days. */
export function readDetail(key, now = Date.now()) {
  const cached = readJson(detailPath(key), null);
  if (!cached || now - cached.fetchedAt > DETAIL_TTL_MS) return null;
  return cached.detail;
}

export function writeDetail(key, detail, now = Date.now()) {
  writeJson(detailPath(key), { key, fetchedAt: now, detail });
}

/** Remove cached job pages that have expired. */
export function pruneDetails(now = Date.now()) {
  const dir = detailDir();
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (now - statSync(path).mtimeMs > DETAIL_TTL_MS * 2) { unlinkSync(path); removed += 1; }
  }
  return removed;
}
