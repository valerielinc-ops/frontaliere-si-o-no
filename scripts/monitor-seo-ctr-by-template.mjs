#!/usr/bin/env node
/**
 * monitor-seo-ctr-by-template.mjs — scheduled CTR-vs-expected monitor
 * (issue #4300, plan item 5).
 *
 * Weekly: for each monitored template family (scripts/lib/seo-ctr-curve.mjs),
 * pulls a trailing 14-day GSC CTR and compares it against the family's
 * target. A family below target for 2 CONSECUTIVE scheduled runs (~2 weeks
 * at the weekly cron cadence) opens a GitHub issue via
 * scripts/lib/github-issue-creator.mjs with a stable, dedup-friendly title —
 * re-runs while still below threshold post a comment on the same issue
 * instead of duplicating it (github-issue-creator's built-in title-prefix
 * dedup). Recovering above target resets the counter; no auto-close (left to
 * human review, consistent with the rest of the monitor fleet).
 *
 * State persisted in data/seo-ctr-monitor-state.json so consecutive-run
 * counting survives across scheduled workflow invocations.
 *
 * Auth: Firebase service-account JSON via GOOGLE_APPLICATION_CREDENTIALS
 * (same as scripts/seo-ctr-baseline.mjs).
 *
 * Usage: node scripts/monitor-seo-ctr-by-template.mjs [--dry-run]
 *
 * Always exits 0 — monitoring only, never blocks CI.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fetchGscByPage } from './lib/perf-sources/gsc.mjs';
import { SEO_CTR_FAMILIES, aggregateFamilyRows } from './lib/seo-ctr-curve.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const STATE_PATH = resolve(ROOT, 'data', 'seo-ctr-monitor-state.json');
const WINDOW_DAYS = 14;
const CONSECUTIVE_RUNS_TO_ESCALATE = 2;

const dryRun = process.argv.includes('--dry-run');

function pct(n) {
  return n === null || n === undefined ? 'n/a' : `${(n * 100).toFixed(2)}%`;
}

function loadState() {
  if (!existsSync(STATE_PATH)) return { families: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.families ? parsed : { families: {} };
  } catch {
    return { families: {} };
  }
}

async function openOrCommentIssue({ family, ctr, target, run }) {
  if (dryRun) {
    console.log(`   [dry-run] avrei aperto/commentato issue per ${family.label}`);
    return;
  }
  try {
    const { createGithubIssue } = await import('./lib/github-issue-creator.mjs');
    await createGithubIssue({
      title: `SEO CTR sotto soglia: template ${family.label}`,
      description: `## CTR sotto target — ${family.label}

**Path family:** \`${family.pathContains}\`
**CTR attuale (14gg):** ${pct(ctr)}
**Target:** ${pct(target)}
**Check consecutivi sotto soglia:** ${run}

Il monitor CTR-per-template (issue #4300, scripts/monitor-seo-ctr-by-template.mjs)
ha rilevato che questa famiglia di pagine resta sotto la soglia CTR attesa per
${run} controlli settimanali consecutivi (~${run} settimane).

Prossimi passi suggeriti: rivedere title/description generator per questa
famiglia (services/seo/seo-pages.ts per guida/tasse, build-plugins/ogPagesPlugin.ts
per gli articoli), verificare rich-results (FAQPage/HowTo) e considerare
l'estensione dell'A/B SERP autopilot esistente.`,
      priority: 3,
      labels: ['seo'],
      workflow: 'Monitor SEO CTR by Template',
    });
  } catch (e) {
    console.warn(`   ⚠️ impossibile creare/aggiornare issue: ${e.message}`);
  }
}

async function main() {
  const state = loadState();
  const nowIso = new Date().toISOString();
  const monitored = SEO_CTR_FAMILIES.filter((f) => f.monitored);

  for (const family of monitored) {
    console.log(`\n📊 ${family.label} (${family.pathContains})`);
    const prior = state.families[family.id] || { consecutiveBelowRuns: 0 };

    let ctr = null;
    try {
      const { perPath } = await fetchGscByPage({ windowDays: WINDOW_DAYS, pathContains: family.pathContains });
      const pageRows = [...perPath.entries()].map(([path, metrics]) => ({ path, ...metrics }));
      const agg = aggregateFamilyRows(pageRows, { minImpressions: 5 });
      ctr = agg.avgCtr;
      console.log(`   CTR (${WINDOW_DAYS}gg): ${pct(ctr)} | target: ${pct(family.targetCtr)} | pagine: ${agg.pageCount}`);
    } catch (e) {
      console.warn(`   ⚠️ errore GSC, salto questo giro: ${e.message}`);
      // Don't touch the counter on a fetch failure — avoid false escalation
      // from a transient API blip.
      state.families[family.id] = { ...prior, lastCheckedIso: nowIso, lastError: e.message };
      continue;
    }

    const belowTarget = ctr !== null && ctr < family.targetCtr;
    const consecutiveBelowRuns = belowTarget ? (prior.consecutiveBelowRuns || 0) + 1 : 0;

    if (belowTarget) {
      console.log(`   ⚠️ sotto soglia (giro consecutivo #${consecutiveBelowRuns})`);
      if (consecutiveBelowRuns >= CONSECUTIVE_RUNS_TO_ESCALATE) {
        await openOrCommentIssue({ family, ctr, target: family.targetCtr, run: consecutiveBelowRuns });
      }
    } else {
      console.log('   ✅ CTR nella norma');
    }

    state.families[family.id] = {
      consecutiveBelowRuns,
      lastCtr: ctr,
      lastCheckedIso: nowIso,
      lastError: null,
    };
  }

  if (!dryRun) {
    writeJsonAtomic(STATE_PATH, state);
    console.log(`\n💾 Stato monitor salvato: ${STATE_PATH}`);
  }
}

main().catch((e) => {
  console.error('monitor-seo-ctr-by-template failed (non-blocking):', e.message);
  process.exitCode = 0;
});
