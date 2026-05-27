#!/usr/bin/env node
/**
 * One-off AdSense slot audit.
 *
 * Compares the ad-unit IDs declared in services/adsenseSlots.ts against the
 * live AdSense account. Reports:
 *   - slots in code but missing / archived in AdSense
 *   - slots live in AdSense but not referenced in code (candidates for cleanup)
 *
 * Auth flow: uses mcp-gsc-main/client_secret.json and a one-shot localhost
 * OAuth redirect on port 3456 (already whitelisted in the client secret).
 * Caches the refresh token at .cache/adsense-oauth.json so subsequent runs
 * skip the browser step.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { URL } from 'node:url';
import { exec } from 'node:child_process';
import path from 'node:path';

const ROOT = process.cwd();
const CLIENT_SECRET_PATH = path.join(ROOT, 'mcp-gsc-main/client_secret.json');
const TOKEN_CACHE = path.join(ROOT, '.cache/adsense-oauth.json');
const SLOTS_PATH = path.join(ROOT, 'services/adsenseSlots.ts');
const SCOPE = 'https://www.googleapis.com/auth/adsense';
const REDIRECT = 'http://localhost:3456/callback';
const PORT = 3456;

function loadClientSecret() {
  const raw = JSON.parse(readFileSync(CLIENT_SECRET_PATH, 'utf8'));
  return raw.web || raw.installed;
}

function loadCachedToken() {
  if (!existsSync(TOKEN_CACHE)) return null;
  try { return JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')); }
  catch { return null; }
}

function saveToken(tok) {
  mkdirSync(path.dirname(TOKEN_CACHE), { recursive: true });
  writeFileSync(TOKEN_CACHE, JSON.stringify(tok, null, 2));
}

async function exchangeCode(code, cs) {
  const body = new URLSearchParams({
    code,
    client_id: cs.client_id,
    client_secret: cs.client_secret,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
  });
  const r = await fetch(cs.token_uri, { method: 'POST', body });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function refreshToken(refresh_token, cs) {
  const body = new URLSearchParams({
    refresh_token,
    client_id: cs.client_id,
    client_secret: cs.client_secret,
    grant_type: 'refresh_token',
  });
  const r = await fetch(cs.token_uri, { method: 'POST', body });
  if (!r.ok) throw new Error(`refresh failed: ${r.status} ${await r.text()}`);
  return r.json();
}

function browserAuth(cs) {
  return new Promise((resolve, reject) => {
    const authUrl = new URL('https://accounts.google.com/o/oauth2/auth');
    authUrl.searchParams.set('client_id', cs.client_id);
    authUrl.searchParams.set('redirect_uri', REDIRECT);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPE);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, `http://localhost:${PORT}`);
      if (u.pathname !== '/callback') {
        res.writeHead(404); res.end(); return;
      }
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(err
        ? `<h1>OAuth error</h1><pre>${err}</pre>`
        : `<h1>OK — token acquired</h1><p>You can close this tab.</p>`);
      server.close();
      if (err) return reject(new Error(err));
      try {
        const tok = await exchangeCode(code, cs);
        tok.acquired_at = Date.now();
        saveToken(tok);
        resolve(tok);
      } catch (e) { reject(e); }
    });
    server.listen(PORT, () => {
      console.log('\n  ▶  Open this URL in your browser to authorize AdSense read access:\n');
      console.log('    ' + authUrl.toString() + '\n');
      exec(`open "${authUrl.toString()}"`);
    });
  });
}

async function getAccessToken() {
  const cs = loadClientSecret();
  let tok = loadCachedToken();
  if (tok?.refresh_token) {
    try {
      const refreshed = await refreshToken(tok.refresh_token, cs);
      tok = { ...tok, ...refreshed };
      saveToken(tok);
      return tok.access_token;
    } catch (e) {
      console.log(`  ⚠ refresh failed (${e.message}) — re-auth...`);
    }
  }
  tok = await browserAuth(cs);
  return tok.access_token;
}

async function gapi(token, pathFrag) {
  const r = await fetch(`https://adsense.googleapis.com/v2${pathFrag}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`${pathFrag} → ${r.status} ${await r.text()}`);
  return r.json();
}

function parseCodeSlots() {
  const src = readFileSync(SLOTS_PATH, 'utf8');
  const out = new Map();
  // match e.g.  NAME: {\n slot: '12345',
  const re = /(\w+):\s*\{\s*slot:\s*'(\d+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) out.set(m[1], m[2]);
  return out;
}

async function main() {
  const codeSlots = parseCodeSlots();
  console.log(`\n📄 Code: ${codeSlots.size} slot constants declared in adsenseSlots.ts\n`);

  const token = await getAccessToken();
  const accounts = await gapi(token, '/accounts');
  const acct = accounts.accounts?.[0];
  if (!acct) throw new Error('No AdSense account accessible for this Google user');
  console.log(`☁  AdSense account: ${acct.name} (${acct.displayName || acct.timeZone?.id || ''})`);

  const adClients = await gapi(token, `/${acct.name}/adclients`);
  const adClient = adClients.adClients?.find((c) => c.productCode === 'AFC') || adClients.adClients?.[0];
  if (!adClient) throw new Error('No ad client found');
  console.log(`   ad client: ${adClient.name} (reportingDimensionId: ${adClient.reportingDimensionId})\n`);

  // paginate ad units
  const units = [];
  let pageToken = '';
  do {
    const page = await gapi(token, `/${adClient.name}/adunits?pageSize=50${pageToken ? `&pageToken=${pageToken}` : ''}`);
    if (page.adUnits) units.push(...page.adUnits);
    pageToken = page.nextPageToken || '';
  } while (pageToken);

  console.log(`☁  Live: ${units.length} ad units in AdSense\n`);

  // Map live slot id → unit name/state. AdSense returns reportingDimensionId
  // as `ca-pub-XXX:NNN` but the <ins data-ad-slot> value is just NNN.
  const liveById = new Map();
  for (const u of units) {
    const full = u.reportingDimensionId || '';
    const id = full.includes(':') ? full.split(':').pop() : full;
    liveById.set(id, {
      displayName: u.displayName,
      state: u.state,
      contentAdsSettings: u.contentAdsSettings,
      name: u.name,
    });
  }

  const codeIds = new Set(codeSlots.values());

  console.log('═══ CODE → ADSENSE ═══');
  const table = [];
  for (const [name, id] of codeSlots) {
    const live = liveById.get(id);
    if (!live) table.push({ name, id, status: '❌ NOT FOUND', adSenseName: '—' });
    else table.push({
      name, id,
      status: live.state === 'ACTIVE' ? '✅ ' + live.state : '⚠️  ' + live.state,
      adSenseName: live.displayName,
    });
  }
  console.table(table);

  console.log('\n═══ LIVE BUT UNUSED IN CODE ═══');
  const unused = [];
  for (const [id, live] of liveById) {
    if (!codeIds.has(id)) unused.push({ id, displayName: live.displayName, state: live.state });
  }
  if (unused.length === 0) console.log('  (none)');
  else console.table(unused);

  console.log(`\n✓ Audit complete: ${codeSlots.size} code slots, ${units.length} live units, ${unused.length} unreferenced.`);
}

main().catch((e) => {
  console.error('\n✗ audit failed:', e.message);
  process.exit(1);
});
