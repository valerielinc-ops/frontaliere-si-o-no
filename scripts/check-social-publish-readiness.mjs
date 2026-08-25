#!/usr/bin/env node
/**
 * check-social-publish-readiness.mjs — asks each social publishing channel's
 * platform whether it will let us post yet, and prints one verdict per channel.
 *
 * The decision table is scripts/lib/social-readiness.mjs (pure, unit-tested).
 * This file is only the network half: two read-only probes, no writes, no post.
 *
 *   Instagram  GET  graph.facebook.com/v21.0/{FB_PAGE_ID}?fields=instagram_business_account
 *              The field appears once Meta App Review grants the Instagram
 *              scopes and is absent before — the cheapest honest answer to
 *              "did the review land?" that exists without an App token.
 *
 *   TikTok     POST open.tiktokapis.com/v2/oauth/token/ (client_credentials)
 *              Succeeds only for a developer app that exists and is enabled.
 *              Separates "no app" from "app exists, audit queued".
 *
 *   Reddit     no probe — the Data Access Request was denied outright
 *              (see the lib's header and docs/REDDIT-POSTING.md); there is no
 *              queue left to poll.
 *
 * Fail-soft on purpose, like every poster it watches: any probe error becomes
 * a negative probe result, never a throw, and the process always exits 0. A
 * monitor that goes red because Meta had a bad minute teaches the reader to
 * ignore it.
 *
 * Usage:
 *   node scripts/check-social-publish-readiness.mjs            # table
 *   node scripts/check-social-publish-readiness.mjs --json     # machine-readable
 *   node scripts/check-social-publish-readiness.mjs --json --actionable-only
 *   node scripts/check-social-publish-readiness.mjs --ready-channels   # names, space-separated
 *   node scripts/check-social-publish-readiness.mjs --reason=tiktok    # one reason line
 *
 * The last two exist so .github/workflows/social-publish-readiness-watch.yml
 * can read a verdict without an inline `node -e` reaching into the JSON: an
 * eval one-liner inside YAML inside a shell loop is three layers of quoting to
 * get wrong, and it fails silently by printing nothing.
 *
 * Env (all via Firebase Remote Config → scripts/load-rc-env.mjs):
 *   FB_PAGE_ID + FB_PAGE_ACCESS_TOKEN          Instagram probe
 *   TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET   TikTok probe
 *   INSTAGRAM_ACCESS_TOKEN / TIKTOK_ACCESS_TOKEN / REDDIT_CLIENT_ID …
 *                                              read (never printed) to detect
 *                                              a channel that is already ready
 */
import { classifyAll, actionableChannels, formatVerdictTable, READY } from './lib/social-readiness.mjs';
import { TIKTOK_API } from './lib/tiktok-publish.mjs';
import { GRAPH_API } from './lib/social-post-utils.mjs';

// Shared with the poster and scripts/tiktok-auth.mjs — see that file's note.
const TIKTOK_TOKEN_URL = `${TIKTOK_API}/oauth/token/`;
const PROBE_TIMEOUT_MS = 15000;

async function probeInstagram(env) {
  const pageId = String(env.FB_PAGE_ID || '').trim();
  const token = String(env.FB_PAGE_ACCESS_TOKEN || '').trim();
  if (!pageId || !token) return { pageLinked: false, note: 'no FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN — probe skipped' };
  try {
    const res = await fetch(`${GRAPH_API}/${encodeURIComponent(pageId)}?fields=instagram_business_account&access_token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (data?.error) return { pageLinked: false, note: `Graph API: ${data.error.message}` };
    return {
      pageLinked: Boolean(data?.instagram_business_account?.id),
      note: data?.instagram_business_account?.id ? 'Page exposes instagram_business_account' : 'Page returns no instagram_business_account field',
    };
  } catch (err) {
    return { pageLinked: false, note: `probe failed: ${err.message}` };
  }
}

async function probeTikTok(env) {
  const key = String(env.TIKTOK_CLIENT_KEY || '').trim();
  const secret = String(env.TIKTOK_CLIENT_SECRET || '').trim();
  if (!key || !secret) return { appLive: false, note: 'no TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET — probe skipped' };
  try {
    const res = await fetch(TIKTOK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_key: key, client_secret: secret, grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    return {
      appLive: Boolean(data?.access_token),
      note: data?.access_token ? 'client-credentials token minted — developer app is live' : `no client token: ${data?.error_description || data?.error || `HTTP ${res.status}`}`,
    };
  } catch (err) {
    return { appLive: false, note: `probe failed: ${err.message}` };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const actionableOnly = args.includes('--actionable-only');
  const readyOnly = args.includes('--ready-channels');
  const reasonFor = args.find((a) => a.startsWith('--reason='))?.split('=')[1];
  const env = process.env;

  const [instagram, tiktok] = await Promise.all([probeInstagram(env), probeTikTok(env)]);
  const probes = { instagram, tiktok };
  const all = classifyAll({ env, probes });

  if (readyOnly) {
    console.log(all.filter((v) => v.state === READY).map((v) => v.channel).join(' '));
    return;
  }
  if (reasonFor) {
    console.log(all.find((v) => v.channel === reasonFor)?.reason ?? '');
    return;
  }

  const verdicts = (actionableOnly ? actionableChannels(all) : all).map((v) => ({
    ...v,
    probeNote: probes[v.channel]?.note ?? null,
  }));

  if (asJson) {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), verdicts }, null, 2));
    return;
  }

  console.log('─── social publish readiness ───');
  console.log(formatVerdictTable(verdicts));
  for (const v of verdicts) {
    if (v.probeNote) console.log(`  ↳ ${v.channel}: ${v.probeNote}`);
  }
  const actionable = actionableChannels(all);
  console.log(
    actionable.length
      ? `\n⚠️  ${actionable.length} channel(s) need work now: ${actionable.map((v) => v.channel).join(', ')}`
      : '\n✅ every channel is waiting on a platform-side review — nothing to do here.',
  );
}

main()
  .catch((err) => {
    console.error(`⚠️  check-social-publish-readiness failed: ${err.message}`);
  })
  .finally(() => process.exit(0));
