#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSocialCopyPack, SOCIAL_COPY_PROMPT_VERSION } from '../lib/social-copy-pack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function argument(name, fallback = '') {
  const item = process.argv.slice(2).find((value) => value.startsWith('--' + name + '='));
  return item ? item.slice(name.length + 3) : fallback;
}

function requireArgument(name) {
  const value = argument(name);
  if (!value) throw new Error('missing --' + name + '=...');
  return value;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, file);
}

async function main() {
  const command = process.argv[2];
  if (!['validate', 'promote'].includes(command)) {
    throw new Error('usage: node scripts/social-copy/pack.mjs <validate|promote> --input=<json> [--output=<json>] [--generated-at=<ISO>]');
  }
  const input = requireArgument('input');
  const raw = readJson(input);
  const generatedAt = argument('generated-at', new Date().toISOString());
  const pack = normalizeSocialCopyPack(raw, { generatedAt });
  if (command === 'promote') {
    const output = argument('output', path.join(ROOT, 'data', 'social-copy-packs', 'current.json'));
    writeJsonAtomic(output, pack);
    process.stdout.write('Promoted validated social copy pack ' + pack.packId + ' (' + SOCIAL_COPY_PROMPT_VERSION + ')\n');
    return;
  }
  process.stdout.write('Valid social copy pack (' + SOCIAL_COPY_PROMPT_VERSION + '); ' + pack.packId + '\n');
}

main().catch((error) => {
  process.stderr.write('Social copy pack rejected: ' + error.message + '\n');
  process.exitCode = 1;
});
