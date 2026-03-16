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
 * - GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN
 * - GA4_PROPERTY_ID
 *
 * Optional env:
 * - SEO_SERP_AUTOPILOT_DAYS (default 28)
 * - SEO_SERP_AUTOPILOT_ROTATE_DAYS (default 7)
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HISTORY_PATH = path.resolve(ROOT, 'data', 'seo-serp-experiment-history.json');
const LAST_RUN_PATH = path.resolve(ROOT, 'data', 'seo-serp-autopilot-last-run.json');

const DAYS = clampInt(process.env.SEO_SERP_AUTOPILOT_DAYS, 7, 90, 28);
const ROTATE_DAYS = clampInt(process.env.SEO_SERP_AUTOPILOT_ROTATE_DAYS, 3, 21, 7);
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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
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

function chooseNextVariant(currentVariant) {
  if (!VARIANTS.includes(currentVariant)) return VARIANTS[0];
  return currentVariant === VARIANTS[0] ? VARIANTS[1] : VARIANTS[0];
}

function decideVariant({ currentVariant, history, currentKpi, nowIso }) {
  const decision = {
    nextVariant: currentVariant,
    reason: 'keep_current',
    mode: 'explore',
    scores: {},
  };

  if (!VARIANTS.includes(currentVariant)) {
    decision.nextVariant = VARIANTS[0];
    decision.reason = 'bootstrap_from_control';
    decision.mode = 'explore';
    return decision;
  }

  const enoughCurrentData = currentKpi.totalImpressions >= MIN_TOTAL_IMPRESSIONS && currentKpi.totalClicks >= MIN_TOTAL_CLICKS;
  const lastSwitchAt = history.lastSwitchAt || null;
  const sinceSwitchDays = lastSwitchAt ? daysBetween(lastSwitchAt, nowIso) : Infinity;

  const scoreA = aggregateVariantCtr(history, VARIANTS[0]);
  const scoreB = aggregateVariantCtr(history, VARIANTS[1]);
  decision.scores = { [VARIANTS[0]]: scoreA, [VARIANTS[1]]: scoreB };

  const enoughSamples = scoreA.samples >= 2 && scoreB.samples >= 2;
  const enoughTrafficA = scoreA.impressions >= MIN_TOTAL_IMPRESSIONS;
  const enoughTrafficB = scoreB.impressions >= MIN_TOTAL_IMPRESSIONS;

  if (enoughSamples && enoughTrafficA && enoughTrafficB) {
    decision.mode = 'exploit';
    const winner = scoreA.ctr >= scoreB.ctr ? VARIANTS[0] : VARIANTS[1];
    const loser = winner === VARIANTS[0] ? VARIANTS[1] : VARIANTS[0];
    const uplift = decision.scores[winner].ctr - decision.scores[loser].ctr;
    if (winner !== currentVariant && uplift >= MIN_UPLIFT_ABS) {
      decision.nextVariant = winner;
      decision.reason = `switch_to_winner_uplift_${uplift.toFixed(3)}`;
    } else {
      decision.reason = uplift >= MIN_UPLIFT_ABS ? 'winner_already_active' : 'uplift_below_threshold';
    }
    return decision;
  }

  if (!enoughCurrentData) {
    decision.reason = 'insufficient_current_data_keep';
    return decision;
  }

  if (sinceSwitchDays >= ROTATE_DAYS) {
    decision.nextVariant = chooseNextVariant(currentVariant);
    decision.reason = `rotation_every_${ROTATE_DAYS}d`;
  } else {
    decision.reason = 'rotation_cooldown';
  }

  return decision;
}

async function getRemoteConfigTemplate() {
  const adminMod = await import('firebase-admin');
  const admin = adminMod.default || adminMod;
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  const rc = admin.remoteConfig();
  const template = await rc.getTemplate();
  return { rc, template };
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

  writeJson(HISTORY_PATH, history);
  writeJson(LAST_RUN_PATH, report);

  console.log(`🧾 History updated: ${path.relative(ROOT, HISTORY_PATH)}`);
  console.log(`🧾 Last run report: ${path.relative(ROOT, LAST_RUN_PATH)}`);
}

main().catch((err) => {
  console.error('❌ SEO SERP Autopilot failed:', err?.message || err);
  process.exit(1);
});
