#!/usr/bin/env node
// job-radar: scan Czech job boards, international search sources and company
// career sites; score every listing against a search profile; report what is
// new; hand the strong fits to career-ops.
//
// This file only checks the setup, so a copy without its dependency (a new
// clone before "npm install") answers with one instruction instead of a stack
// trace. The commands are in src/cli.mjs.

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const major = Number(process.versions.node.split('.')[0]);

if (major < 20) {
  console.error(`job-radar needs Node 20 or newer; this is ${process.versions.node}.`);
  process.exit(1);
}

try {
  createRequire(import.meta.url).resolve('yaml');
} catch {
  console.error(`job-radar is not set up in this folder yet: its one dependency is missing. Run:\n\n  npm install --omit=dev --prefix "${here}"\n`);
  process.exit(1);
}

await import('./src/cli.mjs');
