#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

export function listLiveShardSections({ root = process.cwd(), env = process.env, excludeBuildSkipped = false } = {}) {
  const slugs = JSON.parse(fs.readFileSync(path.join(root, 'scripts/lib/section-shard-slugs.json'), 'utf8'));
  return Object.keys(slugs).filter((section) => {
    const key = `${section.replace(/[^a-z0-9]+/giu, '_').toUpperCase()}_SHARD_LIVE`;
    if (String(env[key] ?? '').toLowerCase() !== 'true') return false;
    if (excludeBuildSkipped && section === 'articolifrontaliere'
        && String(env.ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP ?? '').toLowerCase() === 'true') return false;
    if (excludeBuildSkipped && section === 'articolisvizzera'
        && String(env.ARTICOLISVIZZERA_BUILD_EMIT_SKIP ?? '').toLowerCase() === 'true') return false;
    return true;
  }).sort();
}

if (isInvokedDirectly(import.meta.url)) {
  console.log(listLiveShardSections({ excludeBuildSkipped: process.argv.includes('--exclude-build-skipped') }).join(','));
}
