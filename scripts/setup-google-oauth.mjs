#!/usr/bin/env node
/**
 * One-time interactive setup to generate a Google OAuth2 refresh token
 * for Google Search Console API + GA4 Data API access.
 *
 * Usage:
 *   node scripts/setup-google-oauth.mjs <CLIENT_ID> <CLIENT_SECRET>
 *
 * Steps:
 *   1. Creates an OAuth2 client from the provided credentials
 *   2. Opens a local HTTP server on port 3456
 *   3. Redirects you to Google consent screen (webmasters + indexing + analytics scopes)
 *   4. Exchanges the auth code for tokens
 *   5. Prints the 3 secrets to save in GitHub Actions
 *
 * Prerequisites:
 *   - Go to https://console.cloud.google.com/apis/credentials
 *   - Create an OAuth 2.0 Client ID (type: Web application)
 *   - Add http://localhost:3456/callback as an authorized redirect URI
 *   - Enable "Google Search Console API" and "Google Analytics Data API" in your GCP project
 */

import http from 'node:http';
import { URL } from 'node:url';

const REDIRECT_PORT = 3456;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/webmasters',            // read-write: sitemaps PUT, search analytics
  'https://www.googleapis.com/auth/indexing',                // Indexing API (URL updated/removed notifications)
  'https://www.googleapis.com/auth/analytics.readonly',      // GA4 Data API (read-only analytics reports)
];

// ── Parse CLI args ──────────────────────────────────────────
const clientId = process.argv[2];
const clientSecret = process.argv[3];

if (!clientId || !clientSecret) {
  console.error('❌ Usage: node scripts/setup-google-oauth.mjs <CLIENT_ID> <CLIENT_SECRET>');
  console.error('');
  console.error('   Get your credentials from:');
  console.error('   https://console.cloud.google.com/apis/credentials');
  console.error('');
  console.error('   Make sure to add this redirect URI:');
  console.error(`   ${REDIRECT_URI}`);
  process.exit(1);
}

// ── Build Google OAuth consent URL ──────────────────────────
function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // Force consent to always get a refresh_token
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// ── Exchange auth code for tokens ───────────────────────────
async function exchangeCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ── Start local server and handle callback ──────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<h1>❌ Errore OAuth</h1><p>${error}</p>`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>❌ Nessun codice di autorizzazione ricevuto</h1>');
          server.close();
          reject(new Error('No authorization code received'));
          return;
        }

        try {
          const tokens = await exchangeCode(code);

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <html><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:20px">
              <h1>✅ Autorizzazione completata!</h1>
              <p>Puoi chiudere questa finestra e tornare al terminale.</p>
            </body></html>
          `);

          server.close();
          resolve(tokens);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<h1>❌ Errore</h1><pre>${err.message}</pre>`);
          server.close();
          reject(err);
        }
      } else {
        // Redirect to Google OAuth
        res.writeHead(302, { Location: buildAuthUrl() });
        res.end();
      }
    });

    server.listen(REDIRECT_PORT, () => {
      const localUrl = `http://localhost:${REDIRECT_PORT}`;
      console.log('');
      console.log('🔑 Google OAuth Setup — Search Console API');
      console.log('═'.repeat(50));
      console.log('');
      console.log(`📎 Apri questo URL nel browser:`);
      console.log(`   ${localUrl}`);
      console.log('');
      console.log('   Verrai reindirizzato alla pagina di consenso Google.');
      console.log('   Accetta le autorizzazioni per "Search Console".');
      console.log('');
      console.log('⏳ In attesa del callback...');
    });

    server.on('error', reject);
  });
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  try {
    const tokens = await startServer();

    if (!tokens.refresh_token) {
      console.error('');
      console.error('❌ Nessun refresh_token ricevuto!');
      console.error('   Assicurati di usare prompt=consent e access_type=offline.');
      console.error('   Prova a revocare l\'accesso su https://myaccount.google.com/permissions');
      console.error('   e poi riesegui questo script.');
      process.exit(1);
    }

    console.log('');
    console.log('✅ Token ottenuti con successo!');
    console.log('');
    console.log('═'.repeat(50));
    console.log('📋 Salva questi 3 segreti in GitHub Actions:');
    console.log('   Settings → Secrets and variables → Actions → New repository secret');
    console.log('═'.repeat(50));
    console.log('');
    console.log(`   GSC_CLIENT_ID      = ${clientId}`);
    console.log(`   GSC_CLIENT_SECRET   = ${clientSecret}`);
    console.log(`   GSC_REFRESH_TOKEN   = ${tokens.refresh_token}`);
    console.log('');
    console.log('═'.repeat(50));
    console.log('');
    console.log('ℹ️  Il refresh token non scade se l\'app è in "production" nel GCP console.');
    console.log('   Se l\'app è in "testing", il token scade dopo 7 giorni.');
    console.log('   → Vai su OAuth consent screen → Pubblica l\'app per token permanenti.');
    console.log('');
  } catch (err) {
    console.error(`\n❌ Setup fallito: ${err.message}`);
    process.exit(1);
  }
}

main();
