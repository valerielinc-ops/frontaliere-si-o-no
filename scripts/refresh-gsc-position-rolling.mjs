#!/usr/bin/env node
/**
 * Refresh the 7-day rolling GSC avg-position snapshot used by the
 * SEO moratorium gate (CLAUDE.md rule #19).
 *
 * Writes `data/gsc-position-rolling.json` with:
 *   {
 *     generated:    ISO timestamp,
 *     window:       { start, end }   // GSC has a 2-day lag
 *     avg_position: number           // simple mean of the 7 daily positions
 *     daily:        [{ date, position, clicks }, …]
 *   }
 *
 * Auth strategy (tries in order):
 *   1. OAuth2 refresh-token (GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN)
 *   2. Service Account (GOOGLE_APPLICATION_CREDENTIALS) — the Firebase SA also
 *      has GSC permissions (see memory `reference_firebase_sa_doubles_as_gsc`)
 *
 * The artifact is git-ignored — it is regenerated on each PR.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const SITE = 'sc-domain:frontaliereticino.ch';
const OUT  = 'data/gsc-position-rolling.json';

async function getOAuthToken() {
  const id = process.env.GSC_CLIENT_ID;
  const secret = process.env.GSC_CLIENT_SECRET;
  const refresh = process.env.GSC_REFRESH_TOKEN;
  if (!id || !secret || !refresh) return null;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) {
    console.error(`OAuth token refresh failed (${r.status}): ${await r.text()}`);
    return null;
  }
  return (await r.json()).access_token;
}

async function getServiceAccountToken() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) return null;
  try {
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    });
    const client = await auth.getClient();
    if (client.email) console.log(`ℹ Using service account: ${client.email}`);
    const { token } = await client.getAccessToken();
    return token;
  } catch (e) {
    console.error(`Service account auth failed: ${e.message}`);
    return null;
  }
}

async function getToken() {
  const oauth = await getOAuthToken();
  if (oauth) return oauth;
  const sa = await getServiceAccountToken();
  if (sa) return sa;
  throw new Error(
    'No GSC credentials available. Set GSC_CLIENT_ID/GSC_CLIENT_SECRET/GSC_REFRESH_TOKEN ' +
    'or GOOGLE_APPLICATION_CREDENTIALS pointing at a SA with GSC access.',
  );
}

const fmt = (d) => d.toISOString().slice(0, 10);

const token = await getToken();
const today = new Date();
const start = new Date(today); start.setDate(start.getDate() - 9);
const end   = new Date(today); end.setDate(end.getDate() - 2);

const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`;
const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    startDate: fmt(start),
    endDate: fmt(end),
    dimensions: ['date'],
    rowLimit: 7,
  }),
});

if (!res.ok) {
  const body = await res.text();
  throw new Error(`GSC API request failed (${res.status}): ${body}`);
}

const data = await res.json();
const rows = data.rows || [];
const avg = rows.length
  ? rows.reduce((a, x) => a + x.position, 0) / rows.length
  : 0;

const outDir = dirname(OUT);
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({
    generated: new Date().toISOString(),
    window: { start: fmt(start), end: fmt(end) },
    avg_position: avg,
    daily: rows.map((r) => ({ date: r.keys[0], position: r.position, clicks: r.clicks })),
  }, null, 2),
);
console.log(`GSC 7-day avg position: ${avg.toFixed(2)} (${rows.length} days, ${fmt(start)} → ${fmt(end)})`);
