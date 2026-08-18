#!/usr/bin/env node
/**
 * Precompute the per-comune evergreen topics and publish them as data.
 *
 * The article generator needs a few hundred long-tail keywords of the shape
 * "vivere a X e lavorare in Y da frontaliere" (446 as of 2026-08-18; it was 85
 * until the per-canton count cap became a commute-distance cap). Deriving them takes four site datasets —
 * municipalities, border crossings, the crossing slugs and the wait averages —
 * because the canton is assigned by geographic proximity. Those datasets have
 * 20+ and 25+ consumers in the site respectively; they are site core and cannot
 * move to the articles repo.
 *
 * So the calculation stays where the data is, and only the RESULT travels.
 * The output is small and changes only when the comune dataset changes, which
 * is rare. This is what lets the generator stop importing site data (#4974
 * item 3) without either duplicating the datasets — which would drift — or
 * dropping the topics.
 *
 * Run: node scripts/build-evergreen-comune-topics.mjs [--check]
 *   --check verifies the committed file matches what the data produces now,
 *   and exits non-zero if it does not. Use it in CI; it is how the file is
 *   kept from going stale silently.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'evergreen-comune-topics.json');

// The topic builder and the municipality dataset are TypeScript-adjacent
// (extensionless relative specifiers, .ts data), so they are loaded through tsx
// in a child process rather than imported here. Keeps this file plain Node.
const LOADER = `
import { buildComuneEvergreenTopics } from ${JSON.stringify(path.join(ROOT, 'scripts/lib/evergreen-topic-generator.mjs'))};
import { MUNICIPALITIES } from ${JSON.stringify(path.join(ROOT, 'data/municipalities'))};
process.stdout.write(JSON.stringify(buildComuneEvergreenTopics(MUNICIPALITIES)));
`;

function computeTopics() {
  const tmp = path.join(ROOT, `.evergreen-topics-${process.pid}.mts`);
  fs.writeFileSync(tmp, LOADER);
  try {
    const raw = execFileSync('npx', ['-y', 'tsx@4', tmp], {
      cwd: ROOT,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(raw);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function main() {
  const check = process.argv.includes('--check');
  const topics = computeTopics();

  // A collapse here would silently strip the generator's evergreen pool, and
  // an empty pool is not a visible failure — it just quietly narrows what gets
  // written. Refuse rather than publish it.
  //
  // Floor raised 50 -> 300 on 2026-08-18, with the reader's twin in
  // scripts/lib/evergreen-topic-generator.mjs: 50 was ~59% of the 85 topics
  // this produced when it was written, and only 11% of the 437 it produces
  // now. A floor that covers 11% is not a tripwire.
  if (!Array.isArray(topics) || topics.length < 300) {
    console.error(`::error::expected at least 300 comune topics, got ${topics?.length ?? 0} — refusing to write`);
    process.exit(1);
  }

  const payload = `${JSON.stringify({ generatedFrom: 'data/municipalities.ts', count: topics.length, topics }, null, 2)}\n`;

  if (check) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf-8') : '';
    if (current !== payload) {
      console.error('::error::public/evergreen-comune-topics.json is stale — run node scripts/build-evergreen-comune-topics.mjs');
      process.exit(1);
    }
    console.log(`evergreen-comune-topics.json up to date (${topics.length} topics)`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, payload);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${topics.length} topics)`);
}

main();
