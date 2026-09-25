#!/usr/bin/env node
/**
 * log-correction.mjs — Append a correction entry to data/corrections-log.json.
 *
 * Usage:
 *   node scripts/log-correction.mjs <articleId> <type> "<description>"
 *
 * Example:
 *   node scripts/log-correction.mjs frontaliere-2026-tax-changes factual \
 *     "Aliquota imposta alla fonte aggiornata da 9% a 8% (fonte: AFC tabella 2026)"
 *
 * Constraints:
 *   - <type> must be one of the accepted types listed in policy.types
 *   - <description> should be concise (one sentence describing what changed
 *     and citing the source where applicable)
 *   - Writes JSON with stable 2-space indentation + trailing newline so
 *     diffs stay clean across appends
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG_PATH = path.join(REPO_ROOT, 'data', 'corrections-log.json');

function fail(msg) {
  process.stderr.write(`[log-correction] ${msg}\n`);
  process.exit(1);
}

function usage() {
  process.stderr.write(
    'Usage: node scripts/log-correction.mjs <articleId> <type> "<description>"\n' +
      '  <type> — one of: factual | typo | clarification\n',
  );
  process.exit(1);
}

const [, , articleId, type, ...descParts] = process.argv;

if (!articleId || !type || descParts.length === 0) {
  usage();
}

const description = descParts.join(' ').trim();
if (!description) {
  fail('Description must not be empty.');
}

if (!/^[a-z0-9][a-z0-9-_/]*$/i.test(articleId)) {
  fail(
    `articleId "${articleId}" looks suspicious — expected slug-like identifier (letters, digits, hyphens, slashes).`,
  );
}

let log;
try {
  const raw = fs.readFileSync(LOG_PATH, 'utf-8');
  log = JSON.parse(raw);
} catch (err) {
  fail(`Could not read ${LOG_PATH}: ${err.message}`);
}

if (!log || typeof log !== 'object' || !Array.isArray(log.entries)) {
  fail('corrections-log.json is malformed — expected { version, policy, entries }.');
}

const acceptedTypes = log?.policy?.types ?? ['factual', 'typo', 'clarification'];
if (!acceptedTypes.includes(type)) {
  fail(
    `Invalid type "${type}". Accepted types: ${acceptedTypes.join(', ')}. ` +
      'See data/corrections-log.json policy.types.',
  );
}

const entry = {
  date: new Date().toISOString(),
  articleId,
  type,
  description,
};

const next = {
  ...log,
  entries: [...log.entries, entry],
};

const serialised = JSON.stringify(next, null, 2) + '\n';

try {
  fs.writeFileSync(LOG_PATH, serialised, 'utf-8');
} catch (err) {
  fail(`Could not write ${LOG_PATH}: ${err.message}`);
}

process.stdout.write(
  `[log-correction] Appended entry to corrections-log.json:\n` +
    `  date:        ${entry.date}\n` +
    `  articleId:   ${entry.articleId}\n` +
    `  type:        ${entry.type}\n` +
    `  description: ${entry.description}\n` +
    `Total entries: ${next.entries.length}\n`,
);
