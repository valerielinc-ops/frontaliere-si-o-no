#!/usr/bin/env node
/**
 * Post new blog article to Facebook Page
 *
 * Usage:
 *   node scripts/post-to-facebook.mjs <article-id> <article-url> <og-title> <og-description> [--dry-run]
 *
 * Environment variables:
 *   FB_PAGE_ACCESS_TOKEN — Long-lived Facebook Page access token
 *   FB_PAGE_ID           — Numeric Facebook Page ID
 *
 * The script posts a link to the Facebook Page. Facebook will automatically
 * generate the OG preview (image, title, description) from the article URL
 * since the site already has all og:* meta tags configured.
 *
 * Facebook API response failures stay soft; a missing shared publication gate
 * exits nonzero so the post can never proceed without the Page-wide cap.
 *
 * NOTE: this is now a MANUAL CLI tool. The automated FB article posting moved
 * to the scheduled `scripts/schedule-fb-articles-daily.mjs` cron (the
 * generate-article → deploy path no longer auto-posts to Facebook). Both share
 * the caption/place-id logic from `scripts/lib/social-post-utils.mjs`.
 */

import { buildArticleCaption, ARTICLE_PLACE_ID, GRAPH_API } from './lib/social-post-utils.mjs';
import { recordManualFacebookArticlePost } from './lib/facebook-manual-post-ledger.mjs';
import { facebookUrl, FACEBOOK_CAMPAIGN_ARTICLE } from './lib/facebook-links.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  markSocialPublishReservationPublished,
  releaseSocialPublishReservation,
  reserveSocialPublishBatch,
  socialPublishContentFingerprint,
  socialPublishReservationKey,
} from './lib/social-publish-reservations.mjs';
import { isAmbiguousSocialPublishResponse } from './lib/social-publish-outcome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter(a => !a.startsWith('--'));

  const [articleId, articleUrl, ogTitle, ogDescription, category] = positional;

  if (!articleId || !articleUrl || !ogTitle) {
    console.error('Usage: post-to-facebook.mjs <id> <url> <og-title> <og-description> [category] [--dry-run]');
    process.exit(0); // soft failure
  }

  const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
  const FB_PAGE_ID = process.env.FB_PAGE_ID;

  if (!dryRun && (!FB_PAGE_ACCESS_TOKEN || !FB_PAGE_ID)) {
    console.log('⚠️  FB_PAGE_ACCESS_TOKEN or FB_PAGE_ID not set — skipping Facebook post');
    process.exit(0);
  }

  // Build the message (shared caption logic — see social-post-utils.mjs).
  const message = buildArticleCaption({ ogTitle, ogDescription, category });

  // An untagged social link lands in GA4 as Direct, so the channel reads as
  // ZERO sessions while it is in fact sending clicks — invisible, not absent
  // (measured 2026-08-24 on the Telegram channel; this script had the same
  // defect, posting a bare `articleUrl` as the Graph API `link`).
  // The SCRAPE below must use the same tagged URL: Facebook caches OG metadata
  // per exact URL string, so warming the bare one leaves the URL actually
  // posted uncached — the blank-preview failure this scrape exists to prevent.
  const taggedUrl = facebookUrl(articleUrl, FACEBOOK_CAMPAIGN_ARTICLE, articleId);

  console.log('─── Facebook Post ───');
  console.log(`Article: ${articleId}`);
  console.log(`URL:     ${taggedUrl}`);
  console.log(`Message:\n${message}`);
  console.log('─────────────────────');

  if (dryRun) {
    console.log('🏃 Dry run — not posting to Facebook');
    process.exit(0);
  }

  // ── Debug: verify the token & page ID are correct ─────────
  const debugMode = args.includes('--debug');
  if (debugMode) {
    console.log('\n🔍 Debug: verifying token & page identity...');
    try {
      // 1. Check what the token belongs to
      const meRes = await fetch(`${GRAPH_API}/me?access_token=${FB_PAGE_ACCESS_TOKEN}`);
      const me = await meRes.json();
      console.log(`   Token owner: ${me.name || '?'} (id: ${me.id || '?'}, category: ${me.category || 'user/unknown'})`);
      if (me.id && me.id !== FB_PAGE_ID) {
        console.log(`   ⚠️  FB_PAGE_ID (${FB_PAGE_ID}) ≠ token's /me id (${me.id})`);
        console.log(`   💡 If this token is a Page Access Token, set FB_PAGE_ID=${me.id}`);
      }
      // 2. Check /me/accounts to list managed pages
      const acctRes = await fetch(`${GRAPH_API}/me/accounts?access_token=${FB_PAGE_ACCESS_TOKEN}`);
      const acct = await acctRes.json();
      if (acct.data?.length) {
        console.log(`   Managed pages:`);
        for (const p of acct.data) {
          console.log(`     • ${p.name} → id: ${p.id}`);
        }
      } else {
        console.log(`   No managed pages found (token may already be a Page token)`);
      }
    } catch (e) {
      console.log(`   Debug error: ${e.message}`);
    }
    console.log('');
  }

  // Force Facebook to scrape/refresh OG metadata for the article URL
  console.log('🔄 Forcing Facebook OG cache refresh...');
  try {
    const scrapeRes = await fetch(`${GRAPH_API}/?id=${encodeURIComponent(taggedUrl)}&scrape=true&access_token=${FB_PAGE_ACCESS_TOKEN}`, {
      method: 'POST',
    });
    const scrapeData = await scrapeRes.json();
    if (scrapeData.title) {
      console.log(`✅ Facebook OG refreshed: "${scrapeData.title}"`);
      console.log(`   og:image = ${scrapeData.image?.[0]?.url || '(none)'}`);
    } else {
      console.log(`⚠️  Facebook scrape response: ${JSON.stringify(scrapeData).slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`⚠️  Facebook scrape failed: ${e.message}`);
  }

  // Wait for Facebook's cache to propagate after scrape
  await new Promise(r => setTimeout(r, 3000));

  const publishAt = new Date();
  const reservationKey = socialPublishReservationKey('facebook', 'article', articleId);
  try {
    const reservation = await reserveSocialPublishBatch({
      platform: 'facebook',
      accountId: FB_PAGE_ID,
      repoRoot: ROOT,
      reservations: [{
        key: reservationKey,
        publishAt,
        nativeContentFingerprint: socialPublishContentFingerprint('facebook', { message, link: taggedUrl }),
      }],
      now: publishAt,
    });
    if (!reservation[0]?.allowed) {
      console.warn(`🛑 Facebook Page post held by the shared daily cap (${reservation[0]?.reason || 'reservation-denied'})`);
      process.exit(0);
    }
  } catch (error) {
    console.error(`❌ Facebook shared publication gate failed; post was not sent: ${error.message}`);
    process.exit(1);
  }

  let publicationNeedsReconciliation = false;
  try {
    const url = `${GRAPH_API}/${FB_PAGE_ID}/feed`;
    const body = new URLSearchParams({
      message,
      link: taggedUrl,
      access_token: FB_PAGE_ACCESS_TOKEN,
    });
    // Geo anchor for FB Search discovery. Articles cover cross-border
    // CH-IT topics; Lugano is the canonical city for the frontaliere
    // audience. Override per-article in the future if we want sub-region
    // targeting (e.g., a Mendrisio-specific article).
    // Place ID 106534719384213 = "Lugano, Switzerland" (verified live).
    body.append('place', ARTICLE_PLACE_ID);

    let response = null;
    let data = null;
    let requestError = null;
    try {
      response = await fetch(url, {
        method: 'POST',
        body,
      });
    } catch (error) {
      requestError = error;
    }
    if (response) {
      try {
        data = await response.json();
      } catch (error) {
        requestError = error;
      }
    }

    if (response?.ok && data?.id) {
      const publishedAt = new Date().toISOString();
      let canonicalLedgerWritten = false;
      try {
        recordManualFacebookArticlePost({
          repoRoot: ROOT,
          articleId,
          url: articleUrl,
          postId: data.id,
          publishedAt,
        });
        canonicalLedgerWritten = true;
      } catch (error) {
        console.error(`⚠️  Facebook accepted the post but its canonical article ledger could not be written: ${error.message}`);
        publicationNeedsReconciliation = true;
      }
      // Keep the shared reservation held until the canonical ledger is durable.
      // A ledger write failure must remain visible and block a replay.
      if (canonicalLedgerWritten) {
        try {
          await markSocialPublishReservationPublished({
            platform: 'facebook', accountId: FB_PAGE_ID, key: reservationKey, publishAt, publishedAt,
          });
        } catch (error) {
          console.error(`⚠️  Facebook accepted the post; its shared reservation remains held: ${error.message}`);
          publicationNeedsReconciliation = true;
        }
      }
      console.log(`✅ Posted to Facebook! Post ID: ${data.id}`);
    } else {
      if (response && !response.ok && !isAmbiguousSocialPublishResponse(response)) {
        try {
          await releaseSocialPublishReservation({
            platform: 'facebook', accountId: FB_PAGE_ID, key: reservationKey, publishAt,
          });
        } catch (error) {
          console.warn(`⚠️  Facebook reservation remains held after explicit API rejection: ${error.message}`);
        }
      } else {
        publicationNeedsReconciliation = true;
        console.warn('⚠️  Facebook publication outcome is ambiguous; shared reservation remains held to prevent replay');
      }
      console.error(`⚠️  Facebook API error: ${requestError?.message || JSON.stringify(data)}`);
      if (data?.error?.code === 100) {
        console.error('💡 Error 100 = wrong ID. FB_PAGE_ID must be the numeric Page ID, not a User ID.');
        console.error('   Run with --debug to identify the correct Page ID:');
        console.error('   node scripts/post-to-facebook.mjs <args> --debug --dry-run');
      }
    }
  } catch (error) {
    console.error(`⚠️  Failed to post to Facebook: ${error.message}`);
  }

  process.exit(publicationNeedsReconciliation ? 1 : 0);
}

main();
