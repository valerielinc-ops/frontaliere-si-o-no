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
 * Exit code is always 0 (soft failure) — this script should never block CI.
 */

const CATEGORY_HASHTAGS = {
  fiscale:  '#frontalieri #ticino #tasse #fisco #svizzera #italia',
  pratico:  '#frontalieri #ticino #lavoro #svizzera #guidapratica',
  novita:   '#frontalieri #ticino #news #svizzera #italia #novità',
  pensione: '#frontalieri #ticino #pensione #AVS #previdenza',
};
const DEFAULT_HASHTAGS = '#frontalieri #ticino #lavoro #svizzera #italia';

const CATEGORY_EMOJI = {
  fiscale:  '📊',
  pratico:  '📋',
  novita:   '🗞️',
  pensione: '🏦',
};

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

  // Build the message
  const emoji = CATEGORY_EMOJI[category] || '📰';
  const hashtags = CATEGORY_HASHTAGS[category] || DEFAULT_HASHTAGS;
  const description = ogDescription || '';

  const message = [
    `${emoji} ${ogTitle}`,
    '',
    description,
    '',
    `👉 Leggi l'articolo completo:`,
    '',
    hashtags,
  ].join('\n').trim();

  console.log('─── Facebook Post ───');
  console.log(`Article: ${articleId}`);
  console.log(`URL:     ${articleUrl}`);
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
      const meRes = await fetch(`https://graph.facebook.com/v21.0/me?access_token=${FB_PAGE_ACCESS_TOKEN}`);
      const me = await meRes.json();
      console.log(`   Token owner: ${me.name || '?'} (id: ${me.id || '?'}, category: ${me.category || 'user/unknown'})`);
      if (me.id && me.id !== FB_PAGE_ID) {
        console.log(`   ⚠️  FB_PAGE_ID (${FB_PAGE_ID}) ≠ token's /me id (${me.id})`);
        console.log(`   💡 If this token is a Page Access Token, set FB_PAGE_ID=${me.id}`);
      }
      // 2. Check /me/accounts to list managed pages
      const acctRes = await fetch(`https://graph.facebook.com/v21.0/me/accounts?access_token=${FB_PAGE_ACCESS_TOKEN}`);
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
    const scrapeRes = await fetch(`https://graph.facebook.com/v21.0/?id=${encodeURIComponent(articleUrl)}&scrape=true&access_token=${FB_PAGE_ACCESS_TOKEN}`, {
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

  try {
    const url = `https://graph.facebook.com/v21.0/${FB_PAGE_ID}/feed`;
    const body = new URLSearchParams({
      message,
      link: articleUrl,
      access_token: FB_PAGE_ACCESS_TOKEN,
    });
    // Geo anchor for FB Search discovery. Articles cover cross-border
    // CH-IT topics; Lugano is the canonical city for the frontaliere
    // audience. Override per-article in the future if we want sub-region
    // targeting (e.g., a Mendrisio-specific article).
    // Place ID 106534719384213 = "Lugano, Switzerland" (verified live).
    body.append('place', '106534719384213');

    const response = await fetch(url, {
      method: 'POST',
      body,
    });

    const data = await response.json();

    if (response.ok && data.id) {
      console.log(`✅ Posted to Facebook! Post ID: ${data.id}`);
    } else {
      console.error(`⚠️  Facebook API error: ${JSON.stringify(data)}`);
      if (data.error?.code === 100) {
        console.error('💡 Error 100 = wrong ID. FB_PAGE_ID must be the numeric Page ID, not a User ID.');
        console.error('   Run with --debug to identify the correct Page ID:');
        console.error('   node scripts/post-to-facebook.mjs <args> --debug --dry-run');
      }
    }
  } catch (error) {
    console.error(`⚠️  Failed to post to Facebook: ${error.message}`);
  }

  process.exit(0);
}

main();
