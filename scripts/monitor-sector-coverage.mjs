#!/usr/bin/env -S npx tsx
/**
 * monitor-sector-coverage.mjs — Post-deploy check for job-matching coverage
 * gaps across every canton×profession page family, not just Ticino.
 *
 * frontaliere-si-o-no ships job data exclusively via 580+ per-employer
 * crawlers (docs/CRAWLERS.md) — there is no generic multi-employer job
 * board source (job-room.ch/SECO was investigated and is blocked: 401 on
 * its API, no SSR — see #3337). Any profession/sector whose local
 * employers aren't individually onboarded shows 0 real matches, in ANY
 * canton. That is the root cause behind issue #4824
 * ("/cerca-lavoro-ticino/camerieri/" 0 match) — but it was only VISIBLE
 * for Ticino because only a TI-only monitor existed. Identical gaps in
 * GR/VS/VD/ZH/etc were invisible to CI. This script generalizes detection
 * to every canton×profession page family so the class of bug (not just
 * the one Ticino instance) gets tracked.
 *
 * Checks three independently-gated page families and opens/updates one
 * tracking issue per family (dedup by stable title via
 * github-issue-creator.mjs):
 *
 *   A. TI sector hubs (`/cerca-lavoro-ticino/{settore}/`,
 *      jobSectorLanding.ts / jobSectorPagesPlugin.ts) — no job-count floor
 *      (owner decision 2026-07-16), pages stay indexed even at 0 real
 *      matches. Original #4824 check, behavior unchanged.
 *   B. TI legacy profession pages (`/lavoro-ticino-{ruolo}/`,
 *      professionLandingsData.ts / professionLandingsPlugin.ts) — UNLIKE A,
 *      this family has had a MIN_JOBS floor + noindex bridge since #5322/
 *      #5323 (`professionJobsFloor.ts`), with a 30-day grace window on
 *      recently-expired postings. A 0-live profession here is therefore
 *      either still indexed (riding the grace window on expired listings)
 *      or already bridged to noindex — never automatically a live thin
 *      page the way A's sector hubs are. The check below re-derives the
 *      same verdict the real page emitter uses so the two never drift.
 *   C. All-canton profession-canton pages (`/lavoro-{cantone}-{ruolo}/`,
 *      professionCantonLandings.ts, every canton except TI) — these DO
 *      have a MIN_JOBS floor + automatic noindex bridge, so a 0-match pair
 *      is never a thin-content risk there. Still worth surfacing: a
 *      profession with 0 matches in EVERY canton nationally (incl. TI) is
 *      a pure crawler-category gap — same root cause as A/B, just masked
 *      by the bridge instead of showing up as a live empty page. A
 *      profession missing in only some cantons is a lower-priority
 *      coverage signal for crawler-onboarding backlog triage.
 *
 * Reuses the real build-time aggregators (aggregateProfessionJobs,
 * aggregateProfessionJobsByCanton from professionJobsAggregate.ts) so
 * counts never drift from what the live pages actually show. Those
 * aggregators hardcode reading `<rootDir>/data/jobs.json`; this post-deploy
 * job only restores `public/data/jobs.json` (data/jobs.json is gitignored
 * and absent in that checkout), so we symlink it into a scratch `data/`
 * dir rather than duplicating the matching logic here.
 *
 * Always exits 0 — non-blocking, alerting only.
 * Usage: npx tsx scripts/monitor-sector-coverage.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const JOBS_PATH = path.join(REPO_ROOT, 'public/data/jobs.json');
const EXPIRED_JOBS_PATH = path.join(REPO_ROOT, 'public/data/expired-jobs.json');

// Mirrors MIN_JOBS in build-plugins/professionCantonLandings.ts — the floor
// below which a profession-canton page falls back to a noindex bridge.
const MIN_JOBS = 3;

function log(emoji, msg) {
  console.log(`${emoji} ${msg}`);
}

function runUrl() {
  return process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '(local run)';
}

// --- DELTA + ARTEFATTO DEL GAP SET (issue #5323) -----------------------------
// #5323 non e' un difetto di codice — le pagine sono gia' protette da MIN_JOBS
// + bridge noindex — ma il SEGNALE era rotto: il check gira a ogni post-deploy
// e ri-postava sempre lo STESSO commento di 15 bullet, identico al precedente,
// consumando budget del fixer e seppellendo l'informazione utile sotto le
// ricorrenze. Due cambiamenti:
//
//   1. DELTA: lo stato del gap set viaggia dentro il commento stesso come
//      marker HTML machine-readable. Al giro dopo lo rileggiamo e commentiamo
//      SOLO se qualcosa e' cambiato (gap nuovi / gap chiusi). Nessun delta →
//      nessun commento.
//   2. ARTEFATTO: il gap set COMPLETO viene persistito come JSON. Prima veniva
//      buttato via (`belowFloorByProfession` moriva a fine funzione) e l'unica
//      traccia erano i 15 bullet troncati del commento — lossy per costruzione.
//
// Perche' lo stato sta nel COMMENTO e non in un file: il runner post-deploy e'
// effimero e il workflow committa solo `data/previous-slug-winners.json`, non
// un `data/**` arbitrario. Un file su disco non sopravvive fra due deploy senza
// toccare il workflow (che il token GitHub App non puo' nemmeno pushare, #1724).
// L'issue canonica, che gia' esiste ed e' gia' deduplicata per titolo, e' l'unico
// store persistente disponibile a costo zero.
//
// BIAS ESPLICITO: qualunque fallimento nella lettura dello stato precedente
// (issue non trovata, gh in errore, marker assente o corrotto) → `null` →
// commentiamo come si faceva prima. Il rumore e' un fastidio, la soppressione
// silenziosa di una regressione no: non sopprimiamo mai su incertezza.
const GAP_ISSUE_TITLE = 'Copertura professioni per cantone: gap sistemici rilevati';
const GAP_STATE_MARKER = 'COVERAGE_GAP_STATE_V1';
const GAP_ARTIFACT_PATH = path.join(REPO_ROOT, 'data/profession-canton-coverage-gaps.json');

/**
 * Stato confrontabile del gap set: professioni a zero nazionale + coppie
 * `professione:cantone` sotto soglia. Ordinato → diff stabile. Pura.
 * @param {{nationalZero: string[], belowFloorByProfession: Map<string, {cantonKey: string, liveCount: number}[]>}} input
 */
export function buildGapState({ nationalZero, belowFloorByProfession }) {
  return {
    nationalZero: [...nationalZero].sort(),
    pairs: [...belowFloorByProfession.entries()]
      .flatMap(([id, entries]) => entries.map((e) => `${id}:${e.cantonKey}`))
      .sort(),
  };
}

/** Marker HTML machine-readable da appendere al corpo del commento. Pura. */
export function serializeGapState(state) {
  return `<!-- ${GAP_STATE_MARKER}: ${JSON.stringify(state)} -->`;
}

/**
 * Ultimo stato serializzato presente nel testo (body + commenti concatenati),
 * o null se assente/corrotto. Prende l'ULTIMO: i commenti sono cronologici.
 * Pura → testabile.
 * @param {string} text
 */
export function parseGapState(text) {
  const re = new RegExp(`<!--\\s*${GAP_STATE_MARKER}:\\s*([\\s\\S]*?)\\s*-->`, 'g');
  let last = null;
  for (const m of String(text || '').matchAll(re)) last = m[1];
  if (last === null) return null;
  try {
    const parsed = JSON.parse(last);
    if (!parsed || !Array.isArray(parsed.nationalZero) || !Array.isArray(parsed.pairs)) return null;
    return parsed;
  } catch {
    return null; // marker corrotto → trattato come "nessuno stato" → commenta
  }
}

/**
 * Delta fra due stati. `prev` null (primo giro / stato illeggibile) → tutto e'
 * "nuovo" e `changed` e' true, cioe' si commenta la baseline. Pura.
 */
export function diffGapState(prev, next) {
  const prevZero = new Set(prev?.nationalZero || []);
  const prevPairs = new Set(prev?.pairs || []);
  const nextZero = new Set(next.nationalZero);
  const nextPairs = new Set(next.pairs);
  const openedZero = next.nationalZero.filter((x) => !prevZero.has(x));
  const closedZero = [...prevZero].filter((x) => !nextZero.has(x)).sort();
  const openedPairs = next.pairs.filter((x) => !prevPairs.has(x));
  const closedPairs = [...prevPairs].filter((x) => !nextPairs.has(x)).sort();
  return {
    openedZero,
    closedZero,
    openedPairs,
    closedPairs,
    changed:
      openedZero.length + closedZero.length + openedPairs.length + closedPairs.length > 0,
  };
}

/**
 * Gap set completo in forma ordinata e deterministica, pronto per il JSON.
 * Ordinamento: numero di cantoni sotto soglia desc, poi id asc — lo stesso
 * criterio del commento, ma SENZA il troncamento a 15. Pura.
 */
export function buildGapArtifact({ nationalZero, belowFloorByProfession, minJobs, cantonCount }) {
  return {
    _generatedAt: new Date().toISOString(),
    _minJobs: minJobs,
    _nonTiCantonCount: cantonCount,
    _ordering:
      'cantoni-sotto-soglia desc, poi professionId asc. NON ordinato per volume di ricerca: vedi _orderingNote.',
    _orderingNote:
      'Un ordinamento per domanda (volume x cantone) richiederebbe un segnale non circolare per (professione, cantone), che oggi non esiste nel repo: le coppie sotto soglia rendono un bridge noindex e quindi guadagnano ~0 impression PER COSTRUZIONE, percio\' data/evidence-index.json (gsc.pages) ordinerebbe per "gap che gia\' serviamo in parte", l\'inverso dell\'intento. Attenzione: il campo `cantons` di data/profession-keyword-opportunities.json e\' OFFERTA (conteggi annunci), non domanda.',
    nationalZero: [...nationalZero].sort(),
    belowFloor: [...belowFloorByProfession.entries()]
      .map(([professionId, entries]) => ({
        professionId,
        cantonCount: entries.length,
        cantons: [...entries].sort((a, b) => a.cantonKey.localeCompare(b.cantonKey)),
      }))
      .sort((a, b) => b.cantonCount - a.cantonCount || a.professionId.localeCompare(b.professionId)),
  };
}

/**
 * Sezione markdown del delta. Estratta e pura proprio perche' e' la parte
 * fragile: e' un'unica concatenazione di rami opzionali, e un ramo vuoto che
 * non porta il proprio separatore incolla due grassetti ("**Nessun gap
 * nuovo.****3 gap CHIUSI**"). Ogni blocco qui termina con la propria riga
 * vuota, e il caso "solo chiusure" ha un test dedicato.
 *
 * @param {{openedZero: string[], closedZero: string[], openedPairs: string[], closedPairs: string[]}} delta
 * @param {{minJobs: number, totalPairs: number, totalZero: number, pairLabel: (p: string) => string}} ctx
 */
export function renderDeltaSection(delta, { minJobs, totalPairs, totalZero, pairLabel }) {
  const bulletList = (items, max = 20) => {
    const shown = items.slice(0, max).map((p) => `- ${pairLabel(p)}`);
    if (items.length > max) shown.push(`- …e altri ${items.length - max} (elenco completo nell'artefatto)`);
    return shown.join('\n');
  };
  const blocks = [];
  if (delta.openedZero.length === 0 && delta.openedPairs.length === 0) {
    blocks.push('**Nessun gap nuovo.**');
  }
  if (delta.openedZero.length > 0) {
    blocks.push(
      `**${delta.openedZero.length} professione/i passata/e a ZERO nazionale:**\n\n${delta.openedZero.map((id) => `- \`${id}\``).join('\n')}`,
    );
  }
  if (delta.openedPairs.length > 0) {
    blocks.push(
      `**${delta.openedPairs.length} gap NUOVI** (coppia professione×cantone scesa sotto ${minJobs}):\n\n${bulletList(delta.openedPairs)}`,
    );
  }
  if (delta.closedZero.length > 0) {
    blocks.push(
      `**${delta.closedZero.length} professione/i non più a zero nazionale:**\n\n${delta.closedZero.map((id) => `- \`${id}\``).join('\n')}`,
    );
  }
  if (delta.closedPairs.length > 0) {
    blocks.push(
      `**${delta.closedPairs.length} gap CHIUSI** (coppia risalita a ≥${minJobs}):\n\n${bulletList(delta.closedPairs)}`,
    );
  }
  blocks.push(`Totale corrente: ${totalPairs} coppie sotto soglia, ${totalZero} professioni a zero nazionale.`);
  return `### Delta rispetto alla rilevazione precedente\n\n${blocks.join('\n\n')}\n`;
}

/** Scrive l'artefatto. Best-effort: un errore di IO non deve rompere il post-deploy. */
function writeGapArtifact(artifact) {
  try {
    fs.mkdirSync(path.dirname(GAP_ARTIFACT_PATH), { recursive: true });
    fs.writeFileSync(GAP_ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
    log('📄', `Gap set completo scritto in ${path.relative(REPO_ROOT, GAP_ARTIFACT_PATH)} (${artifact.belowFloor.length} professioni sotto soglia, ${artifact.nationalZero.length} a zero nazionale)`);
  } catch (e) {
    log('⚠️', `scrittura artefatto fallita (non bloccante): ${String(e).slice(0, 140)}`);
  }
}

/**
 * Stato del giro precedente, letto dall'issue canonica (body + tutti i commenti).
 * null su QUALUNQUE incertezza → il chiamante commenta la baseline.
 */
function readPreviousGapState() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) return null;
  try {
    const listed = execFileSync(
      'gh',
      ['issue', 'list', '--repo', repo, '--state', 'open', '--search', `in:title "${GAP_ISSUE_TITLE}"`,
        '--json', 'number,title', '--limit', '20'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const prefix = GAP_ISSUE_TITLE.slice(0, 60);
    const match = JSON.parse(listed || '[]').find((i) => String(i.title || '').startsWith(prefix));
    if (!match) return null;
    const viewed = execFileSync(
      'gh',
      ['issue', 'view', String(match.number), '--repo', repo, '--json', 'body,comments'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const issue = JSON.parse(viewed || '{}');
    const haystack = [issue.body || '', ...(issue.comments || []).map((c) => c.body || '')].join('\n');
    return parseGapState(haystack);
  } catch (e) {
    log('⚠️', `lettura stato precedente fallita → commento la baseline: ${String(e).slice(0, 120)}`);
    return null;
  }
}

function createIssue({ title, description, labels }) {
  const args = [
    path.join(REPO_ROOT, 'scripts/lib/github-issue-creator.mjs'),
    '--title', title,
    '--description', description,
    '--priority', '3',
    '--workflow', 'Post-deploy Publish (side-effects + mark good)',
  ];
  for (const label of labels) args.push('--label', label);
  execFileSync('node', args, { stdio: 'inherit' });
}

async function checkTiSectorHubs({ resolveJobCanton, jobs }) {
  const { SECTOR_HUB_KEYS, countSectorJobsByLocale } = await import(
    path.join(REPO_ROOT, 'build-plugins/jobSectorLanding.ts')
  );

  const tiJobs = jobs.filter((job) => resolveJobCanton(job) === 'TI');
  const counts = countSectorJobsByLocale(tiJobs);
  const zeroSectors = SECTOR_HUB_KEYS.filter((sector) => (counts.it?.[sector] ?? 0) === 0);

  if (zeroSectors.length === 0) {
    log('✅', 'All TI sector-hub pages have >=1 real job match.');
    return;
  }

  log('⚠️', `${zeroSectors.length} TI sector(s) with 0 real job matches: ${zeroSectors.join(', ')}`);

  const description = `## Sector TI 0 match reali

Le seguenti pagine \`/cerca-lavoro-ticino/{settore}/\` non hanno **nessuna offerta reale** per il canton Ticino in questo deploy. La pagina resta live/indicizzata (decisione owner 2026-07-16: nessuna soglia minima per i settori TI), ma il gap va investigato:

${zeroSectors.map((s) => `- \`/cerca-lavoro-ticino/${s}/\``).join('\n')}

**Possibili cause da verificare:**
- Gap di copertura crawler per questo settore/vertical (vedi #3337 — backlog aziende svizzere non ancora crawlate)
- Regex \`SECTOR_MATCHERS\` (\`build-plugins/jobSectorLanding.ts\`) troppo stretta rispetto ai titoli/categorie reali del settore
- Domanda di lavoro genuinamente scarsa in Ticino per questo settore (verificare vs. altri cantoni)

**Run:** ${runUrl()}
**Totale job TI (raw, canton==TI):** ${tiJobs.length}`;

  createIssue({
    title: 'TI sector coverage: settori a 0 match reali',
    description,
    labels: ['bug', 'funnel-seo'],
  });
}

async function checkTiLegacyProfessions(stagingRoot) {
  const { aggregateProfessionJobs, aggregateRecentlyExpiredProfessionCounts } = await import(
    path.join(REPO_ROOT, 'build-plugins/professionJobsAggregate.ts')
  );
  const { PROFESSION_IDS } = await import(
    path.join(REPO_ROOT, 'build-plugins/professionLandingsData.ts')
  );
  const { meetsJobsFloor, PROFESSION_FLOOR_GRACE_DAYS } = await import(
    path.join(REPO_ROOT, 'build-plugins/shared/professionJobsFloor.ts')
  );

  const snapshots = aggregateProfessionJobs(stagingRoot);
  const zeroIds = PROFESSION_IDS.filter((id) => (snapshots[id]?.liveCount ?? 0) === 0);

  if (zeroIds.length === 0) {
    log('✅', 'All TI legacy profession pages have >=1 real job match.');
    return;
  }

  // Same verdict the real emitter (professionLandingsPlugin.ts) uses: a
  // 0-live profession is only a live/indexed thin page if it ALSO fails the
  // grace window (recently-expired TI postings within PROFESSION_FLOOR_GRACE_DAYS).
  // Otherwise it's either riding the grace window (indexed, worth flagging)
  // or already bridged to noindex,follow (safe, no thin-content risk).
  const recentlyExpired = aggregateRecentlyExpiredProfessionCounts(
    stagingRoot,
    PROFESSION_FLOOR_GRACE_DAYS,
    Date.now(),
  );
  const indexedViaGrace = [];
  const bridgedNoindex = [];
  for (const id of zeroIds) {
    const verdict = meetsJobsFloor({
      liveCount: 0,
      recentlyExpiredCount: recentlyExpired ? recentlyExpired[id] : null,
    });
    (verdict.meetsFloor ? indexedViaGrace : bridgedNoindex).push(id);
  }

  log(
    '⚠️',
    `${zeroIds.length} TI legacy profession page(s) with 0 real job matches ` +
      `(${indexedViaGrace.length} indexed via grace, ${bridgedNoindex.length} bridged noindex): ${zeroIds.join(', ')}`,
  );

  const description = `## Professioni TI (legacy) a 0 match reali

Le seguenti pagine \`/lavoro-ticino-{ruolo}/\` non hanno **nessuna offerta reale** in questo deploy. Dal fix #5322/#5323 questa famiglia condivide il floor MIN_JOBS + bridge noindex (con grace window di ${PROFESSION_FLOOR_GRACE_DAYS}gg su annunci scaduti) della famiglia per-cantone (\`professionJobsFloor.ts\`) — un 0-match non è più automaticamente una pagina indicizzata thin come i sector-hub (#4824).

${indexedViaGrace.length > 0 ? `**Restano indicizzate via grace window** (0 offerte live ma abbastanza annunci scaduti di recente da restare sopra soglia) — nessun rischio thin-content immediato, ma il gap di offerte live va investigato:

${indexedViaGrace.map((id) => `- \`/lavoro-ticino-${id}/\``).join('\n')}
` : ''}${bridgedNoindex.length > 0 ? `**Già bridged a noindex,follow** (sotto soglia anche con la grace window) — nessun rischio thin-content, ma il gap di dati sottostante resta da tracciare per priorità crawler-onboarding:

${bridgedNoindex.map((id) => `- \`/lavoro-ticino-${id}/\``).join('\n')}
` : ''}
**Causa più probabile:** gap di copertura crawler per il ruolo/vertical in Ticino (vedi #3337) — stessa diagnosi di #4824, non un problema di regex/matching.

**Run:** ${runUrl()}`;

  createIssue({
    title: 'TI profession coverage (legacy): ruoli a 0 match reali',
    description,
    labels: ['bug', 'funnel-seo'],
  });
}

async function checkAllCantonProfessions(stagingRoot) {
  const { aggregateProfessionJobs, aggregateProfessionJobsByCanton } = await import(
    path.join(REPO_ROOT, 'build-plugins/professionJobsAggregate.ts')
  );
  const { ALL_CANTON_PROFESSION_IDS } = await import(
    path.join(REPO_ROOT, 'build-plugins/professionLandingsData.ts')
  );
  const { PROFESSION_CANTON_KEYS } = await import(
    path.join(REPO_ROOT, 'build-plugins/professionCantonData.ts')
  );
  const { getCantonDisplayName } = await import(
    path.join(REPO_ROOT, 'build-plugins/shared/cantonDisplay.ts')
  );

  const byCanton = aggregateProfessionJobsByCanton(stagingRoot);
  // TI runs its own page family (checkTiLegacyProfessions above) with its
  // own floor rules, but still counts toward the *national* zero check
  // below — a profession genuinely absent everywhere must include TI too.
  const tiSnapshots = aggregateProfessionJobs(stagingRoot);

  const nationalZero = [];
  const belowFloorByProfession = new Map();

  for (const id of ALL_CANTON_PROFESSION_IDS) {
    // tiSnapshots only covers the 24 legacy PROFESSION_IDS — for the 5
    // CANTON_ONLY_PROFESSION_IDS (#3657) tiSnapshots[id] is always
    // undefined even when TI has real matches. byCanton['TI'][id] (from
    // aggregateProfessionJobsByCanton, which groups ALL cantons incl. TI)
    // always has the real count, so fall back to it rather than silently
    // dropping TI's contribution to the national total.
    let nationalTotal = tiSnapshots[id]?.liveCount ?? byCanton['TI']?.[id]?.liveCount ?? 0;
    const belowFloor = [];
    for (const cantonKey of PROFESSION_CANTON_KEYS) {
      const liveCount = byCanton[cantonKey]?.[id]?.liveCount ?? 0;
      nationalTotal += liveCount;
      if (liveCount < MIN_JOBS) belowFloor.push({ cantonKey, liveCount });
    }
    if (nationalTotal === 0) nationalZero.push(id);
    else if (belowFloor.length > 0) belowFloorByProfession.set(id, belowFloor);
  }

  if (nationalZero.length === 0 && belowFloorByProfession.size === 0) {
    log('✅', 'Every profession has >=1 real match nationally, at/above floor in every canton.');
    return;
  }

  log(
    '⚠️',
    `${nationalZero.length} profession(s) with 0 national matches; ${belowFloorByProfession.size} profession(s) below floor in >=1 canton.`,
  );

  const nonTiCantonCount = PROFESSION_CANTON_KEYS.length;

  // L'artefatto COMPLETO va scritto sempre, anche quando non commentiamo: e' la
  // sola forma non troncata del gap set (il commento ne mostra al massimo 15).
  writeGapArtifact(
    buildGapArtifact({
      nationalZero,
      belowFloorByProfession,
      minJobs: MIN_JOBS,
      cantonCount: nonTiCantonCount,
    }),
  );

  // Delta vs la rilevazione precedente: se nulla e' cambiato non commentiamo.
  const state = buildGapState({ nationalZero, belowFloorByProfession });
  const previous = readPreviousGapState();
  const delta = diffGapState(previous, state);
  if (previous && !delta.changed) {
    log('🔁', `Gap set invariato rispetto alla rilevazione precedente (${state.pairs.length} coppie, ${state.nationalZero.length} a zero nazionale) — nessun commento su #5323.`);
    return;
  }

  const pairLabel = (pair) => {
    const [id, cantonKey] = String(pair).split(':');
    return `\`${id}\` — ${getCantonDisplayName(cantonKey, 'it')}`;
  };

  const deltaSection = previous
    ? renderDeltaSection(delta, {
        minJobs: MIN_JOBS,
        totalPairs: state.pairs.length,
        totalZero: state.nationalZero.length,
        pairLabel,
      })
    : `### Rilevazione iniziale

${nationalZero.length} professioni a zero nazionale, ${state.pairs.length} coppie professione×cantone sotto soglia (${MIN_JOBS}). I giri successivi commenteranno **solo il delta**.
${nationalZero.length > 0 ? `
Nessun crawler copre affatto questi ruoli, in nessun cantone — priorità massima per onboarding:

${nationalZero.map((id) => `- \`${id}\``).join('\n')}
` : ''}`;

  const description = `## Copertura professioni per cantone: gap sistemici rilevati

Generalizzazione di #4824 a tutti i cantoni (non solo Ticino) — stessa root cause: 580+ crawler sono tutti **per-azienda**, nessuna fonte generica multi-employer copre tutti i settori/cantoni (job-room.ch/SECO bloccato, vedi #3337). Le pagine \`/lavoro-{cantone}-{ruolo}/\` restano sicure (soglia MIN_JOBS=${MIN_JOBS} + bridge noindex sotto soglia, \`professionCantonLandings.ts\`) — nessun rischio thin-content — ma il gap di dati sottostante resta e va tracciato per priorità crawler-onboarding.

${deltaSection}
Elenco **completo** (non troncato) e ordinabile: artefatto \`data/profession-canton-coverage-gaps.json\` prodotto da questo stesso run.

**Run:** ${runUrl()}

${serializeGapState(state)}`;

  createIssue({
    title: 'Copertura professioni per cantone: gap sistemici rilevati',
    description,
    labels: ['bug', 'funnel-seo'],
  });
}

async function main() {
  if (!fs.existsSync(JOBS_PATH)) {
    log('⚠️', `${JOBS_PATH} not present — skipping sector coverage check`);
    return;
  }

  const cantonSlugFile = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'data/canton-url-slugs.json'), 'utf8'),
  );
  const municipalitiesFile = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'data/canton-municipalities.json'), 'utf8'),
  );
  const { createCantonResolvers } = await import(
    path.join(REPO_ROOT, 'build-plugins/shared/cantonResolvers.mjs')
  );
  const { resolveJobCanton } = createCantonResolvers({ cantonSlugFile, municipalitiesFile });

  const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));

  // Symlink (not copy) — instant, no 300MB+ duplicate read/write of the
  // jobs corpus just to satisfy the aggregators' hardcoded data/ path.
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sector-coverage-'));
  fs.mkdirSync(path.join(stagingRoot, 'data'), { recursive: true });
  fs.symlinkSync(JOBS_PATH, path.join(stagingRoot, 'data', 'jobs.json'));
  // aggregateRecentlyExpiredProfessionCounts (used by checkTiLegacyProfessions
  // to mirror the real emitter's grace window) reads <rootDir>/data/expired-jobs.json.
  // Missing entirely is a valid state (fails open, see professionJobsFloor.ts) —
  // only symlink when the published copy actually exists.
  if (fs.existsSync(EXPIRED_JOBS_PATH)) {
    fs.symlinkSync(EXPIRED_JOBS_PATH, path.join(stagingRoot, 'data', 'expired-jobs.json'));
  }

  await checkTiSectorHubs({ resolveJobCanton, jobs });
  await checkTiLegacyProfessions(stagingRoot);
  await checkAllCantonProfessions(stagingRoot);
}

// Esegui SOLO come entry point: il modulo esporta le funzioni pure di stato/delta
// (buildGapState, parseGapState, diffGapState, buildGapArtifact) e i test le
// importano — senza questa guardia l'import farebbe partire il check post-deploy.
// Stesso pattern di scripts/lib/classify-issue.mjs.
if (process.argv[1] && process.argv[1].endsWith('monitor-sector-coverage.mjs')) {
  main().catch((err) => {
    console.error('[monitor-sector-coverage] unexpected error (non-blocking):', err);
  });
}
