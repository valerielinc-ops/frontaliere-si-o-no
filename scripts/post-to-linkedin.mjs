#!/usr/bin/env node
/**
 * Post new blog article to LinkedIn Company Page
 *
 * Usage:
 *   node scripts/post-to-linkedin.mjs <article-id> <article-url> <og-title> <og-description> [category] [--dry-run]
 *
 * Environment variables (required):
 *   LINKEDIN_ORGANIZATION_ID — Numeric LinkedIn company page ID
 *
 * Token strategy (in order of preference):
 *   1. LINKEDIN_POST_REFRESH_TOKEN + LINKEDIN_CLIENT_ID + LINKEDIN_CLIENT_SECRET
 *      → auto-refreshes access token before each post (refresh token lasts ~1 year)
 *   2. LINKEDIN_POST_ACCESS_TOKEN
 *      → uses token directly (expires in 60 days — manual renewal needed)
 *
 * LinkedIn REST API (version 202401):
 *   POST https://api.linkedin.com/rest/posts
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

async function getAccessToken() {
  const refreshToken = process.env.LINKEDIN_POST_REFRESH_TOKEN;
  const clientId = process.env.LINKEDIN_POST_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_POST_CLIENT_SECRET;
  const staticToken = process.env.LINKEDIN_POST_ACCESS_TOKEN;

  // Preferred: auto-refresh using refresh token
  if (refreshToken && clientId && clientSecret) {
    console.log('🔄 Refreshing LinkedIn access token...');
    const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const data = await res.json();
    if (data.access_token) {
      console.log(`✅ Token refreshed (expires in ${data.expires_in}s)`);
      return data.access_token;
    }
    console.warn(`⚠️  Token refresh failed: ${JSON.stringify(data)} — falling back to static token`);
  }

  // Fallback: static access token
  if (staticToken) {
    console.log('ℹ️  Using static LINKEDIN_POST_ACCESS_TOKEN');
    return staticToken;
  }

  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter(a => !a.startsWith('--'));

  const [articleId, articleUrl, ogTitle, ogDescription, category] = positional;

  if (!articleId || !articleUrl || !ogTitle) {
    console.error('Usage: post-to-linkedin.mjs <id> <url> <og-title> <og-description> [category] [--dry-run]');
    process.exit(0);
  }

  const LINKEDIN_ORGANIZATION_ID = process.env.LINKEDIN_ORGANIZATION_ID;

  if (!dryRun && !LINKEDIN_ORGANIZATION_ID) {
    console.log('⚠️  LINKEDIN_ORGANIZATION_ID not set — skipping LinkedIn post');
    process.exit(0);
  }

  const hasCredentials = !!(
    process.env.LINKEDIN_POST_REFRESH_TOKEN ||
    process.env.LINKEDIN_POST_ACCESS_TOKEN
  );

  if (!dryRun && !hasCredentials) {
    console.log('⚠️  No LinkedIn token configured (set LINKEDIN_POST_REFRESH_TOKEN or LINKEDIN_POST_ACCESS_TOKEN) — skipping');
    process.exit(0);
  }

  // Build the commentary
  const emoji = CATEGORY_EMOJI[category] || '📰';
  const hashtags = CATEGORY_HASHTAGS[category] || DEFAULT_HASHTAGS;
  const description = ogDescription || '';

  const commentary = [
    `${emoji} ${ogTitle}`,
    '',
    description,
    '',
    `👉 Leggi l'articolo completo: ${articleUrl}`,
    '',
    hashtags,
  ].join('\n').trim();

  console.log('─── LinkedIn Post ───');
  console.log(`Article: ${articleId}`);
  console.log(`URL:     ${articleUrl}`);
  console.log(`Message:\n${commentary}`);
  console.log('─────────────────────');

  if (dryRun) {
    console.log('🏃 Dry run — not posting to LinkedIn');
    process.exit(0);
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    console.log('⚠️  Could not obtain LinkedIn access token — skipping');
    process.exit(0);
  }

  try {
    const payload = {
      author: `urn:li:organization:${LINKEDIN_ORGANIZATION_ID}`,
      commentary,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: {
        article: {
          source: articleUrl,
          title: ogTitle,
          ...(description && { description }),
        },
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };

    const response = await fetch('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'LinkedIn-Version': '202401',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(payload),
    });

    if (response.status === 201) {
      const postId = response.headers.get('x-restli-id') || 'unknown';
      console.log(`✅ Posted to LinkedIn! Post URN: ${postId}`);
    } else {
      const data = await response.text();
      console.error(`⚠️  LinkedIn API error (${response.status}): ${data}`);
      if (response.status === 401) {
        console.error('💡 Token expired or invalid. Refresh LINKEDIN_POST_REFRESH_TOKEN or LINKEDIN_POST_ACCESS_TOKEN in GitHub Secrets.');
      }
      if (response.status === 403) {
        console.error('💡 Missing scopes. Token needs w_organization_social scope (Community Management API).');
      }
    }
  } catch (error) {
    console.error(`⚠️  Failed to post to LinkedIn: ${error.message}`);
  }

  process.exit(0);
}

main();
