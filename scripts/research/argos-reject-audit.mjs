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

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
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

  return `# Argos vs OpusMT — misura ${sampleDate}

## 1. Campione

- Strategia: \`${report.strategy}\`, round-robin per azienda, \`per-company=${report.perCompany}\`.
- Dimensione: **${report.requests} slot** in ${report.sampledJobs} job, ${report.sampledCompanies} aziende coperte; ${report.argosOk} output Argos validi e ${report.argosFailed} fallimenti di chiamata esclusi dal confronto.
- Seed: **nessuno** — campionamento deterministico; ordine dei file da \`listSliceFileNames\`, aziende ordinate per bucket e nome.
- Corpus: snapshot \`origin/main\` estratto con \`git archive\` in una directory temporanea; nessuna scrittura in \`data/\`.

Il braccio OpusMT è stato eseguito solo sui **${rejectedCases.length}** slot in cui Argos ha prodotto un output ma la decisione del guard non era \`write\`. Il confronto usa la stessa richiesta già costruita da \`buildMopupRequest\`, gli stessi token protetti e la stessa \`classifyMopupWrite\`/finalizzazione.

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

## 5. Costo

- Argos in questa misura: ${(report.argosElapsedMs / 1000).toFixed(1)} s / ${report.requests} richieste = ${(report.argosElapsedMs / 1000 / report.requests).toFixed(3)} s/slot.
- Riferimento reale della fase Argos: ${PRODUCTION_ARGOS_SECONDS} s / ${PRODUCTION_ARGOS_REQUESTS} richieste = ${(PRODUCTION_ARGOS_SECONDS / PRODUCTION_ARGOS_REQUESTS).toFixed(3)} s/slot; estrapolazione a ${PRODUCTION_SLOT_ESTIMATE} slot: **${(productionArgosMs / 1000).toFixed(1)} s (${(productionArgosMs / 60000).toFixed(1)} min)**.
- OpusMT: ${(report.opusElapsedMs / 1000).toFixed(1)} s / ${report.opusCalls} slot rifiutati = ${report.opusCalls > 0 ? (report.opusElapsedMs / 1000 / report.opusCalls).toFixed(3) : 'n/a'} s/slot; dtype \`${report.opusDtype}\`, inclusa la prima inizializzazione/caricamento dei modelli nel processo.
- Estrapolazione lineare OpusMT a ${PRODUCTION_SLOT_ESTIMATE} slot: **${productionOpusMs === null ? 'n/a' : `${(productionOpusMs / 1000).toFixed(1)} s (${(productionOpusMs / 60000).toFixed(1)} min)`}** contro budget \`${MOPUP_DEADLINE_MS} ms\` = ${(MOPUP_DEADLINE_MS / 60000).toFixed(1)} min.

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
  const started = Date.now();
  const proc = spawnSync(python, [PY_SCRIPT], {
    input: requests.map((r) => JSON.stringify(r)).join('\n') + '\n',
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (proc.error) {
    console.error(`❌ python worker: ${proc.error.message}`);
    process.exit(1);
  }
  const raws = new Map();
  let argosFailed = 0;
  for (const line of (proc.stdout || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let res;
    try { res = JSON.parse(t); } catch { continue; }
    if (res?.id && typeof res.text === 'string' && res.text.trim()) raws.set(res.id, res.text);
    else argosFailed++;
  }
  const argosElapsedMs = Date.now() - started;
  console.log(`   ${raws.size} argos ok · ${argosFailed} argos failed · ${Math.round(argosElapsedMs / 1000)}s`);

  // 5. Replay the REAL rejection chain. The OpusMT arm is deliberately only
  // run for Argos refusals: a successful Argos write is not part of the question.
  const cases = [];
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
    const entry = field === 'title' && argos.existing
      ? (titleLooksUntranslated({
          title: argos.existing,
          sourceTitle: sourceText,
          sourceLang: srcLang,
          targetLocale: locale,
          company: job.company || '',
          location: job.location || '',
        }).untranslated ? 'titleLooksUntranslated' : 'missing-or-copy')
      : 'missing-or-copy';
    const record = {
      id,
      company: companyKey(job),
      slug: job.slug || job.url || '',
      sourceLang: srcLang,
      locale,
      direction: `${srcLang}->${locale}`,
      field,
      entryReason: entry,
      sourceText,
      argosRaw: raw,
      finalized: argos.incoming,
      existing: argos.existing,
      decision: argos.decision,
      argosDecision: argos.decision,
      argosReason: rejectionCause(argos),
      argosCause: rejectionCause(argos),
      opusRaw: null,
      opusFinalized: null,
      opusDecision: null,
      opusReason: null,
      opusCause: null,
      opusElapsedMs: null,
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
    cases.push(record);
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
