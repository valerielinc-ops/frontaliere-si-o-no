#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stripDescriptionTranslationCache } from '../lib/event-description-policy.mjs';

const cachePath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../data/events-translation-cache.json');
if (!existsSync(cachePath)) {
  console.log(JSON.stringify({ removed: 0, status: 'missing' }));
  process.exit(0);
}

const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
const removed = stripDescriptionTranslationCache(cache);
if (removed > 0) writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
console.log(JSON.stringify({ removed, status: 'ok' }));
