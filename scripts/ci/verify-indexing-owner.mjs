#!/usr/bin/env node
/**
 * Verify the Search Console owner used by the Indexing API without publishing.
 *
 * The metadata endpoint is read-only: HTTP 200 (already notified) and 404
 * (never notified) both prove that Google accepts the identity as an owner.
 * HTTP 403 and every other response are failures and never reach publish.
 *
 * Usage:
 *   node scripts/ci/verify-indexing-owner.mjs [--url <https-url>]
 */

import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import {
  DEFAULT_OWNER_PROBE_URL,
  resolveOwnerToken,
} from '../lib/indexing-owner.mjs';

export function parseArgs(argv) {
  const args = { probeUrl: DEFAULT_OWNER_PROBE_URL };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let rawUrl;
    if (arg === '--url') rawUrl = argv[++i];
    else if (arg.startsWith('--url=')) rawUrl = arg.slice('--url='.length);
    else throw new Error(`unknown argument: ${arg}`);
    if (!rawUrl) throw new Error('--url requires a value');

    let url;
    try { url = new URL(rawUrl); } catch { throw new Error('--url must be a valid HTTPS URL'); }
    if (url.protocol !== 'https:') throw new Error('--url must use HTTPS');
    if (url.hostname !== 'frontaliereticino.ch') throw new Error('--url must belong to https://frontaliereticino.ch');
    args.probeUrl = url.href;
  }
  return args;
}

export async function verifyIndexingOwner({ probeUrl = DEFAULT_OWNER_PROBE_URL, resolve = resolveOwnerToken } = {}) {
  return Boolean(await resolve(probeUrl));
}

export async function main(argv = process.argv.slice(2)) {
  const { probeUrl } = parseArgs(argv);
  const ok = await verifyIndexingOwner({ probeUrl });
  if (!ok) {
    console.error(`❌ No Search Console owner accepted the read-only metadata probe for ${probeUrl}`);
    return 1;
  }
  console.log(`✅ Search Console owner verified for ${probeUrl}; metadata probe was 200/404 and no publish was attempted`);
  return 0;
}

if (isInvokedDirectly(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`❌ indexing owner probe failed: ${error?.message || error}`);
      process.exitCode = 1;
    });
}
