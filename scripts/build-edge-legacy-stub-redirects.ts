/**
 * Regenerate infra/cloudflare-worker/legacy-stub-redirects.generated.mjs from
 * legacyRedirectsPlugin's static map (see build-plugins/shared/edgeLegacyStubRedirects.ts).
 *
 *   npx tsx scripts/build-edge-legacy-stub-redirects.ts           # write
 *   npx tsx scripts/build-edge-legacy-stub-redirects.ts --check   # exit 1 on drift
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildEdgeLegacyStubRedirects,
  renderEdgeLegacyStubModule,
  EDGE_LEGACY_STUB_MODULE_PATH,
} from '../build-plugins/shared/edgeLegacyStubRedirects';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, EDGE_LEGACY_STUB_MODULE_PATH);
const table = buildEdgeLegacyStubRedirects(root);
const next = renderEdgeLegacyStubModule(table);
const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf-8') : '';

if (process.argv.includes('--check')) {
  if (current !== next) {
    console.error(`${EDGE_LEGACY_STUB_MODULE_PATH} is stale — run: npx tsx scripts/build-edge-legacy-stub-redirects.ts`);
    process.exit(1);
  }
  console.log(`${EDGE_LEGACY_STUB_MODULE_PATH} up to date (${Object.keys(table).length} entries)`);
} else {
  fs.writeFileSync(out, next);
  console.log(`wrote ${EDGE_LEGACY_STUB_MODULE_PATH} (${Object.keys(table).length} entries)`);
}
