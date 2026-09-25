#!/usr/bin/env node
/**
 * preview-daily-brief-email.mjs — render the bulletin to disk, one file per
 * locale, so it can be looked at before anyone receives it (issue #5415 §4.9).
 *
 * Reads the real payload off the corpus API by default, so what you see is the
 * email that would go out this morning; `--fixture <path>` swaps in a saved
 * `daily-brief.json` for the degraded cases (one block missing, two, …).
 *
 * Also prints the headers the send would carry, since the RFC 8058 fix is
 * exactly the kind of thing an eyeball on the HTML cannot check.
 *
 *   node scripts/preview-daily-brief-email.mjs
 *   node scripts/preview-daily-brief-email.mjs --out /tmp/brief --tier 3
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildDailyBriefEmail } from '../services/daily-brief-template.mjs';
import { ARTICLES_API_BASE as API_BASE } from './lib/articles-api-base.mjs';

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const OUT_DIR = argOf('--out', path.join(process.cwd(), '.preview', 'daily-brief'));
const FIXTURE = argOf('--fixture', null);
const TIER = Number(argOf('--tier', '1'));
const LOCALES = ['it', 'en', 'de', 'fr'];
const BLOG_HUB = {
  it: '/articoli-frontaliere/',
  en: '/en/cross-border-articles/',
  de: '/de/grenzgaenger-artikel/',
  fr: '/fr/articles-frontalier/',
};

// Preview-only stand-ins: the real ones are HMAC-signed per recipient and there
// is no recipient here.
const SAMPLE_UNSUBSCRIBE = 'https://frontaliereticino.ch/disiscrivi-newsletter/?action=unsubscribe&email=preview%40example.com&token=preview';
const SAMPLE_PREFERENCES = 'https://frontaliereticino.ch/preferenze-newsletter/?email=preview%40example.com&token=preview';

async function loadBrief() {
  if (FIXTURE) return JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
  const res = await fetch(`${API_BASE}/daily-brief.json`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET daily-brief.json → HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const brief = await loadBrief();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`📰 edition ${brief.dateIso} — ${brief?.counts?.availableBlocks ?? '?'}/4 blocks available`);

  for (const locale of LOCALES) {
    const { html, text, preheader } = buildDailyBriefEmail({
      locale,
      brief,
      editionUrl: `https://frontaliereticino.ch${BLOG_HUB[locale]}bollettino-frontaliere-${brief.dateIso}/`,
      editionTitle: `Bollettino del Frontaliere — ${brief.dateIso}`,
      recipientName: 'Marco',
      cadenceDays: TIER,
      unsubscribeUrl: SAMPLE_UNSUBSCRIBE,
      preferencesUrl: SAMPLE_PREFERENCES,
    });
    fs.writeFileSync(path.join(OUT_DIR, `${locale}.html`), html);
    fs.writeFileSync(path.join(OUT_DIR, `${locale}.txt`), text);
    console.log(`   ${locale}: ${path.join(OUT_DIR, `${locale}.html`)}  (preheader: ${preheader.slice(0, 80)}…)`);
  }

  const { buildBriefHeaders } = await import('./send-daily-brief.mjs');
  const headers = buildBriefHeaders({
    email: 'preview@example.com',
    campaignId: `daily-brief-${brief.dateIso}`,
    unsubscribeUrl: SAMPLE_UNSUBSCRIBE,
  });
  console.log('\n📧 headers the send would carry:');
  for (const [key, value] of Object.entries(headers)) console.log(`   ${key}: ${value}`);
}

main().catch((error) => {
  console.error('❌ preview-daily-brief-email.mjs failed:', error);
  process.exitCode = 1;
});
