#!/usr/bin/env node
/**
 * Frozen-content probe of the weekly newsletter workflow (perf-plan email senders,
 * C4). Prints `needs_llm=true|false` to $GITHUB_OUTPUT so the workflow can skip
 * setup-omniroute and setup-claude-haiku-fallback (~111 s) when every locale of the
 * current campaign already has valid frozen content.
 *
 * Reads at most four documents of `newsletter_campaign_content`, the stored exchange
 * rate and its Firestore history. Writes nothing. Fail-safe by construction: any doubt, error or
 * missing input answers `needs_llm=true` (the setups run exactly as before) and the
 * process always exits 0.
 *
 * The decision logic is `probeFrozenContent` in scripts/lib/newsletter-campaign-content.mjs.
 *
 * Environment: MODE (send|test|preview|dry-run; only `send` can reuse frozen
 * content), NEWSLETTER_CAMPAIGN_CONTENT_FREEZE, NEWSLETTER_CONTENT_FREEZE_RATE_THRESHOLD_PCT,
 * GITHUB_OUTPUT, GOOGLE_APPLICATION_CREDENTIALS.
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { listVariantIds } from '../services/newsletter-subject-variants.mjs';
import { weeklyCampaignId } from './lib/newsletter-ab-data.mjs';
import {
  probeFrozenContent,
  resolveFreezeMode,
  resolveRateThresholdPct,
} from './lib/newsletter-campaign-content.mjs';
import { getFeaturedToolForLocale, getWeeklyFact, loadExchangeFacts } from './lib/newsletter-weekly-facts.mjs';

export async function runProbe({
  env = process.env,
  getDb = async () => (await import('./lib/firestore-admin.mjs')).getFirestoreDb(),
  now = () => new Date(),
  loadFacts = loadExchangeFacts,
} = {}) {
  const mode = String(env.MODE || '').trim().toLowerCase();
  if (mode !== 'send') return { needsLlm: true, reason: `mode:${mode || 'unset'}` };
  if (resolveFreezeMode(env.NEWSLETTER_CAMPAIGN_CONTENT_FREEZE) === 'off') return { needsLlm: true, reason: 'freeze-off' };
  try {
    const db = await getDb();
    // The prompt's facts, computed with the SAME functions as the sender
    // (lib/newsletter-weekly-facts.mjs). The exchange facts need only Firestore reads;
    // with no stored history they are unavailable (never an HTTP call) and the probe
    // answers `needs_llm=true`.
    let exchange;
    const exchangeFacts = async () => {
      if (exchange === undefined) exchange = await loadFacts(db, { nowMs: now().getTime(), allowHttp: false });
      return exchange;
    };
    return await probeFrozenContent({
      db,
      campaignId: weeklyCampaignId(now()),
      variants: listVariantIds(),
      thresholdPct: resolveRateThresholdPct(env.NEWSLETTER_CONTENT_FREEZE_RATE_THRESHOLD_PCT),
      now,
      factsFor: async (locale) => {
        const facts = await exchangeFacts();
        if (!facts) return null;
        return {
          exchangeRate: facts.exchangeRate,
          exchangeInsight: facts.exchangeInsight,
          weeklyFact: getWeeklyFact(locale, now().getTime()),
          featuredTool: getFeaturedToolForLocale(locale, now().getTime()),
        };
      },
    });
  } catch (error) {
    return { needsLlm: true, reason: `error:${String(error?.message || error).slice(0, 80)}` };
  }
}

export function writeOutput(result, { env = process.env, append = appendFileSync, log = console.log } = {}) {
  const line = `needs_llm=${result.needsLlm ? 'true' : 'false'}`;
  log(`🧊 newsletter content probe: ${line} (${result.reason})`);
  if (env.GITHUB_OUTPUT) {
    try { append(env.GITHUB_OUTPUT, `${line}\n`); } catch { /* the default (setups run) applies */ }
  }
}

const invokedDirectly = process.argv[1] && (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (invokedDirectly) {
  runProbe()
    .then((result) => writeOutput(result))
    .catch((error) => writeOutput({ needsLlm: true, reason: `fatal:${String(error?.message || error).slice(0, 80)}` }))
    .finally(() => process.exit(0));
}
