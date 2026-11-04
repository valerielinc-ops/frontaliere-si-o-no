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
 *   node scripts/check-social-publish-readiness.mjs --github-summary   # full report + one-probe workflow outputs
 *
 * `--github-summary` lets .github/workflows/social-publish-readiness-watch.yml
 * write verdicts and reasons from one probe, avoiding repeated platform reads
 * and inline JSON parsing in shell.
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
import { appendFileSync } from 'node:fs';
import {
  buildInstagramCapabilityMonitorOutputs,
  checkInstagramPublishReadiness,
} from './lib/instagram-publish-readiness.mjs';
import { classifyMetaTokenLifecycle } from './lib/meta-token-lifecycle.mjs';

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const githubSummary = args.includes('--github-summary');
  const actionableOnly = args.includes('--actionable-only');
  const readyOnly = args.includes('--ready-channels');
  const actionRequiredOnly = args.includes('--action-required-channels');
  const reasonFor = args.find((a) => a.startsWith('--reason='))?.split('=')[1];
  const env = process.env;
  const metaTokenLifecycle = classifyMetaTokenLifecycle({ env });

  const { verdict: instagram, probe, capabilities } = await checkInstagramPublishReadiness({ env });
  const capabilityMonitor = buildInstagramCapabilityMonitorOutputs(capabilities, probe);
  const probes = { instagram: { ...instagram, ...probe } };
  const all = classifyAll({ env, probes });
  const capabilityLines = Object.entries(capabilities).map(([name, capability]) => {
    const key = name.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
    return `instagram_capability_${key}=${capability.state}`;
  });
  const capabilitySummary = [
    '### Instagram capability readiness',
    '',
    '| Capability | State | Required access | Detail |',
    '|---|---|---|---|',
    ...Object.entries(capabilities).map(([name, capability]) => (
      `| ${name} | ${capability.state} | ${capability.requiredPermissions.join(', ')}${capability.pageTask ? `; Page ${capability.pageTask}` : ''} | ${capability.reason}${capability.eligibilityNote ? `; ${capability.eligibilityNote}` : ''} |`
    )),
  ].join('\n');
  const metaTokenLifecycleSummary = [
    '### Meta token lifecycle',
    '',
    `State: **${metaTokenLifecycle.state}**`,
    '',
    metaTokenLifecycle.reason,
  ].join('\n');

  if (githubSummary) {
    if (!env.GITHUB_OUTPUT) throw new Error('--github-summary requires GITHUB_OUTPUT');
    const ready = all.filter((verdict) => verdict.state === READY).map((verdict) => verdict.channel);
    const actionRequired = instagramSetupActionChannels(all).map((verdict) => verdict.channel);
    const lines = [
      `ready=${ready.join(' ')}`,
      `action_required=${actionRequired.join(' ')}`,
      `capability_action_required=${capabilityMonitor.actionRequired.join(' ')}`,
      `capability_ready=${capabilityMonitor.ready.join(' ')}`,
      `meta_token_lifecycle_state=${metaTokenLifecycle.state}`,
      `meta_token_lifecycle_action_required=${metaTokenLifecycle.actionRequired}`,
      `meta_token_lifecycle_reason=${String(metaTokenLifecycle.reason).replace(/[\r\n]+/gu, ' ')}`,
      ...capabilityLines,
      ...Object.entries(capabilityMonitor.reasons).map(([name, reason]) => (
        `reason_capability_${name}=${String(reason).replace(/[\r\n]+/gu, ' ')}`
      )),
      ...all.map((verdict) => `reason_${verdict.channel}=${String(verdict.reason).replace(/[\r\n]+/gu, ' ')}`),
    ];
    appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, 'utf8');
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${capabilitySummary}\n\n${metaTokenLifecycleSummary}\n`, 'utf8');
    const verdicts = all.map((verdict) => ({
      ...verdict,
      probeNote: probes[verdict.channel]?.note ?? null,
    }));
    console.log('─── social publish readiness ───');
    console.log(formatVerdictTable(verdicts));
    console.log(`\n${capabilitySummary}`);
    console.log(`\n${metaTokenLifecycleSummary}`);
    for (const verdict of verdicts) {
      if (verdict.probeNote) console.log(`  ↳ ${verdict.channel}: ${verdict.probeNote}`);
    }
    const actionable = actionableChannels(all);
    console.log(
      actionable.length
        ? `\n⚠️  ${actionable.length} channel(s) need work now: ${actionable.map((verdict) => verdict.channel).join(', ')}`
        : '\n✅ every channel is waiting on a platform-side review — nothing to do here.',
    );
    return;
  }

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
    console.log(JSON.stringify({
      checkedAt: new Date().toISOString(),
      verdicts,
      instagramCapabilities: capabilities,
      instagramCapabilityMonitor: capabilityMonitor,
      metaTokenLifecycle,
    }, null, 2));
    return;
  }

  console.log('─── social publish readiness ───');
  console.log(formatVerdictTable(verdicts));
  console.log(`\n${capabilitySummary}`);
  console.log(`\n${metaTokenLifecycleSummary}`);
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
