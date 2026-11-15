#!/usr/bin/env node
/**
 * portal-replay-daily-issue.mjs — corpo della issue del replay giornaliero sui
 * portali (`.github/workflows/assisted-application-portal-replay.yml`).
 *
 * Dal 2026-11-15 il replay non gira più sulle PR: una volta al giorno confronta
 * base e head di `main` su tutte le famiglie e, se il verdetto è rosso, il job
 * `portal-replay-daily-issue` apre (o aggiorna) UNA issue. Questo modulo
 * costruisce soltanto il testo; l'apertura, il commento, la riapertura di una
 * gemella chiusa da poco e la creazione idempotente della label sono del
 * helper condiviso `scripts/lib/github-issue-creator.mjs`.
 *
 * Il corpo parte dal marker `<!-- portal-replay-daily -->` e contiene solo dati
 * già sanitizzati dal CLI del replay (nessun URL completo, contenuto di pagina,
 * risposta del candidato o screenshot): link alla run, base..head, famiglie in
 * errore con i codici di rilievo, data.
 *
 * Usage:
 *   node scripts/ci/portal-replay-daily-issue.mjs --print-title
 *   node scripts/ci/portal-replay-daily-issue.mjs --gate-json <file> --run-url <url> \
 *     --repo <owner/repo> --base-sha <sha> --head-sha <sha> [--base-source <src>] --out <file>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

/** Titolo stabile, entro i 60 caratteri che l'helper usa per la deduplica. */
export const PORTAL_REPLAY_DAILY_ISSUE_TITLE = 'Portal replay giornaliero: regressione sui portali';
export const PORTAL_REPLAY_DAILY_ISSUE_MARKER = '<!-- portal-replay-daily -->';

const MAX_CASES_PER_FAMILY = 5;
const SAFE_TOKEN_RE = /^[A-Za-z0-9_.:*/-]{1,120}$/u;
const SHA_RE = /^[0-9a-f]{40}$/u;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

const BASE_SOURCE_LABEL = Object.freeze({
  input: 'indicata a mano (`base_sha`)',
  'last-success': 'head dell’ultima run giornaliera riuscita',
  head: 'uguale all’head (autoconfronto: salute dei portali, nessun delta di codice)',
});

// Tutto ciò che arriva dal JSON passa di qui: un valore fuori dall'alfabeto
// sicuro diventa `?` invece di finire nel testo della issue.
function token(value, fallback = '?') {
  const text = String(value ?? '');
  return SAFE_TOKEN_RE.test(text) ? text : fallback;
}

function codeList(values) {
  const items = (Array.isArray(values) ? values : []).map((value) => token(value)).filter(Boolean);
  return items.length ? items.map((item) => `\`${item}\``).join(', ') : '_nessuno_';
}

function shortSha(sha) {
  return SHA_RE.test(String(sha || '')) ? String(sha).slice(0, 12) : '';
}

function rate(value, total) {
  return `${Number(value) || 0}/${Number(total) || 0}`;
}

function commitRange({ repo, baseSha, headSha, baseSource }) {
  const head = shortSha(headSha);
  const base = shortSha(baseSha);
  if (!head) return '- Commit: non disponibili (la risoluzione della base non è arrivata a termine).';
  const source = BASE_SOURCE_LABEL[baseSource] ? ` — base: ${BASE_SOURCE_LABEL[baseSource]}` : '';
  if (!base) return `- Head: \`${head}\`${source}`;
  if (base === head) return `- Base..head: \`${base}\` (stesso commit)${source}`;
  const link = REPO_RE.test(String(repo || '')) ? ` ([confronto](https://github.com/${repo}/compare/${baseSha}...${headSha}))` : '';
  return `- Base..head: \`${base}..${head}\`${link}${source}`;
}

function failingFamilyLines(report) {
  const lines = [];
  const rates = report.familyRates || {};
  lines.push(
    `- **${token(report.family)}** — codici: ${codeList(report.findingCodes)}; `
    + `READY base ${rate(rates.baseReady, rates.comparable)}, head ${rate(rates.headReady, rates.comparable)}.`,
  );
  const failing = (Array.isArray(report.cases) ? report.cases : []).filter((item) => Array.isArray(item?.findingCodes) && item.findingCodes.length);
  for (const item of failing.slice(0, MAX_CASES_PER_FAMILY)) {
    lines.push(
      `  - ${token(item.host)}${token(item.path, '')}: base \`${token(item.base?.stage)}\` → head \`${token(item.head?.stage)}\``
      + ` (stop \`${token(item.head?.stopCode)}\`), codici: ${codeList(item.findingCodes)}`,
    );
  }
  if (failing.length > MAX_CASES_PER_FAMILY) lines.push(`  - … e altri ${failing.length - MAX_CASES_PER_FAMILY} annunci con rilievi (vedi il riepilogo della run).`);
  return lines;
}

/**
 * @param {{ gate?: { verdict?: object, reports?: object[] } | null, runUrl: string, repo?: string,
 *           baseSha?: string, headSha?: string, baseSource?: string, now?: Date }} input
 */
export function buildPortalReplayDailyIssueBody({ gate = null, runUrl, repo = '', baseSha = '', headSha = '', baseSource = '', now = new Date() } = {}) {
  const verdict = gate?.verdict && typeof gate.verdict === 'object' ? gate.verdict : null;
  const reports = Array.isArray(gate?.reports) ? gate.reports : [];
  const date = new Date(now).toISOString().slice(0, 10);
  const lines = [
    PORTAL_REPLAY_DAILY_ISSUE_MARKER,
    '## Replay giornaliero sui portali: verdetto rosso',
    '',
    `- Data: ${date} (UTC)`,
    `- Run: ${/^https:\/\/github\.com\/[^\s]+$/u.test(String(runUrl || '')) ? runUrl : '_non disponibile_'}`,
    commitRange({ repo, baseSha, headSha, baseSource }),
  ];

  if (!verdict) {
    lines.push(
      '- Esito: **FAIL** (`verdict_unavailable`)',
      '',
      'Il verdetto non è leggibile: l’artifact del verdetto manca o è corrotto. Apri la run per il motivo.',
    );
  } else {
    lines.push(`- Esito: **${token(String(verdict.status || 'fail').toUpperCase())}** (\`${token(verdict.code)}\`)`);
    const failed = reports.filter((report) => report?.status !== 'pass');
    const failedNames = new Set(failed.map((report) => token(report.family)));
    const missing = (Array.isArray(verdict.missingFamilies) ? verdict.missingFamilies : []).map((family) => token(family));
    lines.push('', '### Famiglie in errore', '');
    if (failed.length) for (const report of failed) lines.push(...failingFamilyLines(report));
    for (const family of new Set([...(Array.isArray(verdict.failedFamilies) ? verdict.failedFamilies : []).map((value) => token(value))])) {
      if (!failedNames.has(family)) lines.push(`- **${family}** — rapporto non leggibile o famiglia non completata.`);
    }
    if (missing.length) lines.push(`- Senza rapporto (processo terminato, scaduto o mai partito): ${missing.map((family) => `\`${family}\``).join(', ')}.`);
    if (!failed.length && !missing.length && !(verdict.failedFamilies || []).length) {
      lines.push(`- Nessuna famiglia ha prodotto un rilievo: il verdetto è rosso per \`${token(verdict.code)}\` (preparazione, risoluzione della base o matrice non riuscite). Il motivo è nel log della run.`);
    }
  }

  lines.push(
    '',
    '### Come si chiude',
    '',
    'La issue si chiude da sola alla prossima run giornaliera con verdetto verde. '
    + 'Una run già in errore per un portale non ne apre una seconda: questa issue riceve un commento per ogni run rossa. '
    + 'Per rieseguire a mano: `gh workflow run assisted-application-portal-replay.yml` (opzionale `-f base_sha=<sha>`).',
    '',
    'Il rapporto non contiene URL completi, contenuto delle pagine, risposte del candidato o screenshot.',
  );
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      'print-title': { type: 'boolean' },
      'gate-json': { type: 'string' }, 'run-url': { type: 'string' }, repo: { type: 'string' },
      'base-sha': { type: 'string' }, 'head-sha': { type: 'string' }, 'base-source': { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (values['print-title']) {
    process.stdout.write(`${PORTAL_REPLAY_DAILY_ISSUE_TITLE}\n`);
    return 0;
  }
  if (!values.out) throw new Error('--out is required');
  let gate = null;
  try {
    if (values['gate-json']) gate = JSON.parse(readFileSync(values['gate-json'], 'utf8'));
  } catch {
    gate = null;
  }
  const body = buildPortalReplayDailyIssueBody({
    gate,
    runUrl: values['run-url'],
    repo: values.repo,
    baseSha: values['base-sha'],
    headSha: values['head-sha'],
    baseSource: values['base-source'],
  });
  writeFileSync(values.out, body, { mode: 0o600 });
  console.log(`portal replay daily issue body written (${body.length} bytes)`);
  return 0;
}

if (isInvokedDirectly(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) {
    console.error(`portal-replay-daily-issue: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
