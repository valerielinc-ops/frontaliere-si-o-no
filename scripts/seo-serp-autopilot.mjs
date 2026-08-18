#!/usr/bin/env node

/**
 * SEO SERP Autopilot
 *
 * Goal:
 * - Run SEO telemetry (GSC + GA4) automatically
 * - Compute stable KPI snapshots
 * - Rotate/test variants while data is insufficient
 * - Pick winning variant when enough evidence exists
 * - Update Firebase Remote Config automatically
 *
 * Required env (for full mode):
 * - GOOGLE_APPLICATION_CREDENTIALS (Firebase service account JSON path)
 * - GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN (from Remote Config)
 * - GA4_PROPERTY_ID
 *
 * Optional env:
 * - SEO_SERP_AUTOPILOT_DAYS (default 28)
 * - SEO_SERP_AUTOPILOT_ROTATE_DAYS (default 7)
 * - SEO_SERP_AUTOPILOT_REVALIDATE_DAYS (default 60)
 * - SEO_SERP_AUTOPILOT_MIN_PAGE_IMPRESSIONS (default 150)
 * - SEO_SERP_AUTOPILOT_MIN_TOTAL_IMPRESSIONS (default 4000)
 * - SEO_SERP_AUTOPILOT_MIN_TOTAL_CLICKS (default 80)
 * - SEO_SERP_AUTOPILOT_MIN_UPLIFT_ABS (default 0.15)
 * - SEO_SERP_AUTOPILOT_DRY_RUN (true|false, default false)
 * - SEO_SERP_EXPERIMENT_TARGETS (fallback '*')
 * - SEO_SERP_EXPERIMENT_YEAR (fallback current year)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { getRemoteConfig } from './lib/remote-config-admin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HISTORY_PATH = path.resolve(ROOT, 'data', 'seo-serp-experiment-history.json');
const LAST_RUN_PATH = path.resolve(ROOT, 'data', 'seo-serp-autopilot-last-run.json');

const DAYS = clampInt(process.env.SEO_SERP_AUTOPILOT_DAYS, 7, 90, 28);
const ROTATE_DAYS = clampInt(process.env.SEO_SERP_AUTOPILOT_ROTATE_DAYS, 3, 21, 7);
// How long a winner may hold the slot before the challengers get another turn.
const REVALIDATE_DAYS = clampInt(process.env.SEO_SERP_AUTOPILOT_REVALIDATE_DAYS, 14, 365, 60);
const MIN_PAGE_IMPRESSIONS = clampInt(process.env.SEO_SERP_AUTOPILOT_MIN_PAGE_IMPRESSIONS, 50, 5000, 150);
const MIN_TOTAL_IMPRESSIONS = clampInt(process.env.SEO_SERP_AUTOPILOT_MIN_TOTAL_IMPRESSIONS, 500, 200000, 4000);
const MIN_TOTAL_CLICKS = clampInt(process.env.SEO_SERP_AUTOPILOT_MIN_TOTAL_CLICKS, 20, 50000, 80);
const MIN_UPLIFT_ABS = clampNum(process.env.SEO_SERP_AUTOPILOT_MIN_UPLIFT_ABS, 0.05, 2.0, 0.15);
const DRY_RUN = process.env.SEO_SERP_AUTOPILOT_DRY_RUN === 'true';

const VARIANTS = ['year_intent', 'intent_simulation'];

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNum(value, min, max, fallback) {
  const n = Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function runAnalyticsReportJson(days) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'node',
      ['scripts/analytics-report.mjs', '--json', '--gsc', '--ga4', '--days', String(days)],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`analytics-report exit code ${code}: ${stderr || stdout}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`Invalid JSON from analytics-report: ${e.message}`));
      }
    });
  });
}

function toIsoDate(d) {
  return new Date(d).toISOString();
}

function normalizeTopPages(topPages) {
  if (!Array.isArray(topPages)) return [];
  return topPages
    .map((p) => ({
      page: String(p.page || '/'),
      clicks: Number(p.clicks || 0),
      impressions: Number(p.impressions || 0),
      ctr: Number(p.ctr || 0),
      position: Number(p.position || 0),
    }))
    .filter((p) => p.impressions >= MIN_PAGE_IMPRESSIONS);
}

function computeKpi(report) {
  const pages = normalizeTopPages(report?.searchConsole?.topPages || []);
  const totalImpressions = pages.reduce((s, p) => s + p.impressions, 0);
  const totalClicks = pages.reduce((s, p) => s + p.clicks, 0);
  const weightedCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
  const opportunities = pages.filter((p) => p.impressions >= 500 && p.ctr <= 2.0).length;
  const exposures = Array.isArray(report?.ga4?.serpExperiment)
    ? report.ga4.serpExperiment.reduce((s, r) => s + Number(r.eventCount || 0), 0)
    : 0;

  return {
    consideredPages: pages.length,
    totalImpressions,
    totalClicks,
    weightedCtr: Number(weightedCtr.toFixed(3)),
    opportunities,
    exposures,
  };
}

function parseRemoteParamString(template, key, fallback = '') {
  const v = template?.parameters?.[key]?.defaultValue?.value;
  if (typeof v === 'string') return v;
  return fallback;
}

function setRemoteParam(template, key, value) {
  template.parameters ||= {};
  template.parameters[key] ||= {};
  template.parameters[key].defaultValue = { value: String(value) };
}

function daysBetween(aIso, bIso) {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.floor(Math.abs(a - b) / (24 * 60 * 60 * 1000));
}

function aggregateVariantCtr(history, variant, lookbackDays = 120) {
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const snaps = history.snapshots.filter(
    (s) => s.variant === variant && new Date(s.createdAt).getTime() >= cutoff
  );
  const impressions = snaps.reduce((s, n) => s + Number(n.kpi?.totalImpressions || 0), 0);
  const clicks = snaps.reduce((s, n) => s + Number(n.kpi?.totalClicks || 0), 0);
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
  return {
    samples: snaps.length,
    impressions,
    clicks,
    ctr: Number(ctr.toFixed(3)),
  };
}

/** Most recent snapshot timestamp for a variant, or null if never sampled. */
function lastSampledAt(history, variant) {
  let latest = null;
  for (const snap of history?.snapshots || []) {
    if (snap.variant !== variant) continue;
    const t = new Date(snap.createdAt).getTime();
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

/**
 * Whose turn it is next. With two arms this is the old alternation; with three
 * or more, picking the least recently sampled one is what stops a newly added
 * arm from never getting a turn — the old toggle could only ever see two.
 */
export function chooseNextVariant(currentVariant, history, variants = VARIANTS) {
  const others = variants.filter((v) => v !== currentVariant);
  if (!others.length) return variants[0];
  return others
    .slice()
    .sort((a, b) => (lastSampledAt(history, a) ?? -Infinity) - (lastSampledAt(history, b) ?? -Infinity))[0];
}

/**
 * What the exploit branch would do: which arm leads, and the two margins the
 * decision reads. Pure, so the arithmetic can be driven directly at arities
 * `decideVariant` needs a whole history+KPI fixture to reach.
 *
 * The two margins are NOT interchangeable, and are named apart because
 * conflating them is exactly the defect this function exists to prevent:
 *
 * - `uplift` is winner-minus-CURRENT — the gain from replacing the live arm,
 *   and the only margin that may gate a switch. It is `null` when the winner
 *   is already live: there is no arm being replaced, so the switch margin does
 *   not exist rather than being zero.
 * - `lead` is winner-minus-RUNNER-UP — how safe an already-live winner is, and
 *   the number `winner_already_active` has always carried.
 *
 * With two arms they coincide whenever a switch is on the table (if the winner
 * is not current, current IS the runner-up), which is why gating the switch on
 * `lead` stayed invisible. At three arms they diverge: 7.60 / 7.55 / 6.00 with
 * the worst arm live reads `lead` 0.05 — under the threshold, no switch — while
 * `uplift` is 1.60. Read the wrong one and the autopilot pins the site to its
 * worst arm, for REVALIDATE_DAYS at a stretch, because exploit returns before
 * rotation can be reached.
 *
 * Precondition: `currentVariant` is one of `variants`. `decideVariant`
 * guarantees it by bootstrapping out first, so there is no defensive branch
 * here for a value that cannot arrive.
 */
export function chooseExploitTarget(scores, variants, currentVariant, minUplift = MIN_UPLIFT_ABS) {
  const ranked = variants.slice().sort((a, b) => scores[b].ctr - scores[a].ctr);
  const winner = ranked[0];
  // A one-arm experiment has no runner-up. `variants` is injectable and
  // `chooseNextVariant` already answers for a single arm, so this arity is
  // reachable; reading `ranked[1]` blind makes the exploit branch evaluate
  // `scores[undefined].ctr` and throw.
  const runnerUp = ranked.length > 1 ? ranked[1] : winner;
  const uplift = winner === currentVariant ? null : scores[winner].ctr - scores[currentVariant].ctr;
  const lead = scores[winner].ctr - scores[runnerUp].ctr;
  return { winner, runnerUp, uplift, lead, shouldSwitch: uplift !== null && uplift >= minUplift };
}

export function decideVariant({ currentVariant, history, currentKpi, nowIso, variants = VARIANTS }) {
  const decision = {
    nextVariant: currentVariant,
    reason: 'keep_current',
    mode: 'explore',
    scores: {},
  };

  if (!variants.includes(currentVariant)) {
    decision.nextVariant = variants[0];
    decision.reason = 'bootstrap_from_control';
    decision.mode = 'explore';
    return decision;
  }

  const enoughCurrentData = currentKpi.totalImpressions >= MIN_TOTAL_IMPRESSIONS && currentKpi.totalClicks >= MIN_TOTAL_CLICKS;
  const lastSwitchAt = history.lastSwitchAt || null;
  const sinceSwitchDays = lastSwitchAt ? daysBetween(lastSwitchAt, nowIso) : Infinity;

  // Score every arm, not just the first two: adding a third variant used to
  // leave it permanently unscored and therefore unpickable.
  const scores = {};
  for (const v of variants) scores[v] = aggregateVariantCtr(history, v);
  decision.scores = scores;

  const comparable = variants.every(
    (v) => scores[v].samples >= 2 && scores[v].impressions >= MIN_TOTAL_IMPRESSIONS,
  );

  // A winner does not hold the slot forever. Exploit used to `return` before
  // the rotation branch below could ever be reached, so the only thing that
  // ever reopened the experiment was the challenger's samples ageing out of
  // aggregateVariantCtr's 120-day lookback — about four months of silence, by
  // accident rather than by design, and no way at all to give a newly added
  // arm a turn. Revalidation makes that cadence deliberate: the challengers
  // get one rotation slot back every REVALIDATE_DAYS, then the winner resumes
  // unless the fresh sample actually beat it.
  const dueForRevalidation = sinceSwitchDays >= REVALIDATE_DAYS;

  if (comparable && !dueForRevalidation) {
    decision.mode = 'exploit';
    // `variants`, not the VARIANTS module constant: the exploit branch has to
    // rank the same arms the rest of the function scored, or an injected third
    // arm gets a score and is then never ranked.
    const { winner, uplift, lead, shouldSwitch } = chooseExploitTarget(scores, variants, currentVariant);
    if (shouldSwitch) {
      decision.nextVariant = winner;
      decision.reason = `switch_to_winner_uplift_${uplift.toFixed(3)}`;
      return decision;
    }
    if (uplift !== null) {
      // A switch was on the table — the winner is not the live arm — and the
      // gain over the arm it would replace did not clear the bar.
      decision.reason = 'uplift_below_threshold';
      return decision;
    }
    // The winner is already live, so the question is no longer "should we
    // switch" but "how safe is the lead" — and that is measured against the
    // closest challenger.
    decision.reason = lead >= MIN_UPLIFT_ABS ? 'winner_already_active' : 'uplift_below_threshold';
    return decision;
  }

  if (!enoughCurrentData) {
    decision.reason = 'insufficient_current_data_keep';
    return decision;
  }

  if (comparable && dueForRevalidation) {
    decision.mode = 'explore';
    decision.nextVariant = chooseNextVariant(currentVariant, history, variants);
    decision.reason = `revalidate_after_${REVALIDATE_DAYS}d`;
    return decision;
  }

  if (sinceSwitchDays >= ROTATE_DAYS) {
    decision.nextVariant = chooseNextVariant(currentVariant, history, variants);
    decision.reason = `rotation_every_${ROTATE_DAYS}d`;
  } else {
    decision.reason = 'rotation_cooldown';
  }

  return decision;
}

async function getRemoteConfigTemplate() {
  const rc = await getRemoteConfig();
  const template = await rc.getTemplate();
  return { rc, template };
}

/**
 * The client ships a hardcoded variant for when the public-config fetch fails
 * (REMOTE_CONFIG_DEFAULTS in services/firebase.ts). Remote Config can be
 * republished from here, that constant cannot — so every promotion silently
 * widens the gap between what the autopilot chose and what a visitor whose
 * config fetch failed actually gets. Nothing else compares the pair, so this
 * run is the only place the drift can surface. Warning only: an SEO title
 * fallback is not worth failing a scheduled job over.
 */
function warnIfClientFallbackDrifted(promotedVariant) {
  try {
    const src = fs.readFileSync(path.resolve(ROOT, 'services/firebase.ts'), 'utf8');
    const m = /SEO_SERP_EXPERIMENT_VARIANT:\s*'([^']+)'/.exec(src);
    if (!m) return;
    if (m[1] !== promotedVariant) {
      console.warn(
        `⚠️  Client fallback drift: services/firebase.ts serves '${m[1]}' when the public config fails, `
        + `but the promoted variant is '${promotedVariant}'. Update REMOTE_CONFIG_DEFAULTS.`,
      );
    }
  } catch (err) {
    // Never a reason to fail the run — but never silent either. Swallowing
    // every read error means a wrong ROOT, a renamed file or a sparse checkout
    // turns this into a check that can no longer ever fire, and nothing says so.
    console.warn(`⚠️  Could not read services/firebase.ts to check the client fallback: ${err?.message || err}`);
  }
}

async function main() {
  const nowIso = toIsoDate(Date.now());
  const year = process.env.SEO_SERP_EXPERIMENT_YEAR || String(new Date().getUTCFullYear());
  const targets = process.env.SEO_SERP_EXPERIMENT_TARGETS || '*';

  console.log('🧪 SEO SERP Autopilot');
  console.log(`ℹ️  days=${DAYS} rotateDays=${ROTATE_DAYS} minImpr=${MIN_TOTAL_IMPRESSIONS} minClicks=${MIN_TOTAL_CLICKS} minUplift=${MIN_UPLIFT_ABS}`);

  const analytics = await runAnalyticsReportJson(DAYS);
  const kpi = computeKpi(analytics);
  console.log(`📊 KPI: pages=${kpi.consideredPages}, impressions=${kpi.totalImpressions}, clicks=${kpi.totalClicks}, ctr=${kpi.weightedCtr}% exposures=${kpi.exposures}`);

  const history = readJson(HISTORY_PATH, {
    version: 1,
    updatedAt: null,
    lastSwitchAt: null,
    lastVariant: null,
    snapshots: [],
  });

  let rc = null;
  let template = { parameters: {} };
  try {
    const loaded = await getRemoteConfigTemplate();
    rc = loaded.rc;
    template = loaded.template;
  } catch (err) {
    if (!DRY_RUN) {
      throw err;
    }
    console.warn(`⚠️ Remote Config unavailable in dry-run (${err?.message || err}). Using local fallback values.`);
  }

  const currentEnabled = parseRemoteParamString(template, 'SEO_SERP_EXPERIMENT_ENABLED', 'true') === 'true';
  const currentVariant = parseRemoteParamString(template, 'SEO_SERP_EXPERIMENT_VARIANT', 'year_intent');
  const currentTargets = parseRemoteParamString(template, 'SEO_SERP_EXPERIMENT_TARGETS', '*');
  const currentYear = parseRemoteParamString(template, 'SEO_SERP_EXPERIMENT_YEAR', String(new Date().getUTCFullYear()));

  const snapshot = {
    createdAt: nowIso,
    variant: currentVariant,
    enabled: currentEnabled,
    kpi,
    period: analytics?.searchConsole?.period || analytics?.ga4?.period || `${DAYS}d`,
  };
  history.snapshots.push(snapshot);
  history.snapshots = history.snapshots.slice(-260); // ~5 years weekly

  const decision = decideVariant({ currentVariant, history, currentKpi: kpi, nowIso });

  const desiredEnabled = true;
  const desiredVariant = decision.nextVariant;
  const desiredTargets = targets || '*';
  const desiredYear = String(year || new Date().getUTCFullYear());

  let changed = false;
  if (String(desiredEnabled) !== String(currentEnabled)) changed = true;
  if (desiredVariant !== currentVariant) changed = true;
  if (desiredTargets !== currentTargets) changed = true;
  if (desiredYear !== currentYear) changed = true;

  setRemoteParam(template, 'SEO_SERP_EXPERIMENT_ENABLED', desiredEnabled ? 'true' : 'false');
  setRemoteParam(template, 'SEO_SERP_EXPERIMENT_VARIANT', desiredVariant);
  setRemoteParam(template, 'SEO_SERP_EXPERIMENT_TARGETS', desiredTargets);
  setRemoteParam(template, 'SEO_SERP_EXPERIMENT_YEAR', desiredYear);

  if (desiredVariant !== currentVariant) {
    history.lastSwitchAt = nowIso;
    history.lastVariant = desiredVariant;
  } else {
    history.lastVariant = currentVariant;
  }
  history.updatedAt = nowIso;

  const report = {
    generatedAt: nowIso,
    config: {
      days: DAYS,
      rotateDays: ROTATE_DAYS,
      minPageImpressions: MIN_PAGE_IMPRESSIONS,
      minTotalImpressions: MIN_TOTAL_IMPRESSIONS,
      minTotalClicks: MIN_TOTAL_CLICKS,
      minUpliftAbs: MIN_UPLIFT_ABS,
      dryRun: DRY_RUN,
    },
    current: {
      enabled: currentEnabled,
      variant: currentVariant,
      targets: currentTargets,
      year: currentYear,
    },
    desired: {
      enabled: desiredEnabled,
      variant: desiredVariant,
      targets: desiredTargets,
      year: desiredYear,
    },
    decision,
    kpi,
    changed,
    published: false,
  };

  if (!DRY_RUN && changed) {
    if (!rc) throw new Error('Remote Config client not initialized');
    await rc.publishTemplate(template, { force: true });
    report.published = true;
    console.log(`✅ Remote Config updated: variant=${desiredVariant}, enabled=true, targets=${desiredTargets}, year=${desiredYear}`);
  } else {
    console.log(changed ? '🧪 DRY RUN: changes computed but not published.' : 'ℹ️ No Remote Config changes needed.');
  }

  warnIfClientFallbackDrifted(desiredVariant);
  writeJson(HISTORY_PATH, history);
  writeJson(LAST_RUN_PATH, report);

  console.log(`🧾 History updated: ${path.relative(ROOT, HISTORY_PATH)}`);
  console.log(`🧾 Last run report: ${path.relative(ROOT, LAST_RUN_PATH)}`);
}

// Only run when executed directly. Without this, importing the module to test
// decideVariant() would run the whole autopilot — hitting GSC and GA4 and
// publishing Remote Config as a side effect of a unit test. Same guard as
// scripts/check-unsubscribe-credential-rate.mjs.
const invokedDirectly = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('seo-serp-autopilot.mjs');
if (invokedDirectly) {
  main().catch((err) => {
    console.error('❌ SEO SERP Autopilot failed:', err?.message || err);
    process.exit(1);
  });
}
