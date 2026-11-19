#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  validateEventImageRegistryForPublishedEvents,
  verifyPublishedEventImages,
} from '../packages/articles/engine/shared/generatedImageRegistry.mjs';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const eventsPath = path.resolve(argument('--events', 'data/events.json'));
const registryPath = path.resolve(argument('--registry', 'data/event-image-library.json'));
const eventsDoc = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const errors = [];
const events = eventsDoc.events || [];
const registryValidation = validateEventImageRegistryForPublishedEvents(events, registry);
if (!registryValidation.valid) errors.push(...registryValidation.errors);
const eventResult = verifyPublishedEventImages(events, registry);
errors.push(...eventResult.errors);
if (errors.length) {
  console.error(`Event image gate failed with ${errors.length} error(s):`);
  for (const error of errors.slice(0, 100)) console.error(`- ${error}`);
  process.exit(1);
}
console.error(`Event image gate passed: ${registry.assets?.length || 0} registry records, ${events.length} events.`);
