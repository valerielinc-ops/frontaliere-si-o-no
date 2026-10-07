#!/usr/bin/env node

import { generateEventImageLibrary, MAX_LIBRARY_GENERATIONS } from './lib/generated-image-engine.mjs';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const limit = Number(argument('--limit', '20'));
if (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIBRARY_GENERATIONS) {
  console.error(`--limit must be an integer between 0 and ${MAX_LIBRARY_GENERATIONS}`);
  process.exit(2);
}

const registryPath = argument('--registry', 'data/event-image-library.json');
const outputDir = argument('--output-dir', '.cache/event-image-library');
const provider = argument('--provider', 'auto');
const chain = argument('--chain', '');
const requestedProviders = chain || provider;
const kind = argument('--kind', ['wikimedia', 'pexels', 'pixabay'].includes(requestedProviders.split(/[,\s]+/)[0]) ? 'photo' : 'generated');

try {
  const result = await generateEventImageLibrary({
    registryPath,
    outputDir,
    limit,
    provider,
    chain: chain || undefined,
    kind,
    onAssetGenerated: ({ record, generatedCount, providerCounts, providerFailures }) => {
      console.error(`Verified ${generatedCount} asset(s): ${record.assetId} ← ${record.provider}/${record.model}; attempts ${JSON.stringify(providerCounts)}.`);
    },
  });
  console.error(`Generated ${result.generated.length} event-library asset(s); registry now contains ${result.registry.assets.length}.`);
  console.error(`Provider attempts: ${JSON.stringify(result.providerCounts)} (${result.generationCalls}/${MAX_LIBRARY_GENERATIONS} budget).`);
  if (Object.keys(result.providerFailures || {}).length) console.error(`Provider diagnostics: ${JSON.stringify(result.providerFailures)}.`);
  for (const item of result.generated) console.error(`  ${item.record.assetId} ← ${item.record.provider}/${item.record.model}`);
} catch (error) {
  console.error(`Event image library generation failed: ${error.message}`);
  process.exit(1);
}
