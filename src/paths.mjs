// Two folders, kept apart on purpose:
//
//   the code    this clone, or the copy Claude Code installs as a plugin. An
//               update replaces it, so nothing of yours is kept here.
//   your data   your own settings, what was already reported, and the reports:
//               ~/job-radar-data, or wherever JOB_RADAR_HOME points.

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The settings that ship with the code. Yours are laid over them (see config.mjs). */
export const BUILT_IN_CONFIG_DIR = join(CODE_DIR, 'config');

/** Starting points for your own settings files; "init" copies them into your data folder. */
export const TEMPLATE_DIR = join(CODE_DIR, 'templates');

/** Folder for everything that is yours. */
export function homeDir(env = process.env) {
  const set = String(env.JOB_RADAR_HOME || '').trim();
  const dir = set ? resolve(set.replace(/^~(?=$|[\\/])/, homedir())) : join(homedir(), 'job-radar-data');
  if (dir === CODE_DIR) {
    throw new Error('JOB_RADAR_HOME points at the code folder, which an update replaces. Choose another folder for your settings and results.');
  }
  return dir;
}

export const configDir = (home = homeDir()) => join(home, 'config');
export const stateDir = (home = homeDir()) => join(home, 'state');
export const outDir = (home = homeDir()) => join(home, 'out');
