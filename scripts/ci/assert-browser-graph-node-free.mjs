#!/usr/bin/env node

/**
 * Stable CI entry point for the browser-graph invariant from #8130.
 *
 * The graph walker is shared with the more verbose diagnostic command; this
 * wrapper keeps the issue's documented command stable without maintaining a
 * second implementation of module resolution.
 */
import { measureBrowserGraph } from './check-browser-bundle-node-imports.mjs';

const result = measureBrowserGraph();
console.log(`moduli raggiunti dall'entry SPA: ${result.moduleCount}`);
console.log(`foglie con import Node: ${result.leaves.length}`);

for (const leaf of result.leaves) {
  console.error(`\n${leaf.file} -> ${leaf.builtins.join(', ')}`);
  console.error(`catena: ${leaf.chain.join(' -> ')}`);
}

process.exitCode = result.leaves.length === 0 ? 0 : 1;
