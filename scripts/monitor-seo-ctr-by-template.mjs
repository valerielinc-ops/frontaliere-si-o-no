#!/usr/bin/env node
/**
 * monitor-seo-ctr-by-template.mjs — scheduled CTR-vs-expected monitor
 * (issue #4300, plan item 5).
 *
 * Weekly: for each monitored template family (scripts/lib/seo-ctr-curve.mjs),
 * pulls a trailing 14-day GSC CTR and compares it against the family's
 * target. A family below target for 2 CONSECUTIVE COUNTED checks (~2 weeks
 * at the weekly cron cadence) opens a GitHub issue via
 * scripts/lib/github-issue-creator.mjs with a stable, dedup-friendly title —
 * later counted checks still below threshold post a comment on the same issue
 * instead of duplicating it (github-issue-creator's built-in title-prefix
 * dedup). Recovering above target resets the counter; no auto-close (left to
 * human review, consistent with the rest of the monitor fleet).
 *
 * A check is COUNTED at most once per cadence (nextCtrMonitorCounter in
 * scripts/lib/seo-ctr-curve.mjs): a manual dispatch or a re-run a few days
 * after a counted check re-reads almost the same 14-day window, so it
 * refreshes the evidence in the state file and in the log but neither moves
 * the counter nor opens or comments an issue.
 *
 * State persisted in data/seo-ctr-monitor-state.json so consecutive-check
 * counting survives across scheduled workflow invocations.
 *
 * The CTR is measured on queries with a plausible job intent only (owner
 * decision I5, 2026-10-05; guiding case issue 11198): queries with search
 * operators (`-site:`, `inurl:`…) and promotional/shop queries without job
 * words («fielmann offerta») are subtracted from the page totals and reported
 * as separate segments — in the log, in the state file and in the issue body —
 * by scripts/lib/seo-ctr-query-segments.mjs. The threshold is unchanged. Every
 * family entry carries `measureVersion`, so a jump caused by the change of
 * measure is never read as a real SERP improvement.
 *
 * Also runs a family-discovery pass each week: pulls site-wide GSC pages
 * over a trailing 90-day window and flags any path segment carrying
 * MIN_IMPRESSIONS_TO_MONITOR+ impressions that isn't in the registry yet
 * (scripts/lib/seo-ctr-curve.mjs's discoverUnregisteredFamilies) — the
 * automated version of what issue #4300 did by hand for
 * `/cerca-lavoro-ticino/`, which sat unmonitored at 911k impressions/90gg
 * for years before someone noticed. Opens/comments a GitHub issue per
 * candidate for human triage ONLY when the segment matches no known generator;
 * deterministic candidates (a bare locale prefix, a canton job-board slug from
 * `services/jobBoardSlugs.ts`, a fuel section from
 * `build-plugins/fuelDailyData.ts`) are classified and persisted to
 * `scripts/lib/seo-ctr-auto-families.json`, which `seo-ctr-curve.mjs` merges
 * into SEO_CTR_FAMILIES (issue #7174). The workflow commits that file: a
 * registration the runner throws away is a registration that never happened.
 *
 * Auth: Firebase service-account JSON via GOOGLE_APPLICATION_CREDENTIALS
 * (same as scripts/seo-ctr-baseline.mjs).
 *
 * Usage: npx --no-install tsx scripts/monitor-seo-ctr-by-template.mjs [--dry-run]
 *        (`tsx`, not `node`: seo-ctr-curve.mjs imports .ts leaf modules)
 *
 * Always exits 0 — monitoring only, never blocks CI.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fetchGscByPage } from './lib/perf-sources/gsc.mjs';
import {
  SEO_CTR_FAMILIES,
  MIN_IMPRESSIONS_TO_MONITOR,
  aggregateFamilyRows,
  belowCurvePagesForState,
  renderBelowCurvePagesSection,
  nextCtrMonitorCounter,
  ctrMonitorCountedAnchor,
  effectiveTargetCtr,
  discoverUnregisteredFamilies,
  familyPathPrefixes,
  shadowingManualPrefixes,
  ctrExcludedSegmentsForFamily,
  classifyUnregisteredFamilyCandidate,
  loadAutoRegisteredFamilies,
  AUTO_FAMILIES_PATH,
} from './lib/seo-ctr-curve.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { buildScheda } from './lib/monitor-scheda.mjs';
import {
  CTR_MEASURE_VERSION,
  fetchSegmentedFamilyRows,
  excludedSegmentsForState,
  renderExcludedSegmentsSection,
  describeMeasureChange,
} from './lib/seo-ctr-query-segments.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const STATE_PATH = resolve(ROOT, 'data', 'seo-ctr-monitor-state.json');
const WINDOW_DAYS = 14;
const CONSECUTIVE_RUNS_TO_ESCALATE = 2;
const DISCOVERY_WINDOW_DAYS = 90;
// Pagine sotto questo numero di impressioni non entrano nell'aggregato di
// famiglia: vale per la misura segmentata e per «tutte le query».
const MIN_PAGE_IMPRESSIONS = 5;
const DRY_RUN_COMMAND = 'npx --no-install tsx scripts/monitor-seo-ctr-by-template.mjs --dry-run';

const dryRun = process.argv.includes('--dry-run');

function pct(n) {
  return n === null || n === undefined ? 'n/a' : `${(n * 100).toFixed(2)}%`;
}

/**
 * Persist an auto-classified family so the next run — and every other consumer
 * of SEO_CTR_FAMILIES — sees it as registered.
 *
 * Idempotent on `id` and on any `familyPathPrefixes()` already present: the
 * discovery pass runs weekly against a 90-day window, so the same segment
 * comes back until the registration is visible, and a second entry for it
 * would double-count the family's impressions.
 */
function registerFamilyInAutoRegistry(family) {
  const current = loadAutoRegisteredFamilies();
  const prefixes = familyPathPrefixes(family);

  // Collisione col registro MANUALE: scrivere qui sarebbe peggio che non
  // scrivere. `mergeRegisteredFamilies` scarta l'entry al prossimo import
  // (il prefisso e' gia' rivendicato a mano), ma il giro successivo la
  // ritrova sul disco, la legge come `alreadyThere` e non ritenta mai: il
  // segmento resta fuori da SEO_CTR_FAMILIES per sempre, in silenzio (#7387).
  // Il throw ricade sul catch di `applyAutoFamilyRegistration`, che apre la
  // issue di triage umano — l'unica uscita che porta davvero a coprire il
  // segmento, tipicamente aggiungendo l'alias mancante alla famiglia manuale
  // (il resolver canonicalizza sullo slug IT, quindi lo slug EN/DE/FR
  // scoperto puo' collidere con una manuale che non lo elenca fra i suoi).
  const shadowing = shadowingManualPrefixes(family);
  if (shadowing.length > 0) {
    throw new Error(
      `prefisso gia' rivendicato dal registro manuale (${shadowing.join(', ')}): `
      + `l'entry auto ${family.id} verrebbe scritta e poi scartata da mergeRegisteredFamilies`,
    );
  }

  const claimed = new Set(current.flatMap((f) => familyPathPrefixes(f)));
  const alreadyThere =
    current.some((f) => f.id === family.id) ||
    prefixes.some((prefix) => claimed.has(prefix));
  if (alreadyThere) {
    console.log(`   ↩︎ ${family.pathContains} già nel registro automatico, nessuna scrittura`);
    return;
  }
  writeJsonAtomic(AUTO_FAMILIES_PATH, [...current, family]);
  console.log(`   ✅ Registrata automaticamente: ${family.id} → ${AUTO_FAMILIES_PATH}`);
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

async function openOrCommentIssue({ family, ctr, target, position, run, belowCurvePages, segmentation, measureChange }) {
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
**CTR attuale (14gg, senza le query escluse):** ${pct(ctr)}
**CTR su tutte le query (misura precedente):** ${pct(segmentation.allQueries.ctr)}
**Target:** ${pct(target)} (${targetBasis})
**Posizione media ponderata (14gg):** ${position === null ? 'n/a' : Number(position).toFixed(2)}
**Check consecutivi sotto soglia:** ${run}

Il monitor CTR-per-template (issue #4300, scripts/monitor-seo-ctr-by-template.mjs)
ha rilevato che questa famiglia di pagine resta sotto la soglia CTR attesa per
${run} controlli settimanali consecutivi (~${run} settimane).
${measureChange ? `\n> ${measureChange}\n` : ''}
${renderBelowCurvePagesSection(belowCurvePages)}

${renderExcludedSegmentsSection({ segments: segmentation.segments, allQueries: segmentation.allQueries, measureVersion: segmentation.measureVersion })}

Prossimi passi suggeriti: rivedere title/description generator per questa
famiglia (services/seo/seo-pages.ts per guida/tasse, build-plugins/ogPagesPlugin.ts
per gli articoli), verificare rich-results (FAQPage/HowTo) e considerare
l'estensione dell'A/B SERP autopilot esistente.

${buildScheda({
  causa: [
    `(ipotesi, da confermare.) La CTR di questa famiglia sta sotto il target da ${run}`,
    'controlli settimanali di fila, quindi non e\' rumore di una settimana. Se il difetto',
    'sia nel titolo, nella descrizione o nel tipo di risultato mostrato non lo dice questo',
    'numero: dice solo che chi vede la pagina in ricerca non ci clicca.',
  ],
  fix: [
    'Dipende da cosa mostra la SERP per questa famiglia; non preassegnata qui. | **REPO**:',
    'sito.',
  ],
  metrica: `prima=${pct(ctr)} atteso=>=${pct(target)} (${targetBasis})`,
  comando: DRY_RUN_COMMAND,
  note: [
    'Il comando rimisura tutte le famiglie e stampa il verdetto senza coniare: la issue si',
    'chiude quando questa famiglia torna sopra il target. Vuole le credenziali della Search',
    'Console — dalla root del workspace, `source bin/rc-env.sh`.',
  ],
  osservatore: [
    'Questo stesso monitor, rigirato ogni settimana, che ricommenta sulla issue canonica',
    'finche\' la famiglia resta sotto soglia. Non esiste un closer automatico: il comando',
    'qui sopra e\' il criterio con cui chiuderla.',
  ],
  fallimento: `\`SEO CTR sotto soglia: template ${family.label}\``,
})}`,
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
\`note\` che lo giustifichi (issue #6306).

${buildScheda({
  causa: [
    `(ipotesi, da confermare.) Questa famiglia supera la soglia di sorveglianza ma non e'`,
    'nel registro, quindi nessun controllo di CTR la guarda. E\' un buco di copertura del',
    'monitor, non un difetto delle pagine: la loro CTR potrebbe essere ottima o pessima, e',
    'oggi non lo sappiamo.',
  ],
  fix: [
    'Aggiungere una voce al registro delle famiglie, con il tipo giusto fra quelli elencati',
    'sopra. | **REPO**: sito.',
  ],
  metrica: `prima=fuori registro con ${impressions90d} impressioni/90gg atteso=censita nel registro`,
  comando: DRY_RUN_COMMAND,
  note: [
    'Il comando rifa la passata di scoperta senza coniare: la issue si chiude quando questa',
    'famiglia non compare piu\' fra quelle non censite.',
  ],
  osservatore: [
    'Questo stesso monitor, la cui passata di scoperta riconia la issue finche\' la famiglia',
    'resta fuori dal registro — quindi una issue che ricompare dopo la chiusura significa',
    'che la voce aggiunta non e\' stata riconosciuta.',
  ],
  fallimento: `\`SEO CTR: famiglia ad alto volume non censita nel registro (${pathContains})\``,
})}`,
      priority: 3,
      labels: ['seo'],
      workflow: 'Monitor SEO CTR by Template',
    });
  } catch (e) {
    console.warn(`   ⚠️ impossibile creare/aggiornare issue di discovery: ${e.message}`);
  }
}

async function applyAutoFamilyRegistration({ family, pathContains, impressions90d }) {
  if (!family || !family.id) return;
  if (dryRun) {
    console.log(`   [dry-run] avrei registrato automaticamente ${family.pathContains} come ${family.kind}`);
    return;
  }

  try {
    registerFamilyInAutoRegistry(family);
  } catch (e) {
    console.warn(`   ⚠️ impossibile registrare automaticamente in SEO_CTR_FAMILIES: ${e.message}`);
    // La issue nomina il segmento SCOPERTO, non il canonico IT su cui il
    // resolver ha canonicalizzato: e' il segmento scoperto quello che resta
    // senza copertura, e cercarlo nel registro e' il primo passo del triage.
    await reportUnregisteredFamily({
      pathContains: pathContains || family.pathContains,
      impressions90d: impressions90d ?? family.impressions90d,
    });
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
      let classified;
      try {
        classified = classifyUnregisteredFamilyCandidate(candidate);
      } catch (e) {
        // La classificazione ora rifiuta di interpolare uno slug mancante
        // (#7388) invece di produrre un `pathContains: '/undefined/'`. Il
        // rifiuto e' per-candidato: catturarlo qui, e non nel catch esterno,
        // evita che una mappa slug incompleta faccia saltare l'INTERA passata
        // di scoperta (il catch sotto dice «errore GSC … salto questo giro»,
        // che sarebbe una diagnosi falsa oltre che una perdita di segnale).
        console.warn(`   ⚠️ ${candidate.pathContains}: classificazione rifiutata — ${e.message}`);
        await reportUnregisteredFamily(candidate);
        continue;
      }
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
    let belowCurvePages = [];
    let segmentation = null;
    try {
      // Segmentazione per query (decisione I5 del 2026-10-05): un errore sulle
      // righe pagina×query ricade nel ramo di errore sotto, come un errore GSC
      // — un controllo misurato con la misura vecchia non va conteggiato con
      // quella nuova.
      segmentation = await fetchSegmentedFamilyRows({
        windowDays: WINDOW_DAYS,
        pathContains: familyPathPrefixes(family),
        segments: ctrExcludedSegmentsForFamily(family),
        minImpressions: MIN_PAGE_IMPRESSIONS,
      });
      const { pageRows } = segmentation;
      const agg = aggregateFamilyRows(segmentation.rows, { minImpressions: MIN_PAGE_IMPRESSIONS });
      ctr = agg.avgCtr;
      position = agg.avgPosition;
      belowCurvePages = agg.belowCurvePages;
      target = effectiveTargetCtr(family, position);
      console.log(`   CTR (${WINDOW_DAYS}gg, senza le query escluse): ${pct(ctr)} | target: ${pct(target)} | pos: ${position === null ? 'n/a' : position.toFixed(2)} | pagine: ${agg.pageCount}`);
      // La misura precedente, rifatta sulle stesse righe: CTR, target e click
      // persi stimati (impressioni × (target − CTR)) con e senza segmentazione.
      const lost = (a, t) => (a.avgCtr === null || t === null ? 0 : Math.max(0, a.totalImpressions * (t - a.avgCtr)));
      const allAgg = aggregateFamilyRows(pageRows, { minImpressions: MIN_PAGE_IMPRESSIONS });
      const allTarget = effectiveTargetCtr(family, allAgg.avgPosition);
      console.log(`   misura precedente (tutte le query): CTR ${pct(allAgg.avgCtr)} | target ${pct(allTarget)} | pos ${allAgg.avgPosition === null ? 'n/a' : allAgg.avgPosition.toFixed(2)} | click persi ${lost(allAgg, allTarget).toFixed(0)}`);
      console.log(`   misura attuale (senza escluse):      CTR ${pct(agg.avgCtr)} | target ${pct(target)} | pos ${position === null ? 'n/a' : position.toFixed(2)} | click persi ${lost(agg, target).toFixed(0)}`);
      for (const [name, s] of Object.entries(segmentation.segments)) {
        const top = s.topQueries.map((q) => `«${q.query}» ${q.impressions}`).join(', ');
        console.log(`   escluse (${name}): ${s.impressions} impressioni, ${s.clicks} click${top ? ` — ${top}` : ''}`);
      }
    } catch (e) {
      console.warn(`   ⚠️ errore GSC, salto questo giro: ${e.message}`);
      // Don't touch the counter on a fetch failure — avoid false escalation
      // from a transient API blip.
      // ...and don't move the cadence either: this check counted nothing, so
      // the anchor stays where the last counted check left it.
      state.families[family.id] = {
        ...prior,
        lastCheckedIso: nowIso,
        lastCountedIso: ctrMonitorCountedAnchor(prior),
        lastError: e.message,
      };
      continue;
    }

    const measureChange = describeMeasureChange(prior, {
      measureVersion: segmentation.measureVersion,
      allQueriesCtr: segmentation.allQueries.ctr,
    });
    if (measureChange) console.log(`   ℹ️ ${measureChange}`);

    const belowTarget = ctr !== null && target !== null && ctr < target;
    const { counted, consecutiveBelowRuns, lastCountedIso } = nextCtrMonitorCounter(prior, { belowTarget, nowIso });
    const offCadence = `controllo fuori cadenza, non conteggiato (ultimo conteggiato: ${lastCountedIso}; contatore fermo a ${consecutiveBelowRuns})`;

    if (belowTarget) {
      console.log(counted
        ? `   ⚠️ sotto soglia (controllo consecutivo #${consecutiveBelowRuns})`
        : `   ⚠️ sotto soglia — ${offCadence}`);
      console.log(renderBelowCurvePagesSection(belowCurvePages).replace(/^/gm, '   '));
      // Escalation only on a counted check: the issue text says "N controlli
      // settimanali consecutivi" and an off-cadence run is not one of them.
      if (counted && consecutiveBelowRuns >= CONSECUTIVE_RUNS_TO_ESCALATE) {
        await openOrCommentIssue({ family, ctr, target, position, run: consecutiveBelowRuns, belowCurvePages, segmentation, measureChange });
      }
    } else {
      console.log(counted ? '   ✅ CTR nella norma' : `   ✅ CTR nella norma — ${offCadence}`);
    }

    state.families[family.id] = {
      consecutiveBelowRuns,
      measureVersion: segmentation.measureVersion,
      lastCtr: ctr,
      lastCtrAllQueries: segmentation.allQueries.ctr,
      lastExcludedSegments: excludedSegmentsForState(segmentation.segments),
      lastPosition: position,
      lastTargetCtr: target,
      lastBelowCurvePages: belowCurvePagesForState(belowCurvePages),
      lastCheckedIso: nowIso,
      lastCountedIso,
      lastError: null,
    };
  }

  state.measureVersion = CTR_MEASURE_VERSION;
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
