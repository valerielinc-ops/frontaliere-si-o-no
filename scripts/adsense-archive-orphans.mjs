#!/usr/bin/env node
/**
 * One-off: archive AdSense ad units that are live but unreferenced in code.
 *
 * Candidates = live ad-units whose slot id isn't present in services/adsenseSlots.ts
 * AND whose displayName matches one of the known-legacy prefixes
 * (blog-*, ADSlotArticolo*, Job search, AD In article mobile).
 *
 * We don't touch the "*_2" units or AUTHGATE_RAIL_* even if they happened to be
 * orphaned — those are intentional second inventory for future wiring.
 *
 * Re-uses the OAuth refresh token cached by adsense-slot-audit.mjs. Requires
 * the full `adsense` write scope, so if the cached token is read-only this
 * will fail and you need to re-run the audit to trigger re-auth.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
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

const DRY_RUN = process.argv.includes('--dry-run');

// Legacy display name patterns — safe to archive
const LEGACY_PATTERNS = [
  /^blog-/i,
  /^ADSlotArticolo/i,
  /^Job search$/i,
  /^AD In article mobile$/i,
];

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
  const body = new URLSearchParams({ code, client_id: cs.client_id, client_secret: cs.client_secret, redirect_uri: REDIRECT, grant_type: 'authorization_code' });
  const r = await fetch(cs.token_uri, { method: 'POST', body });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function refreshToken(refresh_token, cs) {
  const body = new URLSearchParams({ refresh_token, client_id: cs.client_id, client_secret: cs.client_secret, grant_type: 'refresh_token' });
  const r = await fetch(cs.token_uri, { method: 'POST', body });
  if (!r.ok) throw new Error(await r.text());
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
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const code = u.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>OK</h1>`);
      server.close();
      try { const tok = await exchangeCode(code, cs); tok.acquired_at = Date.now(); saveToken(tok); resolve(tok); }
      catch (e) { reject(e); }
    });
    server.listen(PORT, () => {
      console.log('\n  ▶  Authorize AdSense write access:\n    ' + authUrl.toString() + '\n');
      exec(`open "${authUrl.toString()}"`);
    });
  });
}

async function getAccessToken() {
  const cs = loadClientSecret();
  let tok = loadCachedToken();
  if (tok?.refresh_token) {
    try { const r = await refreshToken(tok.refresh_token, cs); tok = { ...tok, ...r }; saveToken(tok); return tok.access_token; }
    catch { /* fall through */ }
  }
  tok = await browserAuth(cs);
  return tok.access_token;
}

async function gapi(token, method, pathFrag, body) {
  const r = await fetch(`https://adsense.googleapis.com/v2${pathFrag}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${pathFrag} → ${r.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

function parseCodeSlotIds() {
  const src = readFileSync(SLOTS_PATH, 'utf8');
  const ids = new Set();
  const re = /slot:\s*'(\d+)'/g;
  let m; while ((m = re.exec(src)) !== null) ids.add(m[1]);
  return ids;
}

async function main() {
  const codeIds = parseCodeSlotIds();
  const token = await getAccessToken();
  const accounts = await gapi(token, 'GET', '/accounts');
  const acct = accounts.accounts[0];
  const adClients = await gapi(token, 'GET', `/${acct.name}/adclients`);
  const adClient = adClients.adClients.find((c) => c.productCode === 'AFC') || adClients.adClients[0];

  const units = [];
  let pageToken = '';
  do {
    const page = await gapi(token, 'GET', `/${adClient.name}/adunits?pageSize=50${pageToken ? `&pageToken=${pageToken}` : ''}`);
    if (page.adUnits) units.push(...page.adUnits);
    pageToken = page.nextPageToken || '';
  } while (pageToken);

  const targets = units.filter((u) => {
    if (u.state === 'ARCHIVED') return false; // already archived
    const full = u.reportingDimensionId || '';
    const id = full.includes(':') ? full.split(':').pop() : full;
    if (codeIds.has(id)) return false;
    return LEGACY_PATTERNS.some((re) => re.test(u.displayName || ''));
  });

  console.log(`\n📋 ${targets.length} legacy ACTIVE units match archive patterns:\n`);
  for (const u of targets) {
    console.log(`   • ${u.displayName}  (${u.reportingDimensionId})`);
  }

  if (DRY_RUN) { console.log('\n  (dry-run — no changes made)'); return; }
  if (targets.length === 0) { console.log('\n✓ nothing to do.'); return; }

  console.log('\n⏳ Archiving...\n');
  let ok = 0, fail = 0;
  for (const u of targets) {
    try {
      await gapi(token, 'PATCH', `/${u.name}?updateMask=state`, { state: 'ARCHIVED' });
      console.log(`   ✓ ${u.displayName}`);
      ok++;
    } catch (e) {
      console.log(`   ✗ ${u.displayName} — ${e.message.slice(0, 200)}`);
      fail++;
    }
  }
  console.log(`\n✓ archived ${ok}/${targets.length} (${fail} failed).`);
  if (fail === targets.length && targets.length > 0) {
    console.log(`
⚠  All archives failed. The AdSense Management API v2 does not currently expose
   a writable \`state\` field on ad units (it's read-only in UpdateAdUnit). To
   archive these units, do it manually in the AdSense console:

     https://www.google.com/adsense/new/u/0/pub-8628054934855353/myads/units

   Filter by the display names listed above and archive each one.
`);
  }
}

main().catch((e) => { console.error('\n✗ archive failed:', e.message); process.exit(1); });
