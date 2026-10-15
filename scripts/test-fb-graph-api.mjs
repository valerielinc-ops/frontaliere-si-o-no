#!/usr/bin/env node
/**
 * Test Facebook Graph API permissions: email, public_profile, user_birthday
 * 
 * Usage:
 *   node scripts/test-fb-graph-api.mjs <ACCESS_TOKEN>
 * 
 * Get a test access token from:
 *   https://developers.facebook.com/tools/explorer/
 *   → Select your app → Add permissions: email, public_profile, user_birthday
 *   → Click "Generate Access Token" → Copy token
 */

const token = process.argv[2];

if (!token) {
  console.error('\n❌ Usage: node scripts/test-fb-graph-api.mjs <ACCESS_TOKEN>\n');
  console.error('Get a token from: https://developers.facebook.com/tools/explorer/');
  console.error('Required permissions: email, public_profile, user_birthday\n');
  process.exit(1);
}

const FIELDS = 'id,email,name,first_name,last_name,picture.width(200).height(200),birthday';
const API_VERSION = 'v19.0';

async function testGraphAPI() {
  console.log('\n🔍 Testing Facebook Graph API permissions...\n');
  console.log(`   API version: ${API_VERSION}`);
  console.log(`   Fields requested: ${FIELDS}\n`);

  // ── Test 1: Verify token & permissions ──────────────────────────────
  console.log('━━━ Test 1: Token debug info ━━━');
  try {
    const debugResp = await fetch(
      `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`
    );
    const debugData = await debugResp.json();
    if (debugData.data) {
      const d = debugData.data;
      console.log(`   App ID:      ${d.app_id || '❌ N/A'}`);
      console.log(`   User ID:     ${d.user_id || '❌ N/A'}`);
      console.log(`   Valid:        ${d.is_valid ? '✅ Yes' : '❌ No'}`);
      console.log(`   Scopes:       ${(d.scopes || []).join(', ') || '❌ None'}`);
      console.log(`   Expires:      ${d.expires_at ? new Date(d.expires_at * 1000).toLocaleString() : 'N/A'}`);
      
      // Check required permissions
      const scopes = d.scopes || [];
      const required = ['email', 'public_profile', 'user_birthday'];
      const missing = required.filter(s => !scopes.includes(s));
      if (missing.length > 0) {
        console.log(`\n   ⚠️  Missing permissions: ${missing.join(', ')}`);
        console.log('   → Go to Graph API Explorer and add these permissions, then re-generate the token.\n');
      } else {
        console.log('\n   ✅ All required permissions granted!\n');
      }
    } else if (debugData.error) {
      console.log(`   ❌ Error: ${debugData.error.message}\n`);
    }
  } catch (e) {
    console.log(`   ❌ Debug request failed: ${e.message}\n`);
  }

  // ── Test 2: Fetch user data (same query as authService.ts) ──────────
  console.log('━━━ Test 2: User data (/me) ━━━');
  try {
    const url = `https://graph.facebook.com/${API_VERSION}/me?fields=${FIELDS}&access_token=${encodeURIComponent(token)}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.error) {
      console.log(`   ❌ Error ${data.error.code}: ${data.error.message}\n`);
      return;
    }

    // public_profile fields
    console.log('\n   📋 public_profile:');
    console.log(`      id:          ${data.id || '❌ missing'}`);
    console.log(`      name:        ${data.name || '❌ missing'}`);
    console.log(`      first_name:  ${data.first_name || '❌ missing'}`);
    console.log(`      last_name:   ${data.last_name || '❌ missing'}`);

    // picture
    const pic = data.picture?.data;
    if (pic) {
      console.log(`      picture:     ${pic.is_silhouette ? '⚠️  silhouette (no real photo)' : '✅ real photo'}`);
      console.log(`      picture URL: ${pic.url?.substring(0, 80)}...`);
    } else {
      console.log('      picture:     ❌ missing');
    }

    // email
    console.log('\n   📧 email:');
    console.log(`      email:       ${data.email || '⚠️  not returned (user may not have granted email permission, or email is unverified)'}`);

    // birthday (user_birthday)
    console.log('\n   🎂 user_birthday:');
    if (data.birthday) {
      console.log(`      birthday:    ${data.birthday}`);
      // Parse and calculate age (FB format: MM/DD/YYYY)
      const parts = data.birthday.split('/');
      if (parts.length === 3) {
        const [mm, dd, yyyy] = parts.map(Number);
        const today = new Date();
        let age = today.getFullYear() - yyyy;
        const monthDiff = today.getMonth() + 1 - mm;
        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dd)) age--;
        
        // Map to bracket (same logic as calculateAgeBracketFromBirthday)
        let bracket;
        if (age <= 25) bracket = '18-25';
        else if (age <= 35) bracket = '26-35';
        else if (age <= 45) bracket = '36-45';
        else if (age <= 55) bracket = '46-55';
        else if (age <= 65) bracket = '56-65';
        else bracket = '65+';
        
        console.log(`      age:         ${age} years old`);
        console.log(`      bracket:     ${bracket} (as stored in profile)`);
      } else {
        console.log(`      ⚠️  Partial birthday (no year): ${data.birthday} — cannot calculate age`);
      }
    } else {
      console.log('      birthday:    ⚠️  not returned (user may not have granted user_birthday permission)');
    }

    // ── Summary ──────────────────────────────────────────────────────
    console.log('\n━━━ Summary ━━━');
    const results = [
      { field: 'public_profile (name)', ok: !!data.name },
      { field: 'public_profile (picture)', ok: !!pic && !pic.is_silhouette },
      { field: 'email', ok: !!data.email },
      { field: 'user_birthday', ok: !!data.birthday && data.birthday.split('/').length === 3 },
    ];
    
    let allOk = true;
    for (const r of results) {
      console.log(`   ${r.ok ? '✅' : '❌'} ${r.field}`);
      if (!r.ok) allOk = false;
    }
    
    if (allOk) {
      console.log('\n   🎉 All permissions working correctly!\n');
    } else {
      console.log('\n   ⚠️  Some fields missing — check permissions in App Review.\n');
    }

    // Raw JSON for debugging
    console.log('━━━ Raw API response ━━━');
    const sanitized = { ...data };
    if (sanitized.picture?.data?.url) {
      sanitized.picture = { data: { ...sanitized.picture.data, url: sanitized.picture.data.url.substring(0, 60) + '...' } };
    }
    console.log(JSON.stringify(sanitized, null, 2));
    console.log('');

  } catch (e) {
    console.log(`   ❌ Request failed: ${e.message}\n`);
  }
}

testGraphAPI();
