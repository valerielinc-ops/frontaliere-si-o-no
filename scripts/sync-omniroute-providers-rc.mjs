#!/usr/bin/env node
/**
 * One-shot (local-only): decrypt this machine's local OmniRoute provider
 * connections (~/.omniroute/storage.sqlite) and publish the apikey-type ones
 * to Firebase Remote Config as a single JSON blob, so CI's OmniRoute
 * instance can register the full provider set instead of the small
 * hardcoded 4 in scripts/ci/omniroute-poc-register.mjs.
 *
 * Local sqlite file never leaves this machine — only the decrypted
 * {provider, name, apiKey} tuples for connections with a real key and
 * test_status='active' are published (pass --include-all to also publish
 * error/expired/unknown connections; default skips them since CI has no use
 * for keys already known-dead).
 *
 * Free-tier providers ONLY (2026-07-29): the payload is filtered through
 * OMNIROUTE_FREE_PROVIDERS (scripts/lib/omniroute-free-providers.mjs, shared
 * with the CI registrar), so paid-account keys never reach Remote Config in
 * the first place. Pass --include-paid to publish everything anyway.
 *
 * OAuth-type connections (github, antigravity, kilocode) are session/device
 * bound — no portable credential to sync, always excluded.
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS -> Firebase SA (Remote Config Admin).
 * Env:  STORAGE_ENCRYPTION_KEY (from ~/.omniroute/.env — same key OmniRoute
 *       itself uses to encrypt api_key at rest, AES-256-GCM).
 */
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getRemoteConfig, fetchRcTemplate, stageRcParam, publishRcTemplate } from './lib/remote-config-admin.mjs';
import { resolveOmniRouteAllowlist } from './lib/omniroute-free-providers.mjs';

const DB_PATH = process.env.OMNIROUTE_DB_PATH || path.join(os.homedir(), '.omniroute', 'storage.sqlite');
const STORAGE_KEY = process.env.STORAGE_ENCRYPTION_KEY;
const INCLUDE_ALL = process.argv.includes('--include-all');

if (!STORAGE_KEY) {
  console.error('❌ STORAGE_ENCRYPTION_KEY missing in env (see ~/.omniroute/.env on the OmniRoute host).');
  process.exit(1);
}

// Same enc:v1:<ivHex>:<ciphertextHex>:<authTagHex> AES-256-GCM scheme
// OmniRoute uses to encrypt api_key at rest (reverse-engineered from its
// bundled server source; key derivation: scrypt(STORAGE_ENCRYPTION_KEY,
// "omniroute-field-encryption-v1", 32)).
function decryptApiKey(enc) {
  const parts = String(enc).split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') return null;
  const [, , ivHex, ciphertextHex, authTagHex] = parts;
  try {
    const key = crypto.scryptSync(STORAGE_KEY, 'omniroute-field-encryption-v1', 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8');
  } catch (e) {
    console.warn(`  ⚠️  decrypt failed: ${e.message}`);
    return null;
  }
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const statusFilter = INCLUDE_ALL ? '' : `AND test_status = 'active'`;
const rows = db.prepare(
  `SELECT provider, name, api_key, test_status FROM provider_connections
   WHERE auth_type = 'apikey' AND api_key IS NOT NULL AND api_key != '' ${statusFilter}
   ORDER BY provider, name`
).all();
db.close();

// Same free-only allowlist the CI registrar applies, from the shared module so
// the two cannot drift (AGENTS.md #6). Filtering here as well is not
// redundant: it keeps paid-account API keys OUT of Remote Config entirely
// rather than publishing them and declining to use them downstream — smaller
// blast radius if the RC value ever leaks. Pass --include-paid to publish the
// full set anyway (the registrar still filters unless overridden there too).
const INCLUDE_PAID = process.argv.includes('--include-paid');
// Honours OMNIROUTE_PROVIDER_ALLOWLIST exactly like the CI registrar does:
// hardcoding `undefined` here would mean the same env var widened the
// downstream gate while leaving this one on the built-in list, so the two
// halves of one control would disagree.
const { allowlist, filteringOff, malformed } = resolveOmniRouteAllowlist(process.env.OMNIROUTE_PROVIDER_ALLOWLIST);
if (malformed) {
  console.warn(`⚠️  OMNIROUTE_PROVIDER_ALLOWLIST="${process.env.OMNIROUTE_PROVIDER_ALLOWLIST}" has separators but no provider names — treating as misconfigured, keeping the built-in free list (use "" to disable filtering).`);
}

const payload = [];
const excludedPaid = [];
let failed = 0;
for (const row of rows) {
  // `filteringOff` must be honoured here too, not just `allowlist`: with the
  // override set to "" the allowlist is EMPTY, so testing membership alone
  // would exclude every connection and abort with "Nothing to publish" —
  // precisely when the operator asked to publish everything.
  if (!INCLUDE_PAID && !filteringOff && !allowlist.has(row.provider)) { excludedPaid.push(row.provider); continue; }
  const apiKey = decryptApiKey(row.api_key);
  if (!apiKey) { failed++; continue; }
  payload.push({ provider: row.provider, name: row.name || row.provider, apiKey });
}

if (failed > 0) console.warn(`⚠️  ${failed} connection(s) failed to decrypt — skipped.`);
if (excludedPaid.length) {
  console.log(`🆓 Free-only: excluded ${excludedPaid.length} non-allowlisted connection(s) — ${[...new Set(excludedPaid)].sort().join(', ')}`);
} else if (INCLUDE_PAID) {
  console.warn('⚠️  --include-paid: publishing EVERY connection, paid accounts included.');
}
if (payload.length === 0) {
  console.error('❌ Nothing to publish (0 decryptable apikey connections matched the filter).');
  process.exit(1);
}

const json = JSON.stringify(payload);
console.log(`🔓 Decrypted ${payload.length} provider connection(s) (${INCLUDE_ALL ? 'all statuses' : 'active only'}).`);

const rc = await getRemoteConfig();
const template = await fetchRcTemplate(rc);
const today = new Date().toISOString().slice(0, 10);
const changed = stageRcParam(
  template,
  'OMNIROUTE_PROVIDERS_JSON',
  json,
  `OmniRoute provider connections (decrypted from local storage.sqlite; ${payload.length} entries; set ${today})`
) ? 1 : 0;

if (changed === 0) {
  console.log('ℹ️  OMNIROUTE_PROVIDERS_JSON already up-to-date in Remote Config. Nothing published.');
  process.exit(0);
}
await publishRcTemplate(rc, template, changed);
console.log(`✅ Published OMNIROUTE_PROVIDERS_JSON to Remote Config (${payload.length} providers, ${Math.round(json.length / 1024)}KB).`);
