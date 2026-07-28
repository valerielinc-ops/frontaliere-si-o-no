#!/usr/bin/env node
/**
 * generate-llms-txt.mjs — standalone CLI for the llms.txt/llms-full.txt
 * family generator, runnable OUTSIDE a full Vite build (issue #4881 Fase 3,
 * pushable-origin fast-publish). One implementation, two callers:
 *   - build-plugins/llmsTxtPlugin.ts   (full Vite build, writes into dist/)
 *   - this script                      (fast-publish path, writes into a
 *                                        scratch --out dir it seeds itself)
 * Shared logic: scripts/lib/llms-txt-generator.mjs (generateLlmsTxtFamily).
 *
 * Usage:
 *   npx -y tsx@4 scripts/generate-llms-txt.mjs --root <repoRoot> --out <scratchDir>
 *
 * --out is created if missing and PRE-SEEDED with a fresh copy of
 * public/llms.txt + public/llms-full.txt before the shared generator runs —
 * replicating Vite's own "publicDir copy happens before closeBundle"
 * sequencing (see llmsTxtPlugin.ts). public/llms.txt itself is NEVER
 * written to: the generator's placeholder-substitution scheme (date,
 * article/job counts) is only idempotent if its input is always the
 * pristine seed, never a previously-patched output — patching in place
 * would compound substitutions on every run.
 *
 * The fast-publish workflow does not run a full jobs-dataset assemble
 * (cost-avoidance is the point of that pipeline — no `npm ci`), so
 * <out>/data/jobs.json will not exist; generateLlmsTxtFamily's own
 * fs.existsSync guard already handles that gracefully (job-board stats
 * simply keep their prior static values, no special-casing needed here).
 */
import fs from 'node:fs';
import path from 'node:path';
import { generateLlmsTxtFamily } from './lib/llms-txt-generator.mjs';

function parseArgs(argv) {
  const args = { root: process.cwd(), out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') args.root = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  if (!args.out) {
    console.error('Usage: generate-llms-txt.mjs --root <repoRoot> --out <scratchDir>');
    process.exit(1);
  }
  return args;
}

const { root, out } = parseArgs(process.argv.slice(2));
const rootDir = path.resolve(root);
const publicDir = path.join(rootDir, 'public');
const distDir = path.resolve(out);

fs.mkdirSync(distDir, { recursive: true });
for (const seed of ['llms.txt', 'llms-full.txt']) {
  const src = path.join(publicDir, seed);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(distDir, seed));
}

await generateLlmsTxtFamily({ rootDir, publicDir, distDir });
console.log(`[generate-llms-txt] wrote family into ${distDir}`);
