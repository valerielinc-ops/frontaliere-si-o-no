#!/usr/bin/env node

import path from 'node:path';
import { repairCompatManifest } from '../lib/compat-paths-store.mjs';

const rootDir = path.resolve(process.argv[2] || process.cwd());
const result = repairCompatManifest(rootDir);

if (result.changed) {
  console.log(
    `[compat-paths-store] repaired stale manifest count ${result.previousTotalPaths} → `
      + `${result.totalPaths} from validated shards`,
  );
} else if (result.totalPaths !== null) {
  console.log(`[compat-paths-store] manifest already matches ${result.totalPaths} validated shard paths`);
} else {
  console.log('[compat-paths-store] no sharded compatibility store present; no manifest repair needed');
}
