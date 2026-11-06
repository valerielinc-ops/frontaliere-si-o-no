#!/usr/bin/env node
/**
 * Replay of the Google Cloud tier under a project rate limit: how many HTTP
 * requests the tier sends for a stream of texts while every request is refused
 * `403 userRateLimitExceeded`. No network: `fetch` is a stub, the clock is
 * simulated.
 *
 * Default parameters are the Phase 2e numbers of translate-pending run
 * 37272320066 (corpus, 2026-10-05): 2270 texts refused, about 0.86 s between
 * two texts (2271 calls in ~33 minutes).
 *
 *   node scripts/research/google-cloud-quota-replay.mjs [--module <free-translate.mjs>] \
 *     [--texts 2270] [--gap-ms 860] [--accept-every 0]
 *
 * `--accept-every N` lets one request in N succeed (0 = never), to replay a
 * limit that opens now and then. Prints one JSON line.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function opt(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const modulePath = path.resolve(opt('--module', new URL('../lib/free-translate.mjs', import.meta.url).pathname));
const texts = Number(opt('--texts', '2270'));
const gapMs = Number(opt('--gap-ms', '860'));
const acceptEvery = Number(opt('--accept-every', '0'));

process.env.GOOGLE_APPLICATION_CREDENTIALS = '';
process.env.GSC_CLIENT_ID = 'replay';
process.env.GSC_CLIENT_SECRET = 'replay';
process.env.GSC_REFRESH_TOKEN = 'replay';

let now = 1_700_000_000_000;
Date.now = () => now;
let requests = 0;
let accepted = 0;
const QUOTA = JSON.stringify({ error: { code: 403, message: 'User Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } });
globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.startsWith('https://oauth2.googleapis.com/token')) {
    return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 * 24 }), text: async () => '' };
  }
  requests += 1;
  if (acceptEvery > 0 && requests % acceptEvery === 0) {
    accepted += 1;
    return { ok: true, status: 200, json: async () => ({ data: { translations: [{ translatedText: 'ok' }] } }), text: async () => '' };
  }
  return { ok: false, status: 403, json: async () => JSON.parse(QUOTA), text: async () => QUOTA };
};

const { translateWithGoogleCloud } = await import(pathToFileURL(modulePath).href);
for (let i = 0; i < texts; i++) {
  await translateWithGoogleCloud(`Testo numero ${i} da tradurre`, 'it', 'en');
  now += gapMs;
}
console.log(JSON.stringify({ module: path.basename(modulePath), texts, gapMs, acceptEvery, requests, accepted }));
