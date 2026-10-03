#!/usr/bin/env node
/**
 * report-validate-dist-failure.mjs — reporter diagnostico per i fallimenti di
 * validate-dist (issue #5414, Parte B).
 *
 * Il problema che risolve: la issue canonica "Validation Failure (dist):
 * post-deploy" diceva solo QUALI job erano rossi. Per sapere QUALE gate era
 * fallito e PERCHÉ, un agente doveva scaricare il log del run (decine di MB) e
 * cercarci dentro. Questo reporter fa quel lavoro una volta sola, nel job
 * `validate-dist-report`, e mette il risultato nel body della issue: gate
 * falliti (righe ❌ verbatim), estratto del log dello step fallito, comando di
 * riproduzione locale ricavato da package.json, comando di replay via
 * audit-dist-from-run.yml, e una sezione `## Suggested action` con i path
 * degli script del gate — che è ciò che il fixer estrae.
 *
 * Contratti onorati (verificati sui sorgenti, non dedotti):
 * - DEDUP: il titolo è l'unica chiave (primi 60 char —
 *   scripts/lib/github-issue-creator.mjs, searchSafePrefix). Niente token
 *   variabili nel titolo: run id/SHA/conteggi stanno nel body (#5121).
 *   Un titolo per GATE è un discriminante per-entità (stessa granularità di
 *   cathedral-seo-gates-check), non un token instabile: lo stesso gate che
 *   rifallisce ricade sulla stessa issue canonica.
 * - CLOSER: `Validation Failure (dist): …` sta deliberatamente FUORI dal
 *   TITLE_RE di scripts/ci/close-recovered-failure-issues.mjs (che copre solo
 *   `Workflow|Crawler|CI Failure:`): il ciclo di chiusura è il `--mode
 *   resolve` appaiato qui sotto, che sul verde chiude sia il titolo legacy sia
 *   i per-gate.
 * - TRIAGE: "Validation Failure" nel titolo → categoria validation-failure,
 *   route=queue (scripts/lib/classify-issue.mjs).
 * - FIXER: il body non cita MAI path `.github/workflows/**` (il capability
 *   guard scripts/ci/check-workflows-scope.mjs bloccherebbe il fixer a zero
 *   token); cita invece gli script dei gate sotto `## Suggested action`. Il
 *   riferimento a `audit-dist-from-run.yml` è la sintassi di `gh workflow
 *   run`, senza prefisso di path, e il body cita sempre anche path scripts/
 *   → `detectWorkflowScoped` resta false per costruzione.
 * - SHA: per un run innescato da workflow_run, `github.sha` NON è il commit
 *   della build: il Build SHA nel body è `deploy_ref`
 *   (= workflow_run.head_sha, vedi deploy-publish.yml → validate-dist).
 *
 * Modalità:
 *   --mode report            apre/aggiorna le issue (dist scope di default)
 *   --mode report --scope build   arricchisce la issue `CI Failure (build):`
 *                            (titolo INVARIATO: la matrice 4-locale collassa
 *                            su un'unica issue, ed è load-bearing)
 *   --mode resolve           chiude TUTTE le `Validation Failure (dist): …`
 *   --dry-run                stampa su stdout il JSON dei payload senza
 *                            creare/chiudere nulla (le letture gh restano)
 *
 * Ciclo di vita per gate (decisione del proprietario, 2026-10-02: «apriamo
 * solo issue per gli errori riscontrati e poi saranno gli autofixer a
 * sistemarle»):
 * - ogni gate fallito riconosciuto ha la sua issue (prima: al massimo 3, poi
 *   una riassuntiva); `audit:all` è espanso nei sotto-auditor falliti dalla
 *   riga `audit-all: failed-audits=` del log, come fa già failed_gates;
 * - il body porta la sezione `## Offender` dal report JSON del gate
 *   (scripts/ci/lib/gate-issue-offenders.mjs), scaricato dall'artifact del
 *   run in `VALIDATE_DIST_REPORTS_DIR`;
 * - priorità dalla modalità del gate (scripts/ci/lib/seo-gate-classes.mjs:
 *   A=1, B=2, C=3; un gate non classificato resta 1);
 * - un gate non bloccante che cathedral misura sul corpus intero NON apre una
 *   seconda issue qui: la sua issue è `SEO gates regression: …`;
 * - in modalità report chiude, a titolo ESATTO, le issue dei gate che in
 *   questo run sono passati: una issue si chiude quando il SUO gate rientra,
 *   non quando l'intero run torna verde.
 *
 * Freschezza della build validata (LC-09): la validazione finisce ore dopo la
 * build, quindi la issue NUOVA di un gate può nascere su una build che precede
 * la fix già su `main` (misurato: 11117/11118 aperte alle 13:38Z del 2026-10-03
 * sul build 5121254f5, con le fix su `main` dalle 05:46Z/05:59Z e una build
 * successiva già riuscita alle 11:35Z). Il reporter misura `main` avanti di
 * quanto e se esiste una build successiva riuscita, lo scrive nel body
 * (marker `VALIDATED_BUILD`) e, solo con entrambe le prove, crea la issue
 * nuova parcheggiata (`fu-parked` + `fu-data-pending`): visibile, ma fuori
 * dalla coda del fixer fino alla validazione successiva, che la chiude (gate
 * verde, `resolvePassedGates`) o la sblocca (gate ancora rosso su una build
 * che contiene il `main` di allora). Misura ignota → instradamento di sempre.
 *
 * Exit code: SEMPRE 0 in report/resolve (il reporter gira in step
 * `continue-on-error` dopo un rosso vero: mai aggiungere un secondo rosso).
 * Non-zero solo per uso errato dei flag.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGithubIssue, resolveGithubIssue } from '../lib/github-issue-creator.mjs';
import { GATES as CATHEDRAL_GATES } from '../cathedral-seo-gates-check.mjs';
import { MODE_ISSUE_PRIORITY, SEO_GATE_CLASSES, effectiveMode, isPublishBlocking } from './lib/seo-gate-classes.mjs';
import { renderOffenderSection, reportFileCandidates } from './lib/gate-issue-offenders.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const TITLE_PREFIX = 'Validation Failure (dist): ';
export const LEGACY_TITLE = 'Validation Failure (dist): post-deploy';
// Mirrors DEDUP_TITLE_PREFIX_LEN in scripts/lib/github-issue-creator.mjs: i
// primi 60 char del titolo sono la chiave di dedup, quindi il gate name deve
// starci per intero (o essere troncato a token intero da titleForGate).
export const DEDUP_TITLE_PREFIX_LEN = 60;
// Oltre questa soglia di gate falliti, una sola issue riassuntiva col titolo
// legacy. Era 3: con 4 gate rossi (run 36922718485: gate:seo-source + tre
// sotto-auditor di audit:all) nessun gate aveva la sua issue, e un autofixer
// riceveva un riassunto invece di un difetto. 40 supera il numero di gate
// esistenti: la riassuntiva resta per il rosso senza gate riconosciuti.
export const MAX_PER_GATE_ISSUES = 40;
// Job di cui si scaricano i log (non gate): limite di costo delle chiamate API.
const MAX_FAILED_JOBS = 3;

/**
 * Gate non bloccanti misurati anche da cathedral-seo-gates-check sul corpus
 * intero: la loro issue è `SEO gates regression: <gate> above baseline`, e
 * una seconda issue qui sullo stesso difetto (misurato su un campione) darebbe
 * due lavori all'autofixer e due chiusure in conflitto. I gate A restano qui:
 * la loro issue è l'allarme del sequestro di `publish`.
 */
export const CATHEDRAL_OWNED_GATES = Object.freeze(new Set(
  CATHEDRAL_GATES.map((g) => g.gateKey).filter((key) => !isPublishBlocking(key)),
));

/** Priorità della issue dalla modalità del gate; 1 per un gate non classificato. */
export function issuePriorityForGate(gate) {
  const mode = effectiveMode(gate);
  return mode ? MODE_ISSUE_PRIORITY[mode] : 1;
}
const EXCERPT_LINES = 40;
const WORKFLOW_DISPLAY_NAME = 'Post-deploy Validate Dist';

/* ── helpers puri (esportati per i test) ─────────────────────────────── */

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
// Prefisso timestamp dei log di GitHub Actions: `2026-08-08T14:17:32.2009366Z `.
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

export function cleanLogLine(line) {
  return stripAnsi(String(line).replace(/\r$/, '').replace(TS_RE, ''));
}

// Riga per-gate emessa dai job di post-deploy-validate-dist.yml
// (`printf '%-40s %7.2f rc=%d'` + prefisso ❌/✅ del summary loop).
const GATE_FAIL_RE = /^❌ FAIL\s+(\S+)\s+(\d+(?:\.\d+)?)\s+rc=(\d+)\s*$/;
const GATE_PASS_RE = /^✅ PASS\s+(\S+)\s+(\d+(?:\.\d+)?)\s+rc=(\d+)\s*$/;
// Marker di scripts/audit-all.mjs: i sotto-auditor rossi del bundle.
const AUDIT_ALL_MARKER_RE = /^audit-all: failed-audits=(.*)$/;
const SUMMARY_RE = /^\S.*summary:\s*\d+ passed,\s*\d+ failed\s*$/i;

/**
 * Estrae dal log di un job (raw: timestamp/ANSI ammessi):
 * - le righe `❌ FAIL <gate> <sec> rc=<n>`, con `audit:all` espanso nei
 *   sotto-auditor della riga `audit-all: failed-audits=` quando c'è (senza
 *   marker resta il nome opaco: fail-closed, come in failed_gates);
 * - i gate `✅ PASS`, e per `audit:all` i sotto-auditor classificati che
 *   non compaiono fra i falliti (servono al resolve per gate);
 * - i footer `N passed, M failed`.
 * @returns {{ failedGates: {gate:string, seconds:number, rc:number, line:string}[], passedGates: string[], summaryLines: string[] }}
 */
export function parseGateLines(text) {
  const failedGates = new Map();
  const passed = new Set();
  const summaryLines = [];
  let auditAllFailed = null;
  for (const raw of String(text || '').split('\n')) {
    const line = cleanLogLine(raw);
    const m = GATE_FAIL_RE.exec(line);
    if (m && !failedGates.has(m[1])) {
      failedGates.set(m[1], {
        gate: m[1],
        seconds: Number(m[2]),
        rc: Number(m[3]),
        line,
      });
      continue;
    }
    const p = GATE_PASS_RE.exec(line);
    if (p) { passed.add(p[1]); continue; }
    const marker = AUDIT_ALL_MARKER_RE.exec(line);
    if (marker) {
      auditAllFailed = marker[1].split(',').map((x) => x.trim()).filter(Boolean);
      continue;
    }
    if (SUMMARY_RE.test(line)) summaryLines.push(line);
  }
  const subAuditors = Object.keys(SEO_GATE_CLASSES).filter((k) => k.startsWith('audit:all/'));
  const bundle = failedGates.get('audit:all');
  if (bundle && auditAllFailed && auditAllFailed.length > 0) {
    failedGates.delete('audit:all');
    for (const sub of auditAllFailed) {
      const gate = `audit:all/${sub}`;
      failedGates.set(gate, { ...bundle, gate, line: `${bundle.line}\naudit-all: failed-audits=${auditAllFailed.join(',')}` });
    }
    for (const sub of subAuditors) if (!auditAllFailed.includes(sub.slice('audit:all/'.length))) passed.add(sub);
  } else if (passed.has('audit:all')) {
    for (const sub of subAuditors) passed.add(sub);
  }
  return { failedGates: [...failedGates.values()], passedGates: [...passed], summaryLines };
}

/**
 * Ultime ~N righe UTILI dello step fallito da un log di job GitHub Actions.
 *
 * - strip timestamp ISO + sequenze ANSI;
 * - i blocchi `##[group]` … `##[endgroup]` vengono scartati per intero: è lì
 *   che vive il dump `env:` con i secret mascherati (rumore, e nomi di secret
 *   che non devono finire in una issue);
 * - la finestra termina all'ULTIMO `##[error]` del log: i log di job non
 *   hanno delimitatori per-step, ma gli step post-failure (cache save,
 *   upload artifact, reporter) non emettono `##[error]`, quindi l'ultimo
 *   `##[error]` è la coda dello step fallito (verificato sui run
 *   31259344953 e 31247086904).
 */
// Un body che cita un path `.github/workflows/**` fa terminare issue-fix.yml
// PRIMA di Claude (scripts/ci/check-workflows-scope.mjs, Mode 1) — zero token,
// nessuna PR. I log dei job lo contengono davvero: ogni job di un reusable
// workflow apre con `Uses: <owner>/<repo>/.github/workflows/<file>.yml@<ref>`
// (misurato nel log del job 93107610821), e quella riga entra nell'estratto
// ogni volta che il job muore presto — cioè proprio quando la diagnosi serve.
// Redigiamo tenendo il NOME del workflow, che all'umano serve, e togliendo il
// prefisso di path, che è l'unica cosa su cui il guard matcha.
export function redactWorkflowPaths(text) {
  return String(text ?? '').replace(
    /\.github\/workflows\/([A-Za-z0-9._/-]+\.ya?ml)/g,
    (_m, file) => `«workflow ${file}»`,
  );
}

export function extractStepExcerpt(text, { maxLines = EXCERPT_LINES } = {}) {
  const kept = [];
  let inGroup = false;
  for (const raw of String(text || '').split('\n')) {
    const line = cleanLogLine(raw);
    if (line.startsWith('##[group]')) { inGroup = true; continue; }
    if (line.startsWith('##[endgroup]')) { inGroup = false; continue; }
    if (inGroup) continue;
    if (!line.trim()) continue;
    // Belt-and-braces: una riga `  NOME: ***` fuori da un group è comunque un
    // valore mascherato, mai utile in un estratto.
    if (/^\s+[A-Za-z_][A-Za-z0-9_]*:\s*\*\*\*$/.test(line)) continue;
    kept.push(line);
  }
  let end = kept.length;
  for (let i = kept.length - 1; i >= 0; i--) {
    if (kept[i].startsWith('##[error]')) { end = i + 1; break; }
  }
  return redactWorkflowPaths(kept.slice(Math.max(0, end - maxLines), end).join('\n'));
}

/**
 * Titolo per-gate, SEMPRE dentro la finestra di dedup (60 char). Se il gate
 * non ci sta, troncatura deterministica a token intero (separatori `:` `/`
 * `-`), MAI a metà parola: searchSafePrefix scarterebbe il token spezzato e
 * due gate diversi potrebbero collassare su prefissi diversi tra create e
 * resolve.
 */
export function titleForGate(gate) {
  const full = TITLE_PREFIX + gate;
  if (full.length <= DEDUP_TITLE_PREFIX_LEN) return full;
  const budget = DEDUP_TITLE_PREFIX_LEN - TITLE_PREFIX.length;
  let cut = String(gate).slice(0, budget);
  if (/[^:/\-]/.test(String(gate)[budget] || '')) {
    // il taglio ha spezzato un token → scarta il frammento finale
    cut = cut.replace(/[^:/\-]*$/, '');
  }
  cut = cut.replace(/[:/\-]+$/, '');
  if (cut.length < 4) cut = String(gate).slice(0, budget); // guardia anti-vuoto
  return TITLE_PREFIX + cut;
}

/** Label per-gate `ci-gate:<slug>` (kebab-case, solo [a-z0-9-]). */
export function gateLabel(gate) {
  const slug = String(gate)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `ci-gate:${slug || 'unknown'}`;
}

/**
 * Comando npm + path degli script del gate, ricavati da package.json (mai
 * hardcoded: se il gate cambia script, il body segue).
 */
export function gateToRepro(gate, scripts = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(scripts, k);
  let npmScript = null;
  if (has(gate)) npmScript = gate;
  else if (String(gate).startsWith('audit:all/')) {
    const sub = `audit:${String(gate).slice('audit:all/'.length)}`;
    if (has(sub)) npmScript = sub;
    else if (has('audit:all')) npmScript = 'audit:all';
  }
  const command = npmScript ? String(scripts[npmScript]) : '';
  const paths = [...new Set(command.match(/(?:scripts|data)\/[A-Za-z0-9._/-]+/g) || [])];
  return { npmScript, command, paths };
}

/**
 * Argomento `audits` per il replay `gh workflow run audit-dist-from-run.yml`.
 *
 * Quel workflow prefissa `audit:` ai nomi NUDI e invoca LETTERALMENTE i nomi
 * che portano già un namespace canonico (`audit:`, `validate:`, `lint:`,
 * `gate:`, `check:` — la KNOWN_PREFIXES del suo step, allineata a GATE_NS_RE).
 * Quindi per un `audit:*` si passa il nome senza prefisso, per un `gate:*` il
 * nome intero.
 *
 * `gate:*` tornava `null` (issue #5918, seconda metà): il CONSUMATORE sapeva
 * rigiocare i gate ma il produttore del body non lo diceva a nessuno, e la
 * issue auto-aperta per `gate:dist-quality` stampava «non è un audit
 * rieseguibile da artifact: serve una rebuild» — falso da quando il replay li
 * accetta. Chi la leggeva pagava una rebuild da 40 minuti per niente.
 *
 * `validate:*` / `lint:*` / `check:*` restano `null` di proposito, ed è una
 * scelta di SEMANTICA, non di sintassi: il workflow li invocherebbe, ma
 * validano il SORGENTE o pretendono una build fresca, non il `dist/`
 * rehydratato dall'artifact — annunciare quel replay significherebbe annunciare
 * un verdetto su un albero diverso da quello sotto indagine.
 */
export function replayAuditsArg(gate, scripts = {}) {
  const g = String(gate);
  const has = (k) => Object.prototype.hasOwnProperty.call(scripts, k);
  if (g.startsWith('audit:all/')) {
    const sub = g.slice('audit:all/'.length);
    return has(`audit:${sub}`) ? sub : 'all';
  }
  if (g.startsWith('audit:')) {
    const rest = g.slice('audit:'.length);
    return has(g) || rest === 'all' ? rest : null;
  }
  // Un gate replayabile dall'artifact: nome intero, e solo se è davvero uno
  // script (un nome inventato qui diventerebbe un `Missing script` nel replay).
  if (g.startsWith('gate:')) return has(g) ? g : null;
  return null;
}

function runUrl(repo, id) {
  return `https://github.com/${repo}/actions/runs/${id}`;
}

/* ── freschezza della build validata (LC-09) ─────────────────────────── */

/**
 * Parcheggio ritentabile che il ciclo ha già: il drain di
 * scripts/ci/followup-drainer.mjs non promuove una issue `fu-parked`, il suo
 * PARKED-RETRY la ri-accoda col cooldown lungo di `fu-data-pending`, e
 * `fu-parked` sta in ROUTING_LABELS di scripts/ci/triage-sweep.mjs. Nessuna
 * label nuova.
 */
export const PARK_LABELS = Object.freeze(['fu-parked', 'fu-data-pending']);
const VALIDATED_BUILD_RE = /<!-- VALIDATED_BUILD: ([^>]*?) -->/;

function fmtMeasure(v) {
  return v === null || v === undefined ? 'unknown' : String(v);
}

/**
 * Marker macchina della build validata. `main` è lo SHA di `main` al momento
 * della misura: alla validazione successiva serve a dire se la nuova build lo
 * contiene (cioè se contiene ogni fix che `main` aveva allora).
 * @param {string} deployRef
 * @param {{ mainSha: string|null, mainAhead: number|null, newerBuild: boolean|null }} f
 */
export function validatedBuildMarker(deployRef, f) {
  return `<!-- VALIDATED_BUILD: sha=${deployRef || 'unknown'} main_ahead=${fmtMeasure(f?.mainAhead)} newer_build=${fmtMeasure(f?.newerBuild)} main=${f?.mainSha || 'unknown'} -->`;
}

/** Il marker dal body di una issue; null se assente. Pura. */
export function parseValidatedBuildMarker(body) {
  const m = VALIDATED_BUILD_RE.exec(String(body || ''));
  if (!m) return null;
  const fields = Object.fromEntries(
    m[1].trim().split(/\s+/).map((kv) => kv.split('=')).filter((p) => p.length === 2),
  );
  const ahead = /^\d+$/.test(fields.main_ahead || '') ? Number(fields.main_ahead) : null;
  const newer = fields.newer_build === 'true' ? true : fields.newer_build === 'false' ? false : null;
  const sha = (v) => (/^[0-9a-f]{7,40}$/i.test(v || '') ? v : null);
  return { sha: sha(fields.sha), mainAhead: ahead, newerBuild: newer, mainSha: sha(fields.main) };
}

/**
 * La issue NUOVA va parcheggiata? Solo con ENTRAMBE le prove misurate: `main`
 * avanti rispetto alla build validata, e una build successiva già riuscita la
 * cui validazione arriverà. Qualunque `null` (misura fallita) → false: la
 * issue resta instradata come prima (fail-closed verso il fixer). Pura.
 */
export function shouldParkNewIssue(f) {
  return Boolean(f) && Number.isInteger(f.mainAhead) && f.mainAhead > 0 && f.newerBuild === true;
}

/**
 * Righe del body sotto «Build SHA»: la misura in chiaro + il marker. Pura.
 * Lessico scelto apposta per NON far scattare DATA_PENDING_RE del drainer su
 * una issue non parcheggiata.
 */
export function freshnessLines(deployRef, f, { repo = '' } = {}) {
  const ahead = Number.isInteger(f?.mainAhead)
    ? (f.mainAhead === 0
      ? '`main` coincide con questa build (0 commit avanti)'
      : `\`main\` (\`${String(f.mainSha).slice(0, 11)}\`) è avanti di ${f.mainAhead} commit rispetto a questa build`)
    : 'distanza da `main` non misurabile (lettura API fallita)';
  const newer = f?.newerBuild === true
    ? `build successiva già riuscita: sì${f.newerRunId && repo ? ` (${runUrl(repo, f.newerRunId)})` : ''}`
    : f?.newerBuild === false
      ? 'build successiva già riuscita: no'
      : 'build successiva già riuscita: non determinabile';
  const lines = [`- **Freschezza della build validata:** ${ahead} · ${newer}`];
  if (shouldParkNewIssue(f)) {
    lines.push(
      `- **Instradamento:** issue nuova parcheggiata (\`${PARK_LABELS.join('` + `')}\`): questa build precede \`main\` e una build più recente è già riuscita, quindi il difetto può essere già corretto. La validazione successiva chiude la issue se il gate rientra, oppure toglie il parcheggio se il gate resta rosso su una build che contiene il \`main\` qui sopra.`,
    );
  }
  lines.push(validatedBuildMarker(deployRef, f));
  return lines;
}

/**
 * Sblocco di una issue parcheggiata dal reporter, alla validazione successiva
 * in cui il suo gate è ancora rosso. Pura.
 *  - 'skip'    : non è un parcheggio di questo reporter (marker assente o senza
 *                le due prove): non è affar nostro;
 *  - 'keep'    : stessa build rivalidata, o build che ancora non contiene il
 *                `main` di allora → la prova non è cambiata, resta parcheggiata;
 *  - 'release' : la build contiene il `main` di allora (ricorrenza vera), o il
 *                contenimento non è misurabile (fail-closed verso il fixer).
 * @param {{ marker: ReturnType<typeof parseValidatedBuildMarker>, deployRef: string, contains: boolean|null }} input
 */
export function parkedReleaseDecision({ marker, deployRef, contains }) {
  if (!marker || !shouldParkNewIssue(marker)) return 'skip';
  if (deployRef && marker.sha && deployRef === marker.sha) return 'keep';
  if (contains === false) return 'keep';
  return 'release';
}

function fence(text) {
  return '```text\n' + String(text || '').replace(/```/g, '`​``') + '\n```';
}

/**
 * Compone i payload issue: uno per gate fallito (max MAX_PER_GATE_ISSUES),
 * altrimenti — zero gate riconosciuti (fallimento infra prima dei gate) o
 * troppi (rosso sistemico) — una sola issue riassuntiva col titolo legacy.
 * I gate in CATHEDRAL_OWNED_GATES non producono payload (vedi sopra); se
 * erano gli unici falliti il risultato è vuoto, senza riassuntiva.
 *
 * Funzione PURA: nessuna chiamata gh, testabile con input sintetici.
 *
 * @param {{
 *   repo: string, runId: string, runAttempt?: string,
 *   deployRunId?: string, deployRef?: string, deployEvent?: string,
 *   results?: { dist?: string, source?: string, postbuild?: string, bfs?: string },
 *   failedJobs?: { name: string, htmlUrl?: string, failedStep?: string,
 *                  gates?: ReturnType<typeof parseGateLines>['failedGates'],
 *                  summaryLines?: string[], excerpt?: string, logNote?: string }[],
 *   pkgScripts?: Record<string, string>,
 *   reports?: Record<string, { report: Record<string, unknown> | null, source: string }>,
 *   freshness?: { mainSha: string|null, mainAhead: number|null, newerBuild: boolean|null, newerRunId?: string|null } | null,
 * }} input
 * @returns {{ title: string, labels: string[], body: string, priority: number, gate: string | null }[]}
 */
export function buildIssuePayloads(input) {
  const {
    repo, runId, runAttempt = '1',
    deployRunId = '', deployRef = '', deployEvent = '',
    results = {}, failedJobs = [], pkgScripts = {}, reports = {},
    freshness = null,
  } = input;
  // Le label di parcheggio valgono solo alla CREAZIONE: createGithubIssue le
  // applica in `gh issue create`, mentre una ricorrenza su issue già aperta è
  // un commento (e una riapertura non tocca le label). Il parcheggio resta
  // quindi confinato alla issue nuova per costruzione.
  const parkLabels = shouldParkNewIssue(freshness) ? [...PARK_LABELS] : [];

  // gate → job che l'ha riportato (primo vince: i gate sono per-job)
  const gateRows = new Map();
  for (const job of failedJobs) {
    for (const g of job.gates || []) {
      if (!gateRows.has(g.gate)) gateRows.set(g.gate, { ...g, job });
    }
  }

  const jobResults = results.dist
    ? `- **Job results:** dist=${results.dist}`
    : `- **Job results:** source=${results.source || 'n/d'} · postbuild=${results.postbuild || 'n/d'} · bfs=${results.bfs || 'n/d'}`;
  const header = [
    '## Run',
    `- **Validation run:** ${runUrl(repo, runId)} (attempt ${runAttempt})`,
    deployRunId
      ? `- **Build run:** ${runUrl(repo, deployRunId)} (artifact e log della build vivono lì)`
      : '- **Build run:** non determinabile (deploy_run_id assente)',
    '',
    '## Build SHA',
    deployRef
      ? `- **Build SHA:** \`${deployRef}\` (= \`deploy_ref\` = \`workflow_run.head_sha\`: il commit della BUILD. Per un run innescato da workflow_run \`github.sha\` NON è questo commit — non usarlo.)`
      : '- **Build SHA:** non disponibile (deploy_ref non passato: run legacy o dispatch manuale — NON ripiegare su github.sha, che per workflow_run non è il commit della build)',
    ...(freshness ? freshnessLines(deployRef, freshness, { repo }) : []),
    deployEvent ? `- **Trigger build:** ${deployEvent}` : null,
    jobResults,
    '',
    '## Job/step falliti',
    ...(failedJobs.length > 0
      ? failedJobs.map((j) => {
          const step = j.failedStep ? ` — step fallito: \`${j.failedStep}\`` : '';
          const url = j.htmlUrl ? ` — ${j.htmlUrl}` : '';
          return `- **${j.name}**${step}${url}`;
        })
      : ['- nessun job fallito individuato via jobs API (vedi Job results sopra)']),
  ].filter((l) => l !== null);

  const notes = failedJobs.filter((j) => j.logNote).map((j) => `- ${j.name}: ${j.logNote}`);

  function reproSection(gate) {
    const { npmScript, command, paths } = gateToRepro(gate, pkgScripts);
    const lines = ['## Riproduzione locale'];
    if (npmScript) {
      lines.push(
        `- \`npm run ${npmScript}\` (→ \`${command}\`) — richiede un \`dist/\` completo del sito logico (build locale o rehydrate degli shard).`,
      );
    } else {
      lines.push(
        gate
          ? `- nessuno script npm mappato per \`${gate}\` in package.json — cerca il gate nel job di validazione post-deploy e riproduci lo script corrispondente.`
          : '- nessun gate riconosciuto: la catena è morta prima di stamparne uno (rehydrate, artifact o assert-dist-complete). Partire dagli estratti log qui sopra e da `scripts/ci/assert-dist-complete.mjs`.',
      );
    }
    lines.push(
      `- Offender completi SENZA rilanciare nulla: \`gh run download ${runId} -p "audit-reports*"\` — l'artifact \`audit-reports*-${runId}-${runAttempt}\` contiene i report JSON: contano \`byFeature\` e \`baselineDelta\`; \`topOffenders\` depista (è il campione, non la causa).`,
    );
    return lines;
  }

  function replaySection(gate) {
    const lines = ['## Replay'];
    const auditsArg = gate ? replayAuditsArg(gate, pkgScripts) : null;
    if (auditsArg && deployRunId) {
      lines.push(
        '- Rigira SOLO gli audit dagli artifact del run di build (niente rebuild):',
        '',
        `  \`gh workflow run audit-dist-from-run.yml -f deploy_run_id=${deployRunId} -f audits=${auditsArg}\``,
      );
    } else if (auditsArg) {
      lines.push('- Replay possibile via `gh workflow run audit-dist-from-run.yml -f deploy_run_id=<run della build> -f audits=' + auditsArg + '` — il deploy_run_id non era disponibile a questo reporter.');
    } else {
      lines.push('- Il gate non è rieseguibile dall\'artifact di deploy (valida il sorgente o pretende una build fresca, non il `dist/` rehydratato): serve una rebuild per riprodurlo in CI. I gate `audit:*` e `gate:*` invece si rigiocano — se ne vedi uno qui, il nome non è fra gli script di `package.json`.');
    }
    return lines;
  }

  function suggestedAction(gate) {
    const lines = ['## Suggested action'];
    const paths = gate ? gateToRepro(gate, pkgScripts).paths : [];
    if (paths.length > 0) for (const p of paths) lines.push(`- \`${p}\``);
    else lines.push('- `scripts/ci/classify-validate-dist-failures.mjs` (mappa gate → classe di fallimento; da lì si risale allo script del gate)');
    return lines;
  }

  function offenderLines(gate) {
    const entry = reports[gate];
    return [
      ...renderOffenderSection(entry?.report ?? null, {
        gate,
        source: entry?.source || `artifact \`audit-reports*-${runId}-${runAttempt}\``,
      }),
      '',
    ];
  }

  function excerptSections(jobs) {
    const out = [];
    for (const j of jobs) {
      if (!j.excerpt) continue;
      out.push(`## Estratto log (${j.name})`, fence(j.excerpt), '');
    }
    return out;
  }

  const recognized = [...gateRows.values()];
  const allGates = recognized.filter(({ gate }) => !CATHEDRAL_OWNED_GATES.has(gate));
  if (recognized.length > 0 && allGates.length === 0) return [];

  if (allGates.length > 0 && allGates.length <= MAX_PER_GATE_ISSUES) {
    return allGates.map(({ gate, line, job }) => {
      const body = [
        `## Dist validation post-deploy fallita — gate \`${gate}\``,
        '',
        ...header,
        '',
        '## Gate falliti',
        fence([line, ...(job.summaryLines || [])].join('\n')),
        '',
        ...offenderLines(gate),
        ...excerptSections([job]),
        ...(notes.length > 0 ? ['## Note', ...notes, ''] : []),
        ...reproSection(gate),
        '',
        ...replaySection(gate),
        '',
        ...suggestedAction(gate),
      ].join('\n');
      // Redazione anche sul body completo, non solo sull'estratto: un nome di
      // job/step o una nota futura potrebbero reintrodurre il path che
      // disinnesca il fixer. Un punto solo, applicato sempre.
      return {
        title: titleForGate(gate),
        labels: ['Bug', gateLabel(gate), ...parkLabels],
        body: redactWorkflowPaths(body),
        priority: issuePriorityForGate(gate),
        gate,
      };
    });
  }

  // Fallback riassuntivo (0 gate riconosciuti, o troppi): titolo legacy.
  const gateBlock = allGates.length > 0
    ? fence(allGates.map((g) => [g.line, ...(g.job.summaryLines || [])].join('\n')).join('\n'))
    : '_nessuna riga `❌ FAIL <gate>` trovata nei log dei job falliti: fallimento infra prima dei gate (rehydrate/artifact/assert-dist-complete) — vedi estratti sotto._';
  const primaryGate = allGates[0]?.gate || null;
  const body = [
    '## Dist validation post-deploy fallita',
    '',
    ...header,
    '',
    '## Gate falliti',
    gateBlock,
    '',
    ...excerptSections(failedJobs.slice(0, MAX_FAILED_JOBS)),
    ...(notes.length > 0 ? ['## Note', ...notes, ''] : []),
    ...reproSection(primaryGate),
    '',
    ...replaySection(primaryGate),
    '',
    ...suggestedAction(primaryGate),
  ].join('\n');
  return [{ title: LEGACY_TITLE, labels: ['Bug', ...parkLabels], body: redactWorkflowPaths(body), priority: 1, gate: null }];
}

/** Titoli aperti che il resolve deve chiudere: legacy + per-gate, dedup. */
export function selectResolvableTitles(openTitles) {
  return [...new Set((openTitles || []).filter(
    (t) => typeof t === 'string' && t.startsWith(TITLE_PREFIX.trimEnd()),
  ))];
}

/**
 * Individua il job corrente della matrice build (`build-locale (en)`): la
 * jobs API espone il display name, il workflow conosce solo la chiave
 * (`github.job`) e il locale.
 */
export function findCurrentBuildJob(jobs, jobKey, locale) {
  const list = jobs || [];
  const exact = list.find((j) => j.name === (locale ? `${jobKey} (${locale})` : jobKey));
  if (exact) return exact;
  return list.find(
    (j) => typeof j.name === 'string'
      && j.name.startsWith(jobKey)
      && (!locale || j.name.includes(`(${locale}`)),
  ) || null;
}

/* ── strato gh (best-effort: ogni fallimento degrada, mai un exit != 0) ── */

// `gh api` non ha un timeout proprio e il keepalive TCP non copre uno stream
// che rallenta senza morire: su un log da decine di MB execFileSync resterebbe
// bloccato a oltranza. Il tetto per chiamata tiene il job dentro il suo
// timeout-minutes anche nel caso peggiore (3 job × 2 tentativi).
const GH_TIMEOUT_MS = 120_000;

function gh(args, { maxBuffer = 256 * 1024 * 1024 } = {}) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer,
      timeout: GH_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch {
    return null;
  }
}

function fetchRunJobs(repo, runId) {
  const out = gh(['api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`]);
  if (out === null) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// Primo helper del repo che scarica log via jobs API: robusto per contratto —
// null su qualunque errore (log scaduto, 404 su run in corso, gh vecchio
// senza --allow-escape-sequences), e il chiamante annota la degradazione nel
// body invece di fallire.
function fetchJobLog(repo, jobId) {
  return gh(['api', `repos/${repo}/actions/jobs/${jobId}/logs`, '--allow-escape-sequences'])
    ?? gh(['api', `repos/${repo}/actions/jobs/${jobId}/logs`]);
}

function readPkgScripts() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts || {};
  } catch {
    return {};
  }
}

function firstFailedStep(job) {
  return (job.steps || []).find((s) => s.conclusion === 'failure')?.name || '';
}

function ghJson(args) {
  const out = gh(args, { maxBuffer: 32 * 1024 * 1024 });
  if (out === null) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * `head` contiene `base`? Dal compare: `behind_by` conta i commit di `base`
 * assenti da `head`. null su lettura fallita, mai un numero inventato.
 */
function buildContainsCommit(repo, base, head) {
  if (!repo || !base || !head) return null;
  const cmp = ghJson(['api', `repos/${repo}/compare/${base}...${head}`, '--jq', '{status: .status, behind_by: .behind_by}']);
  return Number.isInteger(cmp?.behind_by) ? cmp.behind_by === 0 : null;
}

/**
 * Freschezza della build validata. Tre letture, ognuna best-effort (null su
 * qualunque errore):
 *  - `main` risolto a uno SHA (il marker lo conserva per la validazione dopo);
 *  - `ahead_by` di `compare/<deployRef>...<main>`;
 *  - build successiva riuscita: dalla STESSA sorgente da cui il reporter
 *    conosce `deployRunId` (la run di build che ha innescato la validazione):
 *    si legge il suo workflow e il suo `created_at`, e si cercano run dello
 *    stesso workflow, su `main`, riuscite, create dopo, a uno SHA diverso.
 *    Il filtro `created>=` più il ricontrollo locale proteggono dal listato
 *    `branch=…&status=success` che a volte restituisce run vecchie.
 * @returns {{ mainSha: string|null, mainAhead: number|null, newerBuild: boolean|null, newerRunId: string|null }}
 */
export function measureBuildFreshness({ repo, deployRef, deployRunId }) {
  const out = { mainSha: null, mainAhead: null, newerBuild: null, newerRunId: null };
  if (!repo || !deployRef) return out;
  const main = gh(['api', `repos/${repo}/commits/main`, '--jq', '.sha']);
  const mainSha = /^[0-9a-f]{40}$/i.test(String(main || '').trim()) ? String(main).trim() : null;
  if (mainSha) {
    out.mainSha = mainSha;
    const cmp = ghJson(['api', `repos/${repo}/compare/${deployRef}...${mainSha}`, '--jq', '{status: .status, ahead_by: .ahead_by}']);
    if (Number.isInteger(cmp?.ahead_by)) out.mainAhead = cmp.ahead_by;
  }
  if (!deployRunId) return out;
  const run = ghJson(['api', `repos/${repo}/actions/runs/${deployRunId}`, '--jq', '{workflow_id: .workflow_id, created_at: .created_at}']);
  const createdMs = Date.parse(run?.created_at || '');
  if (!run?.workflow_id || !Number.isFinite(createdMs)) return out;
  const created = encodeURIComponent(`>=${run.created_at}`);
  const list = ghJson(['api',
    `repos/${repo}/actions/workflows/${run.workflow_id}/runs?branch=main&status=success&created=${created}&per_page=50`,
    '--jq', '[.workflow_runs[] | {id: .id, head_sha: .head_sha, created_at: .created_at}]']);
  if (!Array.isArray(list)) return out;
  const newer = list
    .filter((r) => String(r.id) !== String(deployRunId)
      && r.head_sha && r.head_sha !== deployRef
      && Date.parse(r.created_at || '') > createdMs)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  out.newerBuild = newer.length > 0;
  out.newerRunId = newer[0] ? String(newer[0].id) : null;
  return out;
}

/**
 * Alla validazione successiva: le issue parcheggiate da questo reporter il cui
 * gate è ANCORA rosso vengono sbloccate se la build corrente contiene il `main`
 * registrato nel marker (ricorrenza vera → instradamento normale: senza label
 * di routing la riprende triage-sweep). Gate verde → le chiude
 * resolvePassedGates, come prima. Best-effort, mai un throw.
 * @returns {{ number: number, decision: string }[]}
 */
export function releaseParkedRecurrences({ repo, runId = '', deployRef, failingTitles }) {
  const failing = new Set(failingTitles || []);
  if (failing.size === 0) return [];
  const repoArgs = repo ? ['--repo', repo] : [];
  const parked = ghJson(['issue', 'list', '--state', 'open',
    ...PARK_LABELS.flatMap((l) => ['--label', l]),
    '--limit', '100', '--json', 'number,title,body', ...repoArgs]);
  if (!Array.isArray(parked)) return [];
  const outcomes = [];
  for (const iss of parked) {
    if (!failing.has(iss.title)) continue;
    const marker = parseValidatedBuildMarker(iss.body);
    const sameBuild = Boolean(marker?.sha && deployRef && marker.sha === deployRef);
    // Il compare costa una chiamata: solo per i parcheggi di questo reporter
    // su una build diversa da quella che li ha aperti.
    const contains = !shouldParkNewIssue(marker) || sameBuild ? null : buildContainsCommit(repo, marker.mainSha, deployRef);
    const decision = parkedReleaseDecision({ marker, deployRef, contains });
    outcomes.push({ number: iss.number, decision });
    if (decision !== 'release') {
      if (decision === 'keep') {
        console.log(`[report-validate-dist-failure] #${iss.number} resta parcheggiata: ${sameBuild
          ? `è di nuovo la build \`${deployRef}\` che l'ha aperta`
          : `la build \`${deployRef}\` non contiene ancora \`${marker.mainSha}\``}.`);
      }
      continue;
    }
    const edited = gh(['issue', 'edit', String(iss.number),
      ...PARK_LABELS.flatMap((l) => ['--remove-label', l]), ...repoArgs]);
    if (edited === null) {
      console.error(`[report-validate-dist-failure] sblocco di #${iss.number} fallito (gh issue edit)`);
      continue;
    }
    const why = contains === true
      ? `la build \`${deployRef}\` contiene \`${marker.mainSha}\`, cioè il \`main\` di quando la issue è stata parcheggiata`
      : `il contenimento di \`${marker.mainSha}\` nella build \`${deployRef || 'unknown'}\` non è misurabile, quindi si torna all'instradamento normale`;
    gh(['issue', 'comment', String(iss.number), '--body',
      `▶️ **Parcheggio tolto** — il gate è ancora rosso${runId && repo ? ` nella validazione ${runUrl(repo, runId)}` : ''} e ${why}: è una ricorrenza vera, la issue torna nella coda del fixer.`,
      ...repoArgs]);
    console.log(`[report-validate-dist-failure] #${iss.number} sbloccata (${PARK_LABELS.join(' + ')} tolte).`);
  }
  return outcomes;
}

/* ── modalità ────────────────────────────────────────────────────────── */

export function reportDist({ dryRun }) {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const runId = process.env.RUN_ID || process.env.GITHUB_RUN_ID || '';
  const runAttempt = process.env.RUN_ATTEMPT || process.env.GITHUB_RUN_ATTEMPT || '1';
  const deployRunId = process.env.INPUT_DEPLOY_RUN_ID || process.env.DEPLOY_RUN_ID || '';
  const deployRef = process.env.INPUT_DEPLOY_REF || process.env.DEPLOY_REF || '';
  const deployEvent = process.env.INPUT_DEPLOY_EVENT || process.env.DEPLOY_EVENT || '';
  const distResult = process.env.DIST_RESULT || '';
  const results = distResult
    ? { dist: distResult }
    : {
        source: process.env.SOURCE_RESULT || '',
        postbuild: process.env.POSTBUILD_RESULT || '',
        bfs: process.env.BFS_RESULT || '',
      };

  const failedJobs = [];
  const passedGates = new Set();
  if (repo && runId) {
    const data = fetchRunJobs(repo, runId);
    if (data) {
      // Solo i job di validate-dist: il run chiamante (deploy-publish) contiene
      // anche deploy/publish, che hanno i loro reporter.
      const failed = (data.jobs || []).filter(
        (j) => j.conclusion === 'failure' && /validate-dist/.test(j.name || ''),
      );
      for (const job of failed.slice(0, MAX_FAILED_JOBS)) {
        const log = fetchJobLog(repo, job.id);
        const parsed = log ? parseGateLines(log) : { failedGates: [], passedGates: [], summaryLines: [] };
        for (const g of parsed.passedGates) passedGates.add(g);
        failedJobs.push({
          name: job.name,
          htmlUrl: job.html_url,
          failedStep: firstFailedStep(job),
          gates: parsed.failedGates,
          summaryLines: parsed.summaryLines,
          excerpt: log ? extractStepExcerpt(log) : '',
          logNote: log ? '' : 'log del job non scaricabile via API (scaduto o non ancora disponibile) — diagnosi limitata a job/step',
        });
      }
    } else {
      console.error('[report-validate-dist-failure] jobs API non raggiungibile — degrado a issue riassuntiva senza dettaglio job');
    }
  }

  const failedGateNames = failedJobs.flatMap((j) => (j.gates || []).map((g) => g.gate));
  const reports = loadGateReports(failedGateNames, process.env.VALIDATE_DIST_REPORTS_DIR || '', `${runId}-${runAttempt}`);
  const payloadInput = {
    repo, runId, runAttempt, deployRunId, deployRef, deployEvent,
    results, failedJobs, pkgScripts: readPkgScripts(), reports,
  };
  let payloads = buildIssuePayloads(payloadInput);
  // La freschezza si misura solo se c'è almeno una issue da scrivere: un run
  // i cui gate rossi sono tutti di cathedral non spende le letture.
  const freshness = payloads.length > 0 ? measureBuildFreshness({ repo, deployRef, deployRunId }) : null;
  if (freshness) {
    console.log(`[report-validate-dist-failure] ${validatedBuildMarker(deployRef, freshness)}`);
    payloads = buildIssuePayloads({ ...payloadInput, freshness });
  }
  const resolvable = gatesToResolve([...passedGates], failedGateNames);

  if (dryRun) {
    process.stdout.write(JSON.stringify({ payloads, resolvable: resolvable.map(titleForGate), freshness }, null, 2) + '\n');
    return Promise.resolve();
  }

  // Sequenziale: createGithubIssue dedupa per titolo, qui a titolo ESATTO
  // (`Validation Failure (dist): audit:all` è prefisso di ogni
  // `…audit:all/<sotto-auditor>`), reopen entro 6h per il flap
  // rosso→verde→rosso (#928/#931/#937/#941). deployRef è il commit della BUILD
  // (workflow_run.head_sha), distinto dal run che la valida — passarlo abilita
  // il guard anti-latenza (#5539): se predata la fix che ha chiuso la issue, il
  // reopener non la riapre.
  return payloads.reduce(
    (p, payload) => p.then(() => createGithubIssue({
      title: payload.title,
      description: payload.body,
      priority: payload.priority,
      labels: payload.labels,
      workflow: WORKFLOW_DISPLAY_NAME,
      reopenWithinHours: 6,
      buildSha: deployRef || null,
      exactTitle: payload.gate !== null,
    })),
    Promise.resolve(),
  )
    .then(() => releaseParkedRecurrences({ repo, runId, deployRef, failingTitles: payloads.map((p) => p.title) }))
    .then(() => resolvePassedGates(repo, runId, resolvable));
}

/**
 * Report JSON dei gate falliti, letti dalla cartella dove il job di report ha
 * scaricato l'artifact `audit-reports*` del run. Best-effort: un file assente
 * o illeggibile dà `report: null`, e il body lo dice.
 * @returns {Record<string, { report: Record<string, unknown> | null, source: string }>}
 */
export function loadGateReports(gates, dir, runTag) {
  /** @type {Record<string, { report: Record<string, unknown> | null, source: string }>} */
  const out = {};
  for (const gate of gates) {
    let entry = { report: null, source: `artifact \`audit-reports*-${runTag}\`` };
    if (dir) {
      for (const name of reportFileCandidates(gate)) {
        try {
          const report = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
          entry = { report, source: `\`audit-reports/${name}\` nell'artifact \`audit-reports*-${runTag}\`` };
          break;
        } catch { /* prova il candidato successivo */ }
      }
    }
    out[gate] = entry;
  }
  return out;
}

/**
 * Gate le cui issue si possono chiudere dopo questo run: passati, e non anche
 * falliti (un gate compare una volta sola per job, ma i job sono più d'uno).
 * `audit:all` opaco solo se il bundle è passato per intero. Pura.
 */
export function gatesToResolve(passedGates, failedGates) {
  const failed = new Set(failedGates);
  return [...new Set(passedGates)]
    .filter((g) => !failed.has(g) && !/\(/.test(g))
    .filter((g) => g !== 'audit:all' || !failedGates.some((f) => f.startsWith('audit:all')))
    .sort();
}

/** Chiude, a titolo esatto, le issue aperte dei gate rientrati. Best-effort. */
function resolvePassedGates(repo, runId, gates) {
  if (gates.length === 0) return;
  const open = new Set(listOpenReporterTitles(repo));
  for (const gate of gates) {
    const title = titleForGate(gate);
    if (!open.has(title)) continue;
    try {
      resolveGithubIssue(title, {
        workflow: WORKFLOW_DISPLAY_NAME,
        runUrl: repo && runId ? runUrl(repo, runId) : undefined,
        exactTitle: true,
      });
    } catch (err) {
      console.error(`[report-validate-dist-failure] resolve ${title}: ${err?.message || err}`);
    }
  }
}

function reportBuild({ dryRun }) {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const runId = process.env.RUN_ID || process.env.GITHUB_RUN_ID || '';
  const jobKey = process.env.JOB_KEY || process.env.GITHUB_JOB || '';
  const locale = process.env.LOCALE || '';
  const workflowName = process.env.WORKFLOW_NAME || process.env.GITHUB_WORKFLOW || 'Deploy to GitHub Pages';
  const branch = process.env.BRANCH || process.env.GITHUB_REF_NAME || '';
  const eventName = process.env.EVENT_NAME || process.env.GITHUB_EVENT_NAME || '';
  const diagFile = process.env.DIAG_FILE || '/tmp/build-failure-diag.txt';

  // Il job è ancora in corso quando questo step gira (`if: failure()` dopo lo
  // step rotto): la jobs API espone già gli step COMPLETATI con la loro
  // conclusion, ma il LOG del job in corso non è scaricabile — l'estratto
  // arriva solo dal diag file locale, se uno step l'ha scritto.
  let failedStep = '';
  if (repo && runId && jobKey) {
    const data = fetchRunJobs(repo, runId);
    const current = findCurrentBuildJob(data?.jobs, jobKey, locale);
    if (current) failedStep = firstFailedStep(current);
  }

  let diagTail = '';
  try {
    if (fs.existsSync(diagFile)) {
      diagTail = extractStepExcerpt(fs.readFileSync(diagFile, 'utf8'));
    }
  } catch { /* best-effort */ }

  const description = [
    '## Build fallito',
    `**Run:** ${runUrl(repo, runId)}`,
    `**Job:** ${jobKey}${locale ? ` (${locale})` : ''}`,
    locale ? `**Locale:** ${locale}` : null,
    failedStep ? `**Step fallito:** \`${failedStep}\`` : '**Step fallito:** non determinabile via jobs API',
    branch ? `**Branch:** ${branch}` : null,
    eventName ? `**Trigger:** ${eventName}` : null,
    ...(diagTail ? ['', '## Estratto diagnostico', fence(diagTail)] : []),
  ].filter((l) => l !== null).join('\n');

  // Titolo INVARIATO rispetto allo step storico: le 4 build della matrice
  // locale collassano sulla stessa issue canonica (load-bearing, #5121).
  const title = `CI Failure (build): ${workflowName}`;

  if (dryRun) {
    process.stdout.write(JSON.stringify([{ title, labels: ['Bug'], body: description }], null, 2) + '\n');
    return Promise.resolve();
  }
  // NIENTE `reopenWithinHours` qui: si eredita DEFAULT_REOPEN_WITHIN_HOURS
  // (720h). C'era `6`, ereditato dal reporter post-deploy qui sopra, dove i 6h
  // sono giusti — quello collassa un flap rosso→verde→rosso dentro UN ciclo di
  // deploy (#928/#931/#937/#941) e ha `buildSha` per il guard anti-latenza
  // #5539. Questo NO: gira dentro il job di build, la build che ha rotto è
  // sempre quella corrente, e il rosso torna a distanza di giorni. Misurato
  // 2026-08-14: 22 issue con il titolo IDENTICO `CI Failure (build): Deploy to
  // GitHub Pages` (#1290 … #5864) — una coniatura per ogni ricaduta oltre i 6h
  // dal verde che aveva chiuso la precedente, sulla issue che #5121 dichiara
  // canonica. Il collasso della matrice a 4 locali NON dipende da questa
  // finestra: quello lo fa il dedup sulle issue APERTE, che è incondizionato.
  return createGithubIssue({
    title,
    description,
    priority: 1,
    labels: ['Bug'],
    workflow: workflowName,
  });
}

/** Titoli aperti di questo reporter (legacy + per-gate), dalle due query. */
function listOpenReporterTitles(repo) {
  const repoArgs = repo ? ['--repo', repo] : [];
  const readTitles = (args) => {
    const out = gh(args, { maxBuffer: 32 * 1024 * 1024 });
    if (out === null) return [];
    try {
      return JSON.parse(out).map((i) => i.title);
    } catch {
      return [];
    }
  };
  return selectResolvableTitles([
    ...readTitles(['issue', 'list', '--state', 'open', '--limit', '200', '--json', 'title', ...repoArgs]),
    ...readTitles(['issue', 'list', '--state', 'open', '--limit', '100', '--json', 'title',
      '--search', `in:title "${TITLE_PREFIX.trim()}"`, ...repoArgs]),
  ]);
}

export function resolveMode({ dryRun }) {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const runId = process.env.RUN_ID || process.env.GITHUB_RUN_ID || '';
  // DUE query, unite. Il listato semplice è ordinato per data di creazione
  // discendente: da solo perderebbe una issue canonica vecchia appena il
  // backlog aperto supera il limite — e queste issue sono longeve per design
  // (si riaprono, non si ricreano), quindi invecchiano verso il fondo. Il
  // search server-side le recupera a qualunque età; resta il listato perché
  // l'indice di ricerca è eventualmente consistente e può non vedere una
  // issue aperta pochi secondi fa (stessa ragione del fallback in
  // github-issue-creator.mjs). Nessuna delle due da sola basta.
  const toResolve = listOpenReporterTitles(repo);
  if (dryRun) {
    process.stdout.write(JSON.stringify(toResolve, null, 2) + '\n');
    return;
  }
  if (toResolve.length === 0) {
    console.log('[report-validate-dist-failure] resolve: nessuna issue "Validation Failure (dist):" aperta');
    return;
  }
  // Titolo esatto: i titoli vengono dalle issue aperte, e a prefisso
  // `…audit:all` chiuderebbe un `…audit:all/<sotto-auditor>` al suo posto.
  for (const title of toResolve) {
    resolveGithubIssue(title, {
      workflow: WORKFLOW_DISPLAY_NAME,
      runUrl: repo && runId ? runUrl(repo, runId) : undefined,
      exactTitle: true,
    });
  }
}

/* ── CLI ─────────────────────────────────────────────────────────────── */

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const argOf = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const mode = argOf('--mode');
  const scope = argOf('--scope') || 'dist';
  const dryRun = args.includes('--dry-run');

  if (!['report', 'resolve'].includes(mode) || !['dist', 'build'].includes(scope)) {
    console.error('Usage: node scripts/ci/report-validate-dist-failure.mjs --mode report|resolve [--scope dist|build] [--dry-run]');
    process.exit(2); // solo l'uso errato dei flag esce non-zero
  }

  const run = mode === 'resolve'
    ? Promise.resolve().then(() => resolveMode({ dryRun }))
    : (scope === 'build' ? reportBuild({ dryRun }) : reportDist({ dryRun }));

  run.then(() => process.exit(0)).catch((err) => {
    // Mai un secondo rosso: il fallimento vero è già registrato dai job gate.
    console.error(`[report-validate-dist-failure] errore (best-effort): ${err?.message || err}`);
    process.exit(0);
  });
}
