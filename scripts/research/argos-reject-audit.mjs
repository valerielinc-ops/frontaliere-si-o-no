#!/usr/bin/env node
/**
 * argos-reject-audit.mjs — ONE-SHOT research tool. NOT part of any pipeline.
 *
 * Question (workspace issue 13): of the candidates the translation pipeline
 * throws away at the Argos stage, what fraction does the existing local Opus-MT
 * tier resolve under the same write guard?
 * The audited baseline is 20'575 successful Argos outputs → 780 fields written:
 * 96,2% discarded, and that verdict has never been checked by anything but the
 * code that emits it.
 *
 * Why the sample has to be GENERATED, not fished out of a log: in
 * scripts/local-mt-mopup.mjs the rejections are silent. The chain is a run of
 * bare `continue`s and the end-of-phase line is `✅ N translated · M failed`,
 * where M counts CALL failures, not refusals. Nothing anywhere persists the
 * rejected text or the reason. So this tool re-runs the real production path on
 * a fresh sample and instruments the chain.
 *
 * Nothing here is a re-implementation: the candidate predicate (needsWork), the
 * slot selection (missingSlots), the request masking (buildMopupRequest), the
 * exit transform (finalizeMopupTranslation) and the whole rejection chain
 * (classifyMopupWrite) are IMPORTED from scripts/local-mt-mopup.mjs, and the
 * translation itself is the same scripts/local-mt-translate.py the nightly runs.
 * A private copy of any of them would be measuring a gate that does not exist.
 *
 * STRATIFIED BY COMPANY, deliberately. fachkraft.ch alone is 21,0% of the gap
 * and on it the gate is demonstrably right (thousands of EN titles are
 * byte-identical to the German). A proportional sample would be mostly
 * fachkraft.ch and would conclude the gate is perfect. Selection here is
 * round-robin over companies, so 653 companies get comparable weight.
 *
 * READ-ONLY on the corpus: it never writes data/, never touches
 * needsRetranslation, never launches or cancels a production run. Its only
 * output is the report file.
 *
 * Usage:
 *   node scripts/research/argos-reject-audit.mjs \
 *     --slices-dir <dir with data/jobs/by-crawler slices> \
 *     --max-fields 300 --per-company 1 --out /tmp/argos-reject-audit.json \
 *     --markdown-out .agents/references/argos-vs-opusmt-YYYY-MM-DD.md
 *
 *   # MT_LOCAL_OPUSMT=1 runs the second arm; q8 is the production default.
 *   MT_LOCAL_OPUSMT=1 node scripts/research/argos-reject-audit.mjs ...
 *
 *   # then have Claude judge the rejected cases ($0, CLAUDE_CODE_OAUTH_TOKEN):
 *   node scripts/research/argos-reject-audit.mjs --judge /tmp/argos-reject-audit.json
 *
 * Flags:
 *   --slices-dir DIR   per-crawler slices to read (default data/jobs/by-crawler).
 *                      Point it at an `git archive origin/main data/jobs/by-crawler`
 *                      export to audit the canonical corpus rather than a dirty
 *                      working tree.
 *   --max-fields N     stop queueing once N field translations are queued (300).
 *   --per-company K    max jobs taken per company per round-robin pass (1).
 *   --strategy S       `stratified` (default, the measurement) or `proportional`
 *                      (the control: same company mix as the production queue).
 *   --fields both|title|description   restrict the audited slots (both).
 *   --out PATH         report path (default <tmpdir>/argos-reject-audit.json).
 *   --markdown-out PATH write the requested Markdown summary in addition to JSON.
 *   --python BIN       python interpreter (default $LOCAL_MT_PYTHON or python3).
 *   --judge PATH       skip generation; judge the rejects in an existing report.
 *   --judge-limit N    how many rejects to send to Claude (150).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { listSliceFileNames } from '../lib/crawler-slice-files.mjs';
import {
  needsWork,
  missingSlots,
  buildMopupRequest,
  classifyMopupWrite,
  shouldApplyMopupWrite,
} from '../local-mt-mopup.mjs';
import { titleLooksUntranslated } from '../lib/job-locale-utils.mjs';
import {
  localOpusMtEnabled,
  translateWithLocalOpusMt,
} from '../lib/local-opus-mt.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PY_SCRIPT = path.join(ROOT, 'scripts', 'local-mt-translate.py');
const DECISIONS = [
  'write',
  'skip:candidate-untranslated',
  'skip:source-copy',
  'skip:existing-good',
  'skip:finalize-empty',
  'skip:source-locale',
  'skip:empty-raw',
];
const REQUESTED_CAUSES = [
  'binnen-i',
  'compound-residue',
  'source-overlap',
  'source-function-word',
  'source-orthography',
  'source-copy',
];
const PRODUCTION_SLOT_ESTIMATE = 4900;
const PRODUCTION_ARGOS_SECONDS = 690;
const PRODUCTION_ARGOS_REQUESTS = 4920;
const MOPUP_DEADLINE_MS = 16_800_000;
const MIN_OPUS_RECOVERY_RATE = 0.10;
// The production mix measured on 2026-09-17. The stratified sample is a
// company-balanced audit, not a production-proportional sample: use this only
// for the explicitly labelled production-weighted estimate below.
const PRODUCTION_BINNEN_I_SHARE = 0.45;
const PRODUCTION_BINNEN_I_SLOTS = 1423;
const BINNEN_VARIANT_ORDER = [
  'colon-in',
  'colon-innen',
  'asterisk-in',
  'asterisk-innen',
  'underscore-in',
  'underscore-innen',
  'slash-in',
  'slash-hyphen-in',
  'colon-suffix',
  'gender-r',
  'unknown',
];

function opt(name, fallback) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

/** Company key used only for stratification bucketing. */
export function companyKey(job) {
  return String(job?.company || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ') || '(unknown)';
}

/**
 * Round-robin over companies: take up to `perCompany` jobs from each company in
 * turn, repeating, until the field budget is spent. A company with 2'000
 * candidates and one with 3 contribute at the same rate per pass, which is the
 * whole point — see the header.
 */
export function stratifyByCompany(candidates, { maxFields, perCompany = 1, budgetOf }) {
  const buckets = new Map();
  for (const c of candidates) {
    const key = companyKey(c.job);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }
  // Stable order: biggest bucket first so the heavy hitters are represented,
  // but each still yields only `perCompany` per pass.
  const keys = [...buckets.keys()].sort((a, b) => {
    const d = buckets.get(b).length - buckets.get(a).length;
    return d !== 0 ? d : a.localeCompare(b);
  });
  const cursor = new Map(keys.map((k) => [k, 0]));
  const picked = [];
  let fields = 0;
  let progress = true;
  while (progress && fields < maxFields) {
    progress = false;
    for (const key of keys) {
      if (fields >= maxFields) break;
      const list = buckets.get(key);
      for (let n = 0; n < perCompany; n++) {
        const i = cursor.get(key);
        if (i >= list.length) break;
        cursor.set(key, i + 1);
        progress = true;
        picked.push(list[i]);
        fields += budgetOf(list[i]);
        if (fields >= maxFields) break;
      }
    }
  }
  return { picked, companies: buckets.size, fields };
}

/**
 * The CONTROL arm. A systematic (every-kth) walk of the candidate list, which
 * keeps each company's share of the sample equal to its share of the queue.
 * Without it the stratified number cannot be reconciled with the production
 * baseline, because production is not stratified: it is dominated by whichever
 * companies have the most candidates.
 */
export function sampleProportional(candidates, { maxFields, budgetOf }) {
  const total = candidates.reduce((n, c) => n + budgetOf(c), 0);
  const step = Math.max(1, Math.floor(total / Math.max(1, maxFields)));
  const picked = [];
  let fields = 0;
  for (let i = 0; i < candidates.length && fields < maxFields; i += step) {
    picked.push(candidates[i]);
    fields += budgetOf(candidates[i]);
  }
  return { picked, companies: new Set(candidates.map((c) => companyKey(c.job))).size, fields };
}

/**
 * Classify the evidence returned by the real detector without copying its
 * predicate. `titleLooksUntranslated()` already selected the evidence; this
 * helper only names the alternative/variant for the report.
 */
export function classifyBinnenVariant(evidence) {
  const value = String(evidence || '').trim();
  const slash = value.match(/\/-?in(?:nen)?\b/i);
  if (slash) {
    return {
      alternative: 'slash-in',
      variant: slash[0].startsWith('/-') ? 'slash-hyphen-in' : 'slash-in',
    };
  }

  const separator = value.match(/([:*_])\s*(in(?:nen)?)\b/i);
  if (separator) {
    const names = { ':': 'colon', '*': 'asterisk', '_': 'underscore' };
    const suffix = separator[2].toLowerCase();
    return {
      alternative: 'separator-in',
      variant: `${names[separator[1]]}-${suffix}`,
    };
  }

  if (/[ :*_]\s*r\b/i.test(value)) {
    return { alternative: 'gender-r', variant: 'gender-r' };
  }
  if (value.includes(':')) {
    return { alternative: 'colon-suffix', variant: 'colon-suffix' };
  }
  return { alternative: 'unknown', variant: 'unknown' };
}

/**
 * Research-only source normalization. It deliberately covers only the two
 * explicit `...in` detector families. The detector's third `word:word`
 * alternative is a distinct class (often a translated suffix such as
 * `:mann`) and is reported, not guessed away. GENDER_R_RE and GENDER_CODE_RE
 * are also distinct and remain byte-identical here; trigraphs are still
 * handled later by the shared `buildMopupRequest` masking.
 */
export function normalizeBinnenISource(text) {
  return String(text ?? '')
    .replace(/\b(\p{L}{3,})[:*_] ?in(?:nen)?\b/giu, '$1')
    .replace(/\b(\p{L}{4,})\/-?in\b/giu, '$1');
}

/**
 * The normalized arm must use the real write classifier and its final
 * rollout guard. `langAwareOverwrite: true` is an audit-only eligibility check:
 * production is not changed or enabled by this one-shot tool.
 */
export function classifyNormalizationArm({
  job,
  locale,
  field,
  rawText,
  protectedTokens = [],
}) {
  const result = classifyMopupWrite({ job, locale, field, rawText, protectedTokens });
  return {
    ...result,
    wouldApply: shouldApplyMopupWrite({
      decision: result.decision,
      languageDriven: result.languageDriven,
      langAwareOverwrite: true,
    }),
  };
}

function jobWithSourceText(job, field, sourceText) {
  const srcLang = job.sourceLang || 'it';
  const bag = field === 'title' ? 'titleByLocale' : 'descriptionByLocale';
  return {
    ...job,
    [field]: sourceText,
    [bag]: { ...(job[bag] || {}), [srcLang]: sourceText },
  };
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

/** Run the production Argos worker once, retaining only its JSONL responses. */
function runArgosBatch(python, requests) {
  const started = Date.now();
  const proc = spawnSync(python, [PY_SCRIPT], {
    input: requests.map((r) => JSON.stringify(r)).join('\n') + '\n',
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (proc.error) throw new Error(`python worker: ${proc.error.message}`);

  const raws = new Map();
  let failed = 0;
  for (const line of (proc.stdout || '').split('\n')) {
    const value = line.trim();
    if (!value) continue;
    let result;
    try { result = JSON.parse(value); } catch { continue; }
    if (result?.id && typeof result.text === 'string' && result.text.trim()) raws.set(result.id, result.text);
    else failed++;
  }
  return { raws, failed, elapsedMs: Date.now() - started };
}

function alternativeForVariant(variant) {
  if (variant === 'colon-suffix') return 'colon-suffix';
  if (variant === 'gender-r') return 'gender-r';
  if (variant === 'unknown') return 'unknown';
  if (variant.startsWith('slash-')) return 'slash-in';
  return 'separator-in';
}

function normalizationRows(cases, productionCounts) {
  const productionTotal = [...productionCounts.values()].reduce((sum, count) => sum + count, 0);
  const rows = new Map(BINNEN_VARIANT_ORDER.map((variant) => [variant, {
    variant,
    alternative: alternativeForVariant(variant),
    productionCount: productionCounts.get(variant) || 0,
    total: 0,
    changed: 0,
    writes: 0,
  }]));
  for (const record of cases) {
    const row = rows.get(record.normalizationVariant) || rows.get('unknown');
    row.total++;
    if (record.normalizationChanged) row.changed++;
    if (record.normalizedDecision === 'write') row.writes++;
  }
  return [...rows.values()].map((row) => ({
    ...row,
    sampleRate: row.total > 0 ? row.writes / row.total : null,
    productionShare: productionTotal > 0 ? row.productionCount / productionTotal : 0,
  }));
}

function productionWeightedNormalizationRate(rows) {
  const covered = rows.filter((row) => row.productionCount > 0 && row.total > 0);
  const coveredSlots = covered.reduce((sum, row) => sum + row.productionCount, 0);
  const totalSlots = rows.reduce((sum, row) => sum + row.productionCount, 0);
  if (coveredSlots <= 0) return { rate: null, coveredSlots, totalSlots };
  const weightedWrites = covered.reduce((sum, row) => sum + row.productionCount * row.sampleRate, 0);
  return { rate: weightedWrites / coveredSlots, coveredSlots, totalSlots };
}

function rejectionCause(result) {
  if (result?.reason && result.reason !== 'ok') return result.reason;
  if (result?.decision === 'skip:source-copy') return 'source-copy';
  return String(result?.decision || 'unknown').replace(/^skip:/, '');
}

function percent(value, total) {
  return total > 0 ? `${(100 * value / total).toFixed(1)}%` : 'n/a';
}

function wilson95(successes, total) {
  if (total <= 0) return null;
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return [
    Math.max(0, (centre - spread) / denominator),
    Math.min(1, (centre + spread) / denominator),
  ];
}

function summarizeDecisions(cases, decisionKey) {
  const summary = Object.fromEntries(DECISIONS.map((decision) => [decision, 0]));
  for (const c of cases) {
    const decision = c[decisionKey];
    if (decision) summary[decision] = (summary[decision] || 0) + 1;
  }
  return summary;
}

function breakdown(cases, key) {
  const rows = new Map();
  for (const c of cases) {
    const value = c[key] || 'unknown';
    if (!rows.has(value)) rows.set(value, { total: 0, opusWrites: 0 });
    const row = rows.get(value);
    row.total++;
    if (c.opusDecision === 'write') row.opusWrites++;
  }
  return [...rows.entries()]
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
    .map(([value, counts]) => ({
      value,
      ...counts,
      recoveryRate: counts.total > 0 ? counts.opusWrites / counts.total : 0,
    }));
}

function markdownTable(headers, rows) {
  const divider = headers.map(() => '---');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${divider.join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function renderMarkdown(report) {
  const rejectedCases = report.cases.filter((c) => c.argosDecision !== 'write');
  const opusSummary = report.opusSummary;
  const recovered = report.recoveredOpusWrites;
  const recoveryRate = report.recoveryRate;
  const ci = report.recoveryCi95;
  const productionOpusMs = report.estimatedOpusMs;
  const normalization = report.normalization;
  const productionArgosMs = (PRODUCTION_ARGOS_SECONDS * 1000 / PRODUCTION_ARGOS_REQUESTS)
    * PRODUCTION_SLOT_ESTIMATE;
  const argosDecisionRows = Object.entries(report.decisionMatrix).map(([argosDecision, columns]) => [
    argosDecision,
    ...DECISIONS.map((decision) => String(columns[decision] || 0)),
    String(Object.values(columns).reduce((sum, n) => sum + n, 0)),
  ]);
  const causeRows = REQUESTED_CAUSES.map((cause) => report.byCause.find((row) => row.value === cause)
    || { value: cause, total: 0, opusWrites: 0, recoveryRate: 0 });
  const otherCauseRows = report.byCause.filter((row) => !REQUESTED_CAUSES.includes(row.value));
  const sampleDate = report.generatedAt.slice(0, 10);
  const verdict = report.verdict;

  return `# Argos vs OpusMT + normalizzazione sorgente — misura ${sampleDate}

## 1. Campione

- Strategia: \`${report.strategy}\`, round-robin per azienda, \`per-company=${report.perCompany}\`.
- Dimensione: **${report.requests} slot** in ${report.sampledJobs} job, ${report.sampledCompanies} aziende coperte; ${report.argosOk} output Argos validi e ${report.argosFailed} fallimenti di chiamata esclusi dal confronto.
- Seed: **nessuno** — campionamento deterministico; ordine dei file da \`listSliceFileNames\`, aziende ordinate per bucket e nome.
- Corpus: snapshot \`origin/main\` estratto con \`git archive\` in una directory temporanea; nessuna scrittura in \`data/\`.

Il braccio OpusMT è stato eseguito solo sui **${rejectedCases.length}** slot in cui Argos ha prodotto un output ma la decisione del guard non era \`write\`. Il confronto usa la stessa richiesta già costruita da \`buildMopupRequest\`, gli stessi token protetti e la stessa \`classifyMopupWrite\`/finalizzazione.

Il braccio di normalizzazione è stato eseguito solo sui **${normalization.calls}** rifiuti Argos con causa \`binnen-i\`; la causa è la decisione del detector sul candidato Argos, non una ricerca testuale parallela. Il sorgente è stato normalizzato prima di ricostruire la richiesta con \`buildMopupRequest\`; masking, finalizzazione e write guard restano quelli condivisi.

## 2. Matrice Argos × OpusMT

Base della matrice: ${rejectedCases.length} rifiuti Argos confrontabili.

${markdownTable(
  ['Decisione Argos', ...DECISIONS.map((d) => `OpusMT: ${d}`), 'Totale'],
  argosDecisionRows,
)}

## 3. Numero che conta

OpusMT risolve **${recovered}/${rejectedCases.length}** slot che Argos non risolve, cioè **${(100 * recoveryRate).toFixed(1)}%** (intervallo Wilson 95%: **${ci ? `${(100 * ci[0]).toFixed(1)}%–${(100 * ci[1]).toFixed(1)}%` : 'n/a'}**; N=${rejectedCases.length}).

Distribuzione delle decisioni OpusMT sul braccio rifiutato:

${markdownTable(
  ['Decisione OpusMT', 'N', '%'],
  DECISIONS.map((decision) => [decision, String(opusSummary[decision] || 0), percent(opusSummary[decision] || 0, rejectedCases.length)]),
)}

## 4. Spaccato per causa e direzione

### Causa di scarto Argos

${markdownTable(
  ['Causa Argos', 'N rifiuti', 'OpusMT write', 'Recupero'],
  [...causeRows, ...otherCauseRows].map((row) => [row.value, String(row.total), String(row.opusWrites), `${(100 * row.recoveryRate).toFixed(1)}%`]),
)}

### Direzione linguistica

${markdownTable(
  ['Direzione', 'N rifiuti', 'OpusMT write', 'Recupero'],
  report.byDirection.map((row) => [row.value, String(row.total), String(row.opusWrites), `${(100 * row.recoveryRate).toFixed(1)}%`]),
)}

### Braccio normalizzazione del sorgente

Il tasso grezzo sul campione è **${normalization.writes}/${normalization.ok} = ${normalization.rate === null ? 'n/a' : `${(100 * normalization.rate).toFixed(1)}%`}** (IC95% Wilson: **${normalization.ci95 ? `${(100 * normalization.ci95[0]).toFixed(1)}%–${(100 * normalization.ci95[1]).toFixed(1)}%` : 'n/a'}**). Nel bucket dei rifiuti Argos pesa **${(100 * normalization.sampleShare).toFixed(1)}%**; la composizione di produzione di riferimento è **${(100 * normalization.productionShare).toFixed(1)}%**, cioè ${normalization.sampleShare > 0 ? `${(normalization.productionShare / normalization.sampleShare).toFixed(1)}×` : 'n/a'} il campione. La scansione del corpus osservato conta ${normalization.corpusDetectorSlots} slot \`binnen-i\` (${normalization.corpusDetectorShare === null ? 'n/a' : `${(100 * normalization.corpusDetectorShare).toFixed(1)}%`} dei ${report.candidateSlots} slot candidati).

Il tasso trasferibile è quello condizionale per variante, ripesato sulla distribuzione del corpus reale: **${normalization.variantWeightedRate === null ? 'n/a' : `${(100 * normalization.variantWeightedRate).toFixed(1)}%`}** su ${normalization.variantWeightedCovered}/${normalization.variantWeightedTotal} slot di composizione osservata. Tradotto nell'intero bucket di produzione, dove \`binnen-i\` pesa il ${(100 * normalization.productionShare).toFixed(1)}%, il contributo atteso è **${normalization.productionContributionRate === null ? 'n/a' : `${(100 * normalization.productionContributionRate).toFixed(1)}%`}**. Il grezzo è descrittivo del campione stratificato; il ripesato è quello trasferibile, con l'assunzione esplicita che il tasso per variante del campione valga sulla composizione reale.

${markdownTable(
  ['Variante detector', 'Alternativa', 'Corpus N', 'Corpus %', 'Campione N', 'Sorgente cambiato', 'write', 'Tasso'],
  normalization.byVariant
    .filter((row) => row.productionCount > 0 || row.total > 0)
    .map((row) => [
      row.variant,
      row.alternative,
      String(row.productionCount),
      `${(100 * row.productionShare).toFixed(1)}%`,
      String(row.total),
      String(row.changed),
      String(row.writes),
      row.sampleRate === null ? 'n/a' : `${(100 * row.sampleRate).toFixed(1)}%`,
    ]),
)}

La normalizzazione research-only tocca soltanto \`:in\`, \`*in\`, \`_in\`, \`/in\` e \`/-in\` (prima e seconda alternativa). La terza alternativa \`word:word\` — inclusi i casi \`:mann\` — non viene trasformata. \`GENDER_R_RE\` e \`GENDER_CODE_RE\` restano distinti e invariati; i gender code passano comunque dal masking condiviso.

## 5. Costo

- Argos in questa misura: ${(report.argosElapsedMs / 1000).toFixed(1)} s / ${report.requests} richieste = ${(report.argosElapsedMs / 1000 / report.requests).toFixed(3)} s/slot.
- Riferimento reale della fase Argos: ${PRODUCTION_ARGOS_SECONDS} s / ${PRODUCTION_ARGOS_REQUESTS} richieste = ${(PRODUCTION_ARGOS_SECONDS / PRODUCTION_ARGOS_REQUESTS).toFixed(3)} s/slot; estrapolazione a ${PRODUCTION_SLOT_ESTIMATE} slot: **${(productionArgosMs / 1000).toFixed(1)} s (${(productionArgosMs / 60000).toFixed(1)} min)**.
- OpusMT: ${(report.opusElapsedMs / 1000).toFixed(1)} s / ${report.opusCalls} slot rifiutati = ${report.opusCalls > 0 ? (report.opusElapsedMs / 1000 / report.opusCalls).toFixed(3) : 'n/a'} s/slot; dtype \`${report.opusDtype}\`, inclusa la prima inizializzazione/caricamento dei modelli nel processo.
- Estrapolazione lineare OpusMT a ${PRODUCTION_SLOT_ESTIMATE} slot: **${productionOpusMs === null ? 'n/a' : `${(productionOpusMs / 1000).toFixed(1)} s (${(productionOpusMs / 60000).toFixed(1)} min)`}** contro budget \`${MOPUP_DEADLINE_MS} ms\` = ${(MOPUP_DEADLINE_MS / 60000).toFixed(1)} min.
- Normalizzazione + Argos: ${(normalization.elapsedMs / 1000).toFixed(1)} s / ${normalization.calls} slot tentati = ${normalization.calls > 0 ? (normalization.elapsedMs / 1000 / normalization.calls).toFixed(3) : 'n/a'} s/slot; ${normalization.failed} fallimenti di chiamata. Estrapolazione a ${normalization.productionSlots} slot \`binnen-i\` per run: **${normalization.estimatedMs === null ? 'n/a' : `${(normalization.estimatedMs / 1000).toFixed(1)} s (${(normalization.estimatedMs / 60000).toFixed(1)} min)`}**.

## 6. Verdetto

**${verdict.label}** — soglia dichiarata: cambio giustificato solo se OpusMT recupera almeno **${(100 * MIN_OPUS_RECOVERY_RATE).toFixed(0)}%** dei rifiuti Argos **e** la stima sui ${PRODUCTION_SLOT_ESTIMATE} slot resta entro il budget di ${(MOPUP_DEADLINE_MS / 60000).toFixed(1)} min. Risultato misurato: ${recovered}/${rejectedCases.length} = ${(100 * recoveryRate).toFixed(1)}%; tempo stimato ${productionOpusMs === null ? 'n/a' : `${(productionOpusMs / 60000).toFixed(1)} min`}. **${verdict.reason}**
`;
}

async function generate() {
  const slicesDir = path.resolve(opt('--slices-dir', path.join(ROOT, 'data', 'jobs', 'by-crawler')));
  const maxFields = Number(opt('--max-fields', 300));
  const perCompany = Number(opt('--per-company', 1));
  const fieldFilter = opt('--fields', 'both');
  const python = opt('--python', process.env.LOCAL_MT_PYTHON || 'python3');
  const strategy = opt('--strategy', 'stratified');
  const outPath = path.resolve(opt('--out', path.join(os.tmpdir(), 'argos-reject-audit.json')));
  const markdownOut = opt('--markdown-out', '');

  if (!fs.existsSync(slicesDir)) {
    console.error(`❌ slices dir not found: ${slicesDir}`);
    process.exit(1);
  }
  if (!localOpusMtEnabled()) {
    console.error('❌ OpusMT arm disabled: set MT_LOCAL_OPUSMT=1 for this measurement');
    process.exit(1);
  }

  // 1. Candidates — the production predicate, imported, not restated.
  const candidates = [];
  const productionBinnenVariantCounts = new Map();
  let productionSlots = 0;
  let scanned = 0;
  for (const file of listSliceFileNames(slicesDir)) {
    const data = readJson(path.join(slicesDir, file));
    if (!data || !Array.isArray(data.jobs)) continue;
    for (const job of data.jobs) {
      scanned++;
      if (!needsWork(job)) continue;
      let slots = missingSlots(job);
      if (fieldFilter !== 'both') slots = slots.filter((s) => s.field === fieldFilter);
      if (slots.length === 0) continue;
      productionSlots += slots.length;
      const srcLang = job.sourceLang || 'it';
      const sourceTitle = (job.title || job.titleByLocale?.[srcLang] || '').trim();
      for (const slot of slots) {
        if (slot.field !== 'title') continue;
        const existing = String(job.titleByLocale?.[slot.locale] || '').trim();
        const detector = titleLooksUntranslated({
          title: existing,
          sourceTitle,
          sourceLang: srcLang,
          targetLocale: slot.locale,
          company: job.company || '',
          location: job.location || '',
        });
        if (detector.reason !== 'binnen-i') continue;
        const variant = classifyBinnenVariant(detector.evidence).variant;
        productionBinnenVariantCounts.set(
          variant,
          (productionBinnenVariantCounts.get(variant) || 0) + 1,
        );
      }
      candidates.push({ file, job, slots });
    }
  }
  console.log(`🔍 scanned ${scanned} jobs · ${candidates.length} candidates · ${new Set(candidates.map((c) => companyKey(c.job))).size} companies`);

  // 2. Sample. Stratified is the measurement; proportional is the control that
  //    reproduces production's own company mix.
  const budgetOf = (c) => c.slots.length;
  const { picked, companies, fields } = strategy === 'proportional'
    ? sampleProportional(candidates, { maxFields, budgetOf })
    : stratifyByCompany(candidates, { maxFields, perCompany, budgetOf });
  console.log(`🎯 ${strategy} pick: ${picked.length} jobs from ${new Set(picked.map((p) => companyKey(p.job))).size}/${companies} companies · ~${fields} fields`);

  // 3. Build the batch exactly as the mop-up does (same masking).
  const requests = [];
  const targets = new Map();
  let nextId = 0;
  for (const { file, job, slots } of picked) {
    const srcLang = job.sourceLang || 'it';
    const sourceTitle = (job.title || job.titleByLocale?.[srcLang] || '').trim();
    const sourceDesc = (job.description || job.descriptionByLocale?.[srcLang] || '').trim();
    for (const { locale, field } of slots) {
      const text = field === 'title' ? sourceTitle : sourceDesc;
      if (!text) continue;
      const id = `r${nextId++}`;
      const { request, protectedTokens } = buildMopupRequest({ id, text, from: srcLang, to: locale, field });
      requests.push(request);
      targets.set(id, { file, job, locale, field, request, protectedTokens, sourceText: text });
    }
  }
  console.log(`🐍 ${requests.length} requests → ${python} ${path.relative(ROOT, PY_SCRIPT)}`);

  // 4. The real engine, same protocol as production.
  let argosRun;
  try {
    argosRun = runArgosBatch(python, requests);
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
  const { raws, failed: argosFailed, elapsedMs: argosElapsedMs } = argosRun;
  console.log(`   ${raws.size} argos ok · ${argosFailed} argos failed · ${Math.round(argosElapsedMs / 1000)}s`);

  // 5. Replay the REAL rejection chain. The OpusMT arm is deliberately only
  // run for Argos refusals: a successful Argos write is not part of the question.
  const cases = [];
  const normalizationRequests = [];
  const normalizationTargets = new Map();
  const opusStarted = Date.now();
  let opusCalls = 0;
  let opusElapsedMs = 0;
  for (const [id, tgt] of targets) {
    const raw = raws.get(id);
    if (raw === undefined) continue; // call failure, not a refusal — out of scope
    const { job, locale, field, request, protectedTokens, sourceText } = tgt;
    const argos = classifyMopupWrite({
      job, locale, field, rawText: raw, protectedTokens,
    });
    // Why the slot was queued at all — separates the entry gate
    // (titleLooksUntranslated, present-but-lexically-untranslated) from the
    // plain missing/copy case, because the two hit different exit guards.
    const srcLang = job.sourceLang || 'it';
    const entryVerdict = field === 'title' && argos.existing
      ? titleLooksUntranslated({
          title: argos.existing,
          sourceTitle: sourceText,
          sourceLang: srcLang,
          targetLocale: locale,
          company: job.company || '',
          location: job.location || '',
        })
      : null;
    const entry = entryVerdict?.untranslated ? 'titleLooksUntranslated' : 'missing-or-copy';
    const candidateVerdict = field === 'title' && argos.incoming
      ? titleLooksUntranslated({
          title: argos.incoming,
          sourceTitle: argos.normalizedSourceText,
          sourceLang: srcLang,
          targetLocale: locale,
          company: job.company || '',
          location: job.location || '',
        })
      : null;
    const argosCause = rejectionCause(argos);
    const record = {
      id,
      company: companyKey(job),
      slug: job.slug || job.url || '',
      sourceLang: srcLang,
      locale,
      direction: `${srcLang}->${locale}`,
      field,
      entryReason: entry,
      entryDetectorReason: entryVerdict?.reason || null,
      entryDetectorEvidence: entryVerdict?.evidence || null,
      sourceText,
      argosRaw: raw,
      finalized: argos.incoming,
      existing: argos.existing,
      decision: argos.decision,
      argosDecision: argos.decision,
      argosReason: rejectionCause(argos),
      argosCause,
      argosEvidence: candidateVerdict?.evidence || null,
      opusRaw: null,
      opusFinalized: null,
      opusDecision: null,
      opusReason: null,
      opusCause: null,
      opusElapsedMs: null,
      normalizedSourceText: null,
      normalizationVariant: null,
      normalizationAlternative: null,
      normalizationChanged: null,
      normalizedRaw: null,
      normalizedFinalized: null,
      normalizedDecision: null,
      normalizedReason: null,
      normalizedCause: null,
      normalizedWouldApply: null,
    };
    if (argos.decision !== 'write') {
      opusCalls++;
      const opusCallStarted = Date.now();
      const opusRaw = await translateWithLocalOpusMt(request.text, request.from, request.to);
      const opusCallElapsedMs = Date.now() - opusCallStarted;
      opusElapsedMs += opusCallElapsedMs;
      const opus = classifyMopupWrite({
        job,
        locale,
        field,
        rawText: opusRaw,
        protectedTokens,
      });
      record.opusRaw = opusRaw;
      record.opusFinalized = opus.incoming;
      record.opusDecision = opus.decision;
      record.opusReason = rejectionCause(opus);
      record.opusCause = rejectionCause(opus);
      record.opusElapsedMs = opusCallElapsedMs;
      if (opusCalls % 25 === 0) {
        console.log(`   OpusMT ${opusCalls} rejected slots · ${Math.round((Date.now() - opusStarted) / 1000)}s`);
      }
    }
    if (argosCause === 'binnen-i') {
      const variant = classifyBinnenVariant(candidateVerdict?.evidence).variant;
      const normalizedSourceText = normalizeBinnenISource(sourceText);
      const normalizedId = `n${id}`;
      const normalizedRequest = buildMopupRequest({
        id: normalizedId,
        text: normalizedSourceText,
        from: srcLang,
        to: locale,
        field,
      });
      normalizationRequests.push(normalizedRequest.request);
      normalizationTargets.set(normalizedId, {
        record,
        job: jobWithSourceText(job, field, normalizedSourceText),
        locale,
        field,
        protectedTokens: normalizedRequest.protectedTokens,
      });
      record.normalizedSourceText = normalizedSourceText;
      record.normalizationVariant = variant;
      record.normalizationAlternative = classifyBinnenVariant(candidateVerdict?.evidence).alternative;
      record.normalizationChanged = normalizedSourceText !== sourceText;
    }
    cases.push(record);
  }

  // 6. The third arm uses the SAME Argos worker and the SAME request masking.
  // `buildMopupRequest` owns maskProtectedTokens; classifyNormalizationArm
  // delegates finalization to classifyMopupWrite (which owns
  // finalizeMopupTranslation) and checks shouldApplyMopupWrite. Only the input
  // source differs from the first arm.
  let normalizationRun = { raws: new Map(), failed: 0, elapsedMs: 0 };
  if (normalizationRequests.length > 0) {
    try {
      normalizationRun = runArgosBatch(python, normalizationRequests);
    } catch (error) {
      console.error(`❌ ${error.message}`);
      process.exit(1);
    }
    for (const [id, target] of normalizationTargets) {
      const raw = normalizationRun.raws.get(id);
      if (raw === undefined) continue;
      const normalized = classifyNormalizationArm({
        job: target.job,
        locale: target.locale,
        field: target.field,
        rawText: raw,
        protectedTokens: target.protectedTokens,
      });
      target.record.normalizedRaw = raw;
      target.record.normalizedFinalized = normalized.incoming;
      target.record.normalizedDecision = normalized.decision;
      target.record.normalizedReason = rejectionCause(normalized);
      target.record.normalizedCause = rejectionCause(normalized);
      target.record.normalizedWouldApply = normalized.wouldApply;
    }
    console.log(`   normalized Argos ${normalizationRun.raws.size} ok · ${normalizationRun.failed} failed · ${Math.round(normalizationRun.elapsedMs / 1000)}s`);
  }

  const summary = {};
  for (const c of cases) {
    const k = c.decision;
    summary[k] = summary[k] || { total: 0, byLocale: {}, byField: {}, byEntry: {} };
    summary[k].total++;
    summary[k].byLocale[c.locale] = (summary[k].byLocale[c.locale] || 0) + 1;
    summary[k].byField[c.field] = (summary[k].byField[c.field] || 0) + 1;
    summary[k].byEntry[c.entryReason] = (summary[k].byEntry[c.entryReason] || 0) + 1;
  }

  const rejectedCases = cases.filter((c) => c.argosDecision !== 'write');
  const normalizedCases = cases.filter((c) => c.normalizedDecision !== null);
  const normalizationWrites = normalizedCases.filter((c) => c.normalizedDecision === 'write').length;
  const normalizationRate = normalizedCases.length > 0
    ? normalizationWrites / normalizedCases.length
    : null;
  const normalizationCi95 = normalizedCases.length > 0
    ? wilson95(normalizationWrites, normalizedCases.length)
    : null;
  const productionBinnenISlots = [...productionBinnenVariantCounts.values()]
    .reduce((sum, count) => sum + count, 0);
  const normalizationByVariant = normalizationRows(
    normalizedCases,
    productionBinnenVariantCounts,
  );
  const weightedNormalization = productionWeightedNormalizationRate(normalizationByVariant);
  const normalizationProductionSlots = PRODUCTION_BINNEN_I_SLOTS;
  const normalizationFailed = normalizationRequests.length - normalizationRun.raws.size;
  const normalizationSampleShare = rejectedCases.length > 0
    ? normalizedCases.length / rejectedCases.length
    : 0;
  const normalization = {
    calls: normalizationRequests.length,
    ok: normalizedCases.length,
    failed: Math.max(0, normalizationFailed),
    elapsedMs: normalizationRun.elapsedMs,
    writes: normalizationWrites,
    rate: normalizationRate,
    ci95: normalizationCi95,
    sampleShare: normalizationSampleShare,
    productionShare: PRODUCTION_BINNEN_I_SHARE,
    corpusDetectorSlots: productionBinnenISlots,
    corpusDetectorShare: productionSlots > 0 ? productionBinnenISlots / productionSlots : null,
    byVariant: normalizationByVariant,
    variantWeightedRate: weightedNormalization.rate,
    variantWeightedCovered: weightedNormalization.coveredSlots,
    variantWeightedTotal: weightedNormalization.totalSlots,
    productionContributionRate: weightedNormalization.rate === null
      ? null
      : weightedNormalization.rate * PRODUCTION_BINNEN_I_SHARE,
    productionSlots: normalizationProductionSlots,
    estimatedMs: normalizationRun.raws.size > 0
      ? (normalizationRun.elapsedMs / normalizationRun.raws.size) * normalizationProductionSlots
      : null,
  };
  const opusSummary = summarizeDecisions(rejectedCases, 'opusDecision');
  const decisionMatrix = Object.fromEntries(
    DECISIONS.filter((decision) => decision !== 'write').map((decision) => [
      decision,
      Object.fromEntries(DECISIONS.map((opusDecision) => [opusDecision, 0])),
    ]),
  );
  for (const c of rejectedCases) {
    if (decisionMatrix[c.argosDecision]) {
      decisionMatrix[c.argosDecision][c.opusDecision]++;
    }
  }
  const recoveredOpusWrites = rejectedCases.filter((c) => c.opusDecision === 'write').length;
  const recoveryRate = rejectedCases.length > 0 ? recoveredOpusWrites / rejectedCases.length : 0;
  const ci = wilson95(recoveredOpusWrites, rejectedCases.length);
  const estimatedOpusMs = opusCalls > 0
    ? (opusElapsedMs / opusCalls) * PRODUCTION_SLOT_ESTIMATE
    : null;
  const meetsRecoveryThreshold = recoveryRate >= MIN_OPUS_RECOVERY_RATE;
  const meetsTimeThreshold = estimatedOpusMs !== null && estimatedOpusMs <= MOPUP_DEADLINE_MS;
  const verdict = meetsRecoveryThreshold && meetsTimeThreshold
    ? {
        label: 'SÌ',
        reason: 'entrambe le condizioni della soglia sono soddisfatte',
      }
    : {
        label: 'NO',
        reason: !meetsRecoveryThreshold
          ? 'il recupero non raggiunge la soglia del 10%'
          : 'la stima di tempo supera il budget del mop-up',
      };

  const report = {
    generatedAt: new Date().toISOString(),
    slicesDir,
    strategy,
    perCompany,
    sampleSeed: 'none: deterministic',
    scannedJobs: scanned,
    candidateJobs: candidates.length,
    candidateSlots: productionSlots,
    candidateCompanies: companies,
    sampledJobs: picked.length,
    sampledCompanies: new Set(picked.map((p) => companyKey(p.job))).size,
    requests: requests.length,
    argosOk: raws.size,
    argosFailed,
    argosElapsedMs,
    summary,
    cases,
    opusCalls,
    opusElapsedMs,
    opusDtype: (process.env.MT_LOCAL_OPUSMT_DTYPE || 'q8').trim(),
    opusSummary,
    opusDecisionSummary: opusSummary,
    decisionMatrix,
    recoveredOpusWrites,
    recoveryRate,
    recoveryCi95: ci,
    normalization,
    byCause: breakdown(rejectedCases, 'argosCause'),
    byDirection: breakdown(rejectedCases, 'direction'),
    estimatedOpusMs,
    verdict,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log(`\n📈 decisions:`);
  for (const [k, v] of Object.entries(summary).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`   ${String(k).padEnd(22)} ${String(v.total).padStart(5)}  ${(100 * v.total / cases.length).toFixed(1)}%  ${JSON.stringify(v.byLocale)}`);
  }
  console.log(`   OpusMT write on Argos rejects: ${recoveredOpusWrites}/${rejectedCases.length} (${(100 * recoveryRate).toFixed(1)}%) · ${verdict.label}`);
  if (markdownOut) {
    const mdPath = path.resolve(markdownOut);
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, renderMarkdown(report), 'utf-8');
    console.log(`\n📄 ${mdPath}`);
  }
  console.log(`\n📄 ${outPath}`);
}

const JUDGE_PROMPT = `You are auditing a machine-translation quality gate for a Swiss cross-border job board.
For each numbered case you get: the SOURCE text and its language, the TARGET language, the RAW output of Argos Translate, the text after the pipeline's finalize transform, the text ALREADY stored for that language (may be empty), and the guard that rejected the candidate.
Judge ONLY whether discarding the candidate was right, i.e. whether the finalized candidate would have been an acceptable job-board translation into the target language AND better than what is already stored.
Answer with one JSON object per line, no prose, no markdown fence:
{"n":<case number>,"verdict":"correct-rejection"|"acceptable-translation"|"doubtful","why":"<one short sentence>"}
"acceptable-translation" means the gate threw away something usable. "doubtful" means you genuinely cannot tell.`;

function judge() {
  const reportPath = path.resolve(opt('--judge'));
  const limit = Number(opt('--judge-limit', 150));
  const report = readJson(reportPath);
  if (!report) { console.error(`❌ cannot read ${reportPath}`); process.exit(1); }

  const rejects = report.cases.filter((c) => c.decision !== 'write');
  // Even coverage across guards: round-robin so a dominant guard cannot eat the
  // whole judging budget and leave the others unmeasurable.
  const byGuard = new Map();
  for (const c of rejects) {
    if (!byGuard.has(c.decision)) byGuard.set(c.decision, []);
    byGuard.get(c.decision).push(c);
  }
  const chosen = [];
  for (let i = 0; chosen.length < Math.min(limit, rejects.length); i++) {
    let moved = false;
    for (const list of byGuard.values()) {
      if (i < list.length && chosen.length < limit) { chosen.push(list[i]); moved = true; }
    }
    if (!moved) break;
  }

  const clip = (s, n) => (String(s || '').length > n ? String(s).slice(0, n) + ' […]' : String(s || ''));
  const body = chosen.map((c, i) => [
    `--- case ${i + 1} (guard: ${c.decision}, ${c.sourceLang}->${c.locale}, field: ${c.field}) ---`,
    `SOURCE: ${clip(c.sourceText, 700)}`,
    `ARGOS RAW: ${clip(c.argosRaw, 700)}`,
    `AFTER FINALIZE: ${clip(c.finalized, 700) || '(empty)'}`,
    `ALREADY STORED: ${clip(c.existing, 700) || '(nothing)'}`,
  ].join('\n')).join('\n\n');

  const proc = spawnSync('claude', ['-p', '--output-format', 'text'], {
    input: `${JUDGE_PROMPT}\n\n${body}\n`,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (proc.error || proc.status !== 0) {
    console.error(`❌ claude -p failed: ${proc.error?.message || `status ${proc.status}`}`);
    process.exit(1);
  }

  const verdicts = new Map();
  for (const line of (proc.stdout || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const v = JSON.parse(t);
      if (v && Number.isInteger(v.n)) verdicts.set(v.n, v);
    } catch { /* skip non-JSON chatter */ }
  }

  const tally = {};
  for (let i = 0; i < chosen.length; i++) {
    const v = verdicts.get(i + 1);
    if (!v) continue;
    chosen[i].verdict = v.verdict;
    chosen[i].verdictWhy = v.why;
    const guard = chosen[i].decision;
    const loc = chosen[i].locale;
    tally[guard] = tally[guard] || { judged: 0, byVerdict: {}, byLocale: {} };
    tally[guard].judged++;
    tally[guard].byVerdict[v.verdict] = (tally[guard].byVerdict[v.verdict] || 0) + 1;
    tally[guard].byLocale[loc] = tally[guard].byLocale[loc] || {};
    tally[guard].byLocale[loc][v.verdict] = (tally[guard].byLocale[loc][v.verdict] || 0) + 1;
  }

  report.judgement = { judgedAt: new Date().toISOString(), judged: verdicts.size, requested: chosen.length, tally };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log(`\n⚖️  judged ${verdicts.size}/${chosen.length}`);
  for (const [guard, t] of Object.entries(tally)) {
    const wrong = t.byVerdict['acceptable-translation'] || 0;
    console.log(`   ${guard.padEnd(22)} ${String(t.judged).padStart(4)} judged · false rejects ${wrong} (${(100 * wrong / t.judged).toFixed(1)}%) · ${JSON.stringify(t.byVerdict)}`);
  }
  console.log(`\n📄 ${reportPath}`);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) {
  if (opt('--judge')) judge();
  else generate().catch((error) => {
    console.error(`❌ audit failed: ${error?.stack || error}`);
    process.exit(1);
  });
}
