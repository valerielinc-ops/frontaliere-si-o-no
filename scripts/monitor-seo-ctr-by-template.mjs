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
 * Also runs a family-discovery pass each week: pulls site-wide GSC pages
 * over a trailing 90-day window and flags any path segment carrying
 * MIN_IMPRESSIONS_TO_MONITOR+ impressions that isn't in the registry yet
 * (scripts/lib/seo-ctr-curve.mjs's discoverUnregisteredFamilies) — the
 * automated version of what issue #4300 did by hand for
 * `/cerca-lavoro-ticino/`, which sat unmonitored at 911k impressions/90gg
 * for years before someone noticed. Opens/comments a GitHub issue per
 * candidate for human triage when classification is ambiguous; deterministic
 * candidates (`locale`, nota job-board known via `services/router.ts`,
 * noto in `build-plugins/fuelDailyData.ts`) are now auto-registered in
 * `scripts/lib/seo-ctr-curve.mjs`.
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fetchGscByPage } from './lib/perf-sources/gsc.mjs';
import {
  SEO_CTR_FAMILIES,
  MIN_IMPRESSIONS_TO_MONITOR,
  aggregateFamilyRows,
  effectiveTargetCtr,
  discoverUnregisteredFamilies,
  familyPathPrefixes,
  classifyUnregisteredFamilyCandidate,
} from './lib/seo-ctr-curve.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const STATE_PATH = resolve(ROOT, 'data', 'seo-ctr-monitor-state.json');
const SEO_CTR_CURVE_PATH = resolve(ROOT, 'scripts', 'lib', 'seo-ctr-curve.mjs');
const WINDOW_DAYS = 14;
const CONSECUTIVE_RUNS_TO_ESCALATE = 2;
const DISCOVERY_WINDOW_DAYS = 90;

const dryRun = process.argv.includes('--dry-run');

function pct(n) {
  return n === null || n === undefined ? 'n/a' : `${(n * 100).toFixed(2)}%`;
}

function escapeSingleQuotes(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function serializeFamilyForCurve(family) {
  const lines = [
    '  {',
    `    id: '${escapeSingleQuotes(family.id)}',`,
    `    label: '${escapeSingleQuotes(family.label)}',`,
    `    pathContains: '${escapeSingleQuotes(family.pathContains)}',`,
  ];

  if (Array.isArray(family.pathAliases) && family.pathAliases.length > 0) {
    const aliases = family.pathAliases.map((alias) => `      '${escapeSingleQuotes(alias)}'`).join(',\n');
    lines.push('    pathAliases: [');
    lines.push(aliases);
    lines.push('    ],');
  }

  lines.push(`    kind: '${escapeSingleQuotes(family.kind)}',`);

  if (Object.hasOwn(family, 'targetCtrCurveMultiple')) {
    const multiple = Number(family.targetCtrCurveMultiple);
    if (Number.isFinite(multiple)) {
      lines.push(`    targetCtrCurveMultiple: ${multiple},`);
    }
  }

  lines.push(`    targetCtr: ${family.targetCtr === null ? 'null' : `${Number(family.targetCtr)}`},`);
  lines.push(`    monitored: ${family.monitored ? 'true' : 'false'},`);
  lines.push(`    impressions90d: ${Number(family.impressions90d)},`);
  lines.push(`    measuredOn: '${escapeSingleQuotes(family.measuredOn)}',`);

  if (typeof family.note === 'string' && family.note.length > 0) {
    lines.push(`    note: '${escapeSingleQuotes(family.note)}',`);
  }

  lines.push('  },');
  return `${lines.join('\n')}\n`;
}

function registerFamilyInCurveSource(family) {
  const source = readFileSync(SEO_CTR_CURVE_PATH, 'utf8');
  const marker = '\n/**\n * The CTR floor a family is actually judged against on a given run.';
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error('Non riesco a localizzare la fine di SEO_CTR_FAMILIES in seo-ctr-curve.mjs');
  }
  const insertion = `${serializeFamilyForCurve(family)}\n`;
  const output = `${source.slice(0, markerIndex)}${insertion}${source.slice(markerIndex)}`;
  writeFileSync(SEO_CTR_CURVE_PATH, output, 'utf8');
  console.log(`   ✅ Registrata automaticamente in SEO_CTR_FAMILIES: ${family.id}`);
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

async function openOrCommentIssue({ family, ctr, target, position, run }) {
  if (dryRun) {
    console.log(`   [dry-run] avrei aperto/commentato issue per ${family.label}`);
    return;
  }
  const targetBasis = Number.isFinite(Number(family.targetCtrCurveMultiple)) && position !== null
    ? `${family.targetCtrCurveMultiple}× la CTR attesa per la posizione media ${Number(position).toFixed(2)}`
    : 'soglia assoluta dichiarata nel registro';
  try {
    const { createGithubIssue } = await import('./lib/github-issue-creator.mjs');
    await createGithubIssue({
      title: `SEO CTR sotto soglia: template ${family.label}`,
      description: `## CTR sotto target — ${family.label}

**Path family:** \`${family.pathContains}\`
**CTR attuale (14gg):** ${pct(ctr)}
**Target:** ${pct(target)} (${targetBasis})
**Posizione media ponderata (14gg):** ${position === null ? 'n/a' : Number(position).toFixed(2)}
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

async function reportUnregisteredFamily({ pathContains, impressions90d }) {
  if (dryRun) {
    console.log(`   [dry-run] avrei aperto/commentato issue per famiglia non censita ${pathContains}`);
    return;
  }
  try {
    const { createGithubIssue } = await import('./lib/github-issue-creator.mjs');
    await createGithubIssue({
      title: `SEO CTR: famiglia ad alto volume non censita nel registro (${pathContains})`,
      description: `## Famiglia CTR ad alto volume non censita — \`${pathContains}\`

**Impressioni (90gg, tutte le locale):** ${impressions90d.toLocaleString('it-CH')}
**Soglia di sorveglianza (MIN_IMPRESSIONS_TO_MONITOR):** ${MIN_IMPRESSIONS_TO_MONITOR.toLocaleString('it-CH')}

La passata di scoperta automatica del monitor CTR-per-template
(scripts/monitor-seo-ctr-by-template.mjs, scripts/lib/seo-ctr-curve.mjs
\`discoverUnregisteredFamilies\`) ha rilevato che questa famiglia di pagine
supera la soglia di sorveglianza ma non compare in \`SEO_CTR_FAMILIES\`
(scripts/lib/seo-ctr-curve.mjs) — lo stesso blind-spot che per anni ha
lasciato \`/cerca-lavoro-ticino/\` (911k impressioni/90gg) invisibile al
monitor CTR (issue #4300, poi #5601).

Prossimi passi suggeriti: verificare se \`${pathContains}\` è un vero
template con un proprio title/description generator; se sì, aggiungere una
entry a \`SEO_CTR_FAMILIES\` con \`monitored: true\` e una \`impressions90d\`
misurata; se è un prefisso lingua cross-cutting, marcarla \`kind: 'locale'\`
(pinnato a una radice \`/xx/\`); se è un raggruppamento di pagine editoriali
eterogenee senza un generator condiviso, marcarla \`kind: 'listing'\` con un
\`note\` che lo giustifichi (issue #6306).`,
      priority: 3,
      labels: ['seo'],
      workflow: 'Monitor SEO CTR by Template',
    });
  } catch (e) {
    console.warn(`   ⚠️ impossibile creare/aggiornare issue di discovery: ${e.message}`);
  }
}

async function applyAutoFamilyRegistration({ family }) {
  if (!family || !family.id) return;
  if (dryRun) {
    console.log(`   [dry-run] avrei registrato automaticamente ${family.pathContains} come ${family.kind}`);
    return;
  }

  try {
    registerFamilyInCurveSource(family);
  } catch (e) {
    console.warn(`   ⚠️ impossibile registrare automaticamente in SEO_CTR_FAMILIES: ${e.message}`);
    await reportUnregisteredFamily({ pathContains: family.pathContains, impressions90d: family.impressions90d });
  }
}

async function discoverNewFamilies() {
  console.log(`\n🔎 Scoperta famiglie non censite (finestra ${DISCOVERY_WINDOW_DAYS}gg)`);
  try {
    const { perPath } = await fetchGscByPage({ windowDays: DISCOVERY_WINDOW_DAYS, pathContains: null });
    const pageRows = [...perPath.entries()].map(([path, metrics]) => ({ path, ...metrics }));
    const candidates = discoverUnregisteredFamilies(pageRows);
    if (candidates.length === 0) {
      console.log('   ✅ nessuna famiglia non censita sopra soglia');
      return;
    }
    for (const candidate of candidates) {
      const classified = classifyUnregisteredFamilyCandidate(candidate);
      if (classified.kind === 'unknown') {
        console.log(`   ⚠️ ${classified.pathContains}: ${classified.impressions90d} impressioni/90gg non censite`);
        await reportUnregisteredFamily(classified);
      } else if (classified.family) {
        console.log(
          `   ✅ ${classified.pathContains} classificata come ${classified.kind} → registrazione automatica`,
        );
        await applyAutoFamilyRegistration(classified);
      }
    }
  } catch (e) {
    console.warn(`   ⚠️ errore GSC durante la scoperta, salto questo giro: ${e.message}`);
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
    let position = null;
    // Recomputed per run: for a family with a curve multiple the floor tracks
    // the measured position instead of being frozen in the registry.
    let target = effectiveTargetCtr(family, null);
    try {
      const { perPath } = await fetchGscByPage({ windowDays: WINDOW_DAYS, pathContains: familyPathPrefixes(family) });
      const pageRows = [...perPath.entries()].map(([path, metrics]) => ({ path, ...metrics }));
      const agg = aggregateFamilyRows(pageRows, { minImpressions: 5 });
      ctr = agg.avgCtr;
      position = agg.avgPosition;
      target = effectiveTargetCtr(family, position);
      console.log(`   CTR (${WINDOW_DAYS}gg): ${pct(ctr)} | target: ${pct(target)} | pos: ${position === null ? 'n/a' : position.toFixed(2)} | pagine: ${agg.pageCount}`);
    } catch (e) {
      console.warn(`   ⚠️ errore GSC, salto questo giro: ${e.message}`);
      // Don't touch the counter on a fetch failure — avoid false escalation
      // from a transient API blip.
      state.families[family.id] = { ...prior, lastCheckedIso: nowIso, lastError: e.message };
      continue;
    }

    const belowTarget = ctr !== null && target !== null && ctr < target;
    const consecutiveBelowRuns = belowTarget ? (prior.consecutiveBelowRuns || 0) + 1 : 0;

    if (belowTarget) {
      console.log(`   ⚠️ sotto soglia (giro consecutivo #${consecutiveBelowRuns})`);
      if (consecutiveBelowRuns >= CONSECUTIVE_RUNS_TO_ESCALATE) {
        await openOrCommentIssue({ family, ctr, target, position, run: consecutiveBelowRuns });
      }
    } else {
      console.log('   ✅ CTR nella norma');
    }

    state.families[family.id] = {
      consecutiveBelowRuns,
      lastCtr: ctr,
      lastPosition: position,
      lastTargetCtr: target,
      lastCheckedIso: nowIso,
      lastError: null,
    };
  }

  if (!dryRun) {
    writeJsonAtomic(STATE_PATH, state);
    console.log(`\n💾 Stato monitor salvato: ${STATE_PATH}`);
  }

  await discoverNewFamilies();
}

main().catch((e) => {
  console.error('monitor-seo-ctr-by-template failed (non-blocking):', e.message);
  process.exitCode = 0;
});
