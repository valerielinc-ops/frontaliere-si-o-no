#!/usr/bin/env node
/**
 * Create (or reuse) the site's own GPT/GAM display ad units in Google Ad
 * Manager, then print the GPT ad-unit paths to wire into the front-end.
 *
 * Covers the desktop article side-rails AND the desktop top banner.
 *
 * WHY GAM (not AdSense): the original AdSense units were archived in the
 * 2026-04-26 prune, and the AdSense Management API v2 cannot create ad units
 * for this account (POST adunits → 403 PERMISSION_DENIED) nor reactivate an
 * archived one (state is read-only). The site already serves a GPT slot
 * (/23355151813/gpt-poc-articoli, issue #2273/#2289) via Google Ad Manager with
 * AdSense backfill, and the service account IS a user on GAM network
 * 23355151813 — so the supported programmatic path is GAM InventoryService
 * .createAdUnits + serve via GPT. AdSense dynamic-allocation backfills unsold
 * impressions, so fill stays comparable to a plain AdSense unit while Auto Ads
 * keep serving untouched.
 *
 * Sizes are per-unit (see TARGETS). AdSense settings are inherited from the
 * network root (already AdSense-enabled).
 *  - Rails: premium verticals (300x600 half-page, 160x600 skyscraper) + 300x250
 *    box + fluid fallback.
 *  - Top banner: uniform-height leaderboards only (970x90, 728x90), isFluid
 *    false — a single creative height (90px) lets the front-end slot reserve
 *    exactly that height, so it never leaves a blank band above the fold (the
 *    gap a variable-height Auto Ad / aspect-ratio box caused).
 *
 * Auth: service-account JSON with GAM (dfp) access on the network.
 *   GOOGLE_APPLICATION_CREDENTIALS=./mcp-gsc-main/service_account_credentials.json
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=./mcp-gsc-main/service_account_credentials.json \
 *     node scripts/gam-create-ad-units.mjs            # create/reuse
 *   ... node scripts/gam-create-ad-units.mjs --dry-run  # list only, no writes
 */
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const VER = 'v202511';
const NETWORK_CODE = '23355151813';
const APP_NAME = 'frontaliere-rail';
const DRY_RUN = process.argv.includes('--dry-run');

// Each target carries its own sizes + isFluid.
const TARGETS = [
  { adUnitCode: 'article-rail-left', name: 'Article rail — left (desktop)', sizes: [[300, 600], [160, 600], [300, 250]], isFluid: true },
  { adUnitCode: 'article-rail-right', name: 'Article rail — right (desktop)', sizes: [[300, 600], [160, 600], [300, 250]], isFluid: true },
  { adUnitCode: 'desktop-top-banner', name: 'Desktop top banner', sizes: [[970, 90], [728, 90]], isFluid: false },
  { adUnitCode: 'calculator-form-box', name: 'Calculator form box', sizes: [[300, 250], [336, 280]], isFluid: true },
];

const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!saPath) { console.error('✗ set GOOGLE_APPLICATION_CREDENTIALS to the GAM service-account JSON'); process.exit(1); }
const sa = JSON.parse(readFileSync(saPath, 'utf8'));

const b64url = (b) => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/dfp',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256'); signer.update(`${header}.${claim}`); signer.end();
  const jwt = `${header}.${claim}.${b64url(signer.sign(sa.private_key))}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('SA token failed: ' + JSON.stringify(j));
  return j.access_token;
}

function escapeXml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function soap(token, service, bodyXml) {
  const env = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Header><ns1:RequestHeader xmlns:ns1="https://www.google.com/apis/ads/publisher/${VER}">` +
    `<ns1:networkCode>${NETWORK_CODE}</ns1:networkCode><ns1:applicationName>${APP_NAME}</ns1:applicationName>` +
    `</ns1:RequestHeader></soap:Header><soap:Body>${bodyXml}</soap:Body></soap:Envelope>`;
  const r = await fetch(`https://ads.google.com/apis/ads/publisher/${VER}/${service}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', Authorization: `Bearer ${token}`, SOAPAction: '' },
    body: env,
  });
  const text = await r.text();
  const fault = (text.match(/<faultstring>([^<]+)<\/faultstring>/) || [])[1];
  if (!r.ok || fault) throw new Error(`${service} → ${r.status} ${fault || text.slice(0, 300)}`);
  return text;
}

async function findByCode(token, adUnitCode) {
  const xml = `<getAdUnitsByStatement xmlns="https://www.google.com/apis/ads/publisher/${VER}">` +
    `<filterStatement><query>WHERE adUnitCode = '${adUnitCode}'</query></filterStatement></getAdUnitsByStatement>`;
  const res = await soap(token, 'InventoryService', xml);
  if (/<totalResultSetSize>0<\/totalResultSetSize>/.test(res)) return null;
  return (res.match(/<id>(\d+)<\/id>/) || [])[1] || null;
}

function adUnitXml(parentId, t) {
  const sizesXml = t.sizes.map(([w, h]) =>
    `<adUnitSizes><size><width>${w}</width><height>${h}</height><isAspectRatio>false</isAspectRatio></size>` +
    `<environmentType>BROWSER</environmentType></adUnitSizes>`).join('');
  // Element order must follow the AdUnit XSD: parentId, name, targetWindow,
  // adUnitCode, adUnitSizes, isFluid.
  return `<adUnits>` +
    `<parentId>${parentId}</parentId>` +
    `<name>${escapeXml(t.name)}</name>` +
    `<targetWindow>TOP</targetWindow>` +
    `<adUnitCode>${escapeXml(t.adUnitCode)}</adUnitCode>` +
    sizesXml +
    `<isFluid>${t.isFluid ? 'true' : 'false'}</isFluid>` +
    `</adUnits>`;
}

async function main() {
  const token = await getToken();

  // Network root (parent for new units).
  const net = await soap(token, 'NetworkService', `<getCurrentNetwork xmlns="https://www.google.com/apis/ads/publisher/${VER}"/>`);
  const rootId = (net.match(/<effectiveRootAdUnitId>(\d+)<\/effectiveRootAdUnitId>/) || [])[1];
  if (!rootId) throw new Error('could not resolve effectiveRootAdUnitId');
  console.log(`network ${NETWORK_CODE} root adUnit ${rootId}`);

  const results = {};
  const toCreate = [];
  for (const t of TARGETS) {
    const existing = await findByCode(token, t.adUnitCode);
    if (existing) {
      results[t.adUnitCode] = existing;
      console.log(`= reuse  ${t.adUnitCode.padEnd(20)} id=${existing}  →  /${NETWORK_CODE}/${t.adUnitCode}`);
    } else {
      toCreate.push(t);
    }
  }

  if (toCreate.length && !DRY_RUN) {
    const xml = `<createAdUnits xmlns="https://www.google.com/apis/ads/publisher/${VER}">` +
      toCreate.map((t) => adUnitXml(rootId, t)).join('') + `</createAdUnits>`;
    const res = await soap(token, 'InventoryService', xml);
    // Each created AdUnit is a <results>… block; its own id is the FIRST <id>
    // inside the block (a later <parentPath><id> holds the root id — don't grab
    // that). Response order matches request order.
    const ids = res.split('<results>').slice(1)
      .map((block) => (block.match(/<id>(\d+)<\/id>/) || [])[1]);
    toCreate.forEach((t, i) => {
      results[t.adUnitCode] = ids[i];
      console.log(`+ create ${t.adUnitCode.padEnd(20)} id=${ids[i]}  →  /${NETWORK_CODE}/${t.adUnitCode}`);
    });
  } else if (toCreate.length) {
    for (const t of toCreate) console.log(`+ would create ${t.adUnitCode.padEnd(18)} →  /${NETWORK_CODE}/${t.adUnitCode}`);
  }

  console.log('\nGPT ad-unit paths (wire into the front-end rail slots):');
  for (const t of TARGETS) console.log(`  ${t.adUnitCode.padEnd(20)} /${NETWORK_CODE}/${t.adUnitCode}`);
}

main().catch((e) => { console.error('\n✗ failed:', e.message); process.exit(1); });
