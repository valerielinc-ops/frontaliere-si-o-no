#!/usr/bin/env node

import { checkJobPostingEmitterCensus } from './jobposting-emitter-census.mjs';

const result = checkJobPostingEmitterCensus(process.cwd());

if (result.failures.length > 0) {
  console.error('❌ JobPosting emitter census failed:');
  for (const failure of result.failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `✓ JobPosting emitter census v${result.manifestVersion}: `
  + `${result.emitterCount}/${result.discoveredSourceCount} public paths use a canonical builder `
  + `(${result.staticEmitterCount} static, ${result.runtimeEmitterCount} runtime).`,
);
