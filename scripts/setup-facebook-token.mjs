#!/usr/bin/env node
/**
 * Facebook Page Access Token Setup
 *
 * Generates a non-expiring Page Access Token for automated posting.
 *
 * Prerequisites:
 *   1. Create a Facebook App at https://developers.facebook.com/apps/
 *   2. Add "Facebook Login" product and enable "pages_manage_posts" + "pages_read_engagement"
 *   3. Generate a short-lived User Access Token from Graph API Explorer:
 *      https://developers.facebook.com/tools/explorer/
 *      - Select your app
 *      - Add permissions: pages_manage_posts, pages_read_engagement
 *      - Click "Generate Access Token" and authorize
 *
 * Usage:
 *   node scripts/setup-facebook-token.mjs <SHORT_LIVED_USER_TOKEN> <APP_ID> <APP_SECRET>
 *
 * Flow:
 *   1. Exchange short-lived user token → long-lived user token (60 days)
 *   2. Use long-lived user token to get Page Access Tokens
 *   3. Page Access Tokens obtained this way are NON-EXPIRING
 *
 * Output:
 *   Prints the Page Access Token and Page ID to save as GitHub secrets.
 */

const [shortToken, appId, appSecret] = process.argv.slice(2);

if (!shortToken || !appId || !appSecret) {
  console.error(`
❌ Usage: node scripts/setup-facebook-token.mjs <SHORT_LIVED_TOKEN> <APP_ID> <APP_SECRET>

Steps to get a short-lived token:
  1. Go to https://developers.facebook.com/tools/explorer/
  2. Select your app from the dropdown
  3. Click "Generate Access Token"
  4. Grant permissions: pages_manage_posts, pages_read_engagement
  5. Copy the token shown

Steps to get App ID and Secret:
  1. Go to https://developers.facebook.com/apps/
  2. Select your app → Settings → Basic
  3. Copy "App ID" and "App Secret"
`);
  process.exit(1);
}

async function main() {
  // ── Step 1: Exchange short-lived → long-lived user token ──
  console.log('🔄 Step 1: Exchanging short-lived token for long-lived user token...\n');

  const llRes = await fetch(
    `https://graph.facebook.com/v21.0/oauth/access_token?` +
    new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortToken,
    })
  );

  const llData = await llRes.json();
  if (llData.error) {
    console.error(`❌ Token exchange failed: ${llData.error.message}`);
    console.error(`   Type: ${llData.error.type}, Code: ${llData.error.code}`);
    if (llData.error.code === 190) {
      console.error('\n💡 The short-lived token may be expired. Generate a new one from Graph API Explorer.');
    }
    process.exit(1);
  }

  const longLivedUserToken = llData.access_token;
  const expiresIn = llData.expires_in;
  console.log(`✅ Long-lived user token obtained (expires in ${Math.round(expiresIn / 86400)} days)\n`);

  // ── Step 2: Get Page Access Tokens ────────────────────────
  console.log('🔄 Step 2: Fetching Page Access Tokens...\n');

  const pagesRes = await fetch(
    `https://graph.facebook.com/v21.0/me/accounts?access_token=${longLivedUserToken}`
  );

  const pagesData = await pagesRes.json();
  if (pagesData.error) {
    console.error(`❌ Failed to list pages: ${pagesData.error.message}`);
    process.exit(1);
  }

  if (!pagesData.data?.length) {
    console.error('❌ No Facebook Pages found for this user.');
    console.error('   Make sure your Facebook account manages at least one Page.');
    process.exit(1);
  }

  console.log(`📋 Found ${pagesData.data.length} page(s):\n`);

  for (const page of pagesData.data) {
    // ── Step 3: Verify each page token is non-expiring ──────
    const debugRes = await fetch(
      `https://graph.facebook.com/v21.0/debug_token?` +
      new URLSearchParams({
        input_token: page.access_token,
        access_token: `${appId}|${appSecret}`,
      })
    );
    const debugData = await debugRes.json();
    const tokenData = debugData.data || {};
    const expires = tokenData.expires_at === 0 ? 'NEVER (non-expiring ✅)' : new Date(tokenData.expires_at * 1000).toISOString();

    console.log(`   📄 ${page.name}`);
    console.log(`      ID:      ${page.id}`);
    console.log(`      Token:   ${page.access_token.slice(0, 20)}...${page.access_token.slice(-10)}`);
    console.log(`      Expires: ${expires}`);
    console.log(`      Scopes:  ${(tokenData.scopes || []).join(', ')}`);
    console.log();
  }

  // If only one page, output the GitHub secrets directly
  if (pagesData.data.length === 1) {
    const page = pagesData.data[0];
    console.log('═══════════════════════════════════════════════════');
    console.log('  Save these as GitHub Repository Secrets:');
    console.log('═══════════════════════════════════════════════════');
    console.log();
    console.log(`  FB_PAGE_ID=${page.id}`);
    console.log(`  FB_PAGE_ACCESS_TOKEN=${page.access_token}`);
    console.log();
    console.log('  Commands to set via gh CLI:');
    console.log(`  gh secret set FB_PAGE_ID --body "${page.id}"`);
    console.log(`  gh secret set FB_PAGE_ACCESS_TOKEN --body "${page.access_token}"`);
    console.log();
  } else {
    console.log('═══════════════════════════════════════════════════');
    console.log('  Multiple pages found. Pick the correct one and save:');
    console.log('  FB_PAGE_ID=<page-id>');
    console.log('  FB_PAGE_ACCESS_TOKEN=<page-token>');
    console.log('═══════════════════════════════════════════════════');
  }
}

main().catch((err) => {
  console.error(`❌ Unexpected error: ${err.message}`);
  process.exit(1);
});
