#!/usr/bin/env node
/**
 * check-social-publish-readiness.mjs — asks each social publishing channel's
 * platform whether it will let us post yet, and prints one verdict per channel.
 *
 * The decision table is scripts/lib/social-readiness.mjs (pure, unit-tested).
 * This file is only the network half: read-only Meta probes, no writes, no post.
 *
 *   Instagram  GET  /{FB_PAGE_ID}?fields=id,access_token,tasks,instagram_business_account
 *              GET  /me/permissions
 *              GET  /{INSTAGRAM_BUSINESS_ACCOUNT_ID}?fields=id
 *              Checks the Page link, CREATE_CONTENT task, and that the publisher
 *              token matches the Page token emitted for this same user token;
 *              also checks the publish grant and publisher account identity.
 *              A missing Page field remains ambiguous: it can mean the Page is
 *              unlinked or the app lacks the scope.
 *
 *   TikTok     no publish-readiness probe — current guidelines hold the
 *              internal team uploader even when tokens or an API audit exist.
 *
 *   Reddit     no probe — the Data Access Request was denied outright. The
 *              classic publisher stays closed without explicit approval.
 *
 * Platform/network errors become explicit unavailable results. Unexpected
 * internal failures exit nonzero so the workflow's self-alert can detect a
 * broken monitor and cannot resolve an owner-action issue on empty output.
 *
 * Usage:
 *   node scripts/check-social-publish-readiness.mjs            # table
 *   node scripts/check-social-publish-readiness.mjs --json     # machine-readable
 *   node scripts/check-social-publish-readiness.mjs --json --actionable-only
 *   node scripts/check-social-publish-readiness.mjs --ready-channels   # names, space-separated
 *   node scripts/check-social-publish-readiness.mjs --action-required-channels
 *   node scripts/check-social-publish-readiness.mjs --reason=tiktok    # one reason line
 *
 * The last two exist so .github/workflows/social-publish-readiness-watch.yml
 * can read a verdict without an inline `node -e` reaching into the JSON: an
 * eval one-liner inside YAML inside a shell loop is three layers of quoting to
 * get wrong, and it fails silently by printing nothing.
 *
 * Env (all via Firebase Remote Config → scripts/load-rc-env.mjs):
 *   FB_PAGE_ID + FB_USER_ACCESS_TOKEN          Instagram Page-link probe
 *   INSTAGRAM_ACCESS_TOKEN / REDDIT_DATA_API_APPROVED / REDDIT_CLIENT_ID …
 *                                              read (never printed) to detect
 *                                              a channel that is already ready
 */
import {
  classifyAll,
  actionableChannels,
  formatVerdictTable,
  instagramSetupActionChannels,
  READY,
} from './lib/social-readiness.mjs';
import { probeInstagramPageLink } from './lib/instagram-page-link-probe.mjs';
import {
  probeInstagramPublishPermission,
  probeInstagramPublisherToken,
} from './lib/instagram-publisher-readiness-probes.mjs';

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const actionableOnly = args.includes('--actionable-only');
  const readyOnly = args.includes('--ready-channels');
  const actionRequiredOnly = args.includes('--action-required-channels');
  const reasonFor = args.find((a) => a.startsWith('--reason='))?.split('=')[1];
  const env = process.env;

  const [pageLink, publishPermission, publisherToken] = await Promise.all([
    probeInstagramPageLink({
      pageId: env.FB_PAGE_ID,
      userAccessToken: env.FB_USER_ACCESS_TOKEN,
      instagramAccountId: env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
      publisherAccessToken: env.INSTAGRAM_ACCESS_TOKEN,
    }),
    probeInstagramPublishPermission({ userAccessToken: env.FB_USER_ACCESS_TOKEN }),
    probeInstagramPublisherToken({
      instagramAccountId: env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
      accessToken: env.INSTAGRAM_ACCESS_TOKEN,
    }),
  ]);
  const instagram = {
    ...pageLink,
    ...publishPermission,
    ...publisherToken,
    note: [pageLink.note, publishPermission.note, publisherToken.note].filter(Boolean).join('; '),
  };
  const probes = { instagram };
  const all = classifyAll({ env, probes });

  if (readyOnly) {
    console.log(all.filter((v) => v.state === READY).map((v) => v.channel).join(' '));
    return;
  }
  if (actionRequiredOnly) {
    console.log(instagramSetupActionChannels(all).map((v) => v.channel).join(' '));
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
    console.error(`⚠️  check-social-publish-readiness failed: ${err?.message || 'unexpected error'}`);
    process.exitCode = 1;
  });
