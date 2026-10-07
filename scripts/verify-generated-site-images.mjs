#!/usr/bin/env node

import path from 'node:path';
import { verifyPublishedGeneratedSiteImages } from './lib/generated-site-images.mjs';

const result = await verifyPublishedGeneratedSiteImages({
  rootDir: process.cwd(),
  registryPath: process.argv.includes('--registry')
    ? process.argv[process.argv.indexOf('--registry') + 1]
    : path.join('data', 'generated-image-registry.json'),
});

if (!result.valid) {
  console.error(`Generated site image gate failed with ${result.errors.length} error(s):`);
  for (const error of result.errors.slice(0, 100)) console.error(`- ${error}`);
  process.exit(1);
}

console.error(`Generated site image gate passed: ${result.records.length} registered files.`);
