#!/usr/bin/env node
/**
 * crawler-quarantine-review.mjs — applica le due uscite della quarantena.
 *
 * Legge le ondate reali del gruppo di quarantena (le run completate di
 * `crawler-group-NN.yml` nel repo che le esegue), decide con
 * `decideQuarantine()` (scripts/lib/crawler-quarantine.mjs) e, se qualcosa
 * cambia, porta la decisione in una PR che il ciclo del repo revisiona e
 * mergia da solo su `## LGTM`:
 *
 *   - rientro: il crawler lascia il registro e torna nel suo gruppo;
 *   - ritiro: il crawler lascia il gruppo e finisce in `retired`, con una
 *     issue «Crawler ritirato: <slug>» che lo annuncia;
 *   - fallimento noto: un rosso NUOVO diventa tollerato solo dopo aver avuto
 *     una issue aperta (quella del reporter per crawler, oppure una nuova) e
 *     con la scadenza scritta nel registro;
 *   - recupero: un crawler noto tornato verde perde la tolleranza, cosi' un
 *     suo nuovo rosso e' una regressione e fa di nuovo fallire il gruppo.
 *
 * Una issue di tracciamento chiusa mentre il crawler e' ancora rosso viene
 * riaperta: ogni crawler escluso dal verdetto ha una issue aperta.
 *
 *   node scripts/crawler-quarantine-review.mjs                 # solo decisioni
 *   node scripts/crawler-quarantine-review.mjs --waves-json f  # ondate da file
 *   node scripts/crawler-quarantine-review.mjs --apply         # issue + file + generatore
 *   node scripts/crawler-quarantine-review.mjs --apply --open-pr
 *
 * Tutte le chiamate GitHub passano da `gh`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  QUARANTINE_REJOIN_GREEN_WAVES,
  QUARANTINE_RETIRE_DAYS,
  QUARANTINE_RETIRE_RED_WAVES,
  applyQuarantineDecisions,
  decideQuarantine,
  isMutatingDecision,
  loadQuarantineRegistry,
  quarantineDeadline,
  quarantineRegistryDoc,
  waveFromRunAnnotations,
} from './lib/crawler-quarantine.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const QUARANTINE_PATH = path.join(ROOT, 'data/crawler-quarantine.json');
const ASSIGNMENTS_PATH = path.join(ROOT, 'data/crawler-group-assignments.json');
const DEFAULT_CORPUS_REPO = 'nanakokyobashi-rgb/frontaliere-articles';
const PR_BRANCH_PREFIX = 'crawler-quarantine/';
const DEFAULT_WAVE_LIMIT = 30;

function parseArgs(argv) {
  const args = { apply: false, openPr: false, wavesJson: null, now: null, limit: DEFAULT_WAVE_LIMIT, corpusRepo: DEFAULT_CORPUS_REPO };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--open-pr') { args.openPr = true; args.apply = true; }
    else if (arg === '--waves-json') args.wavesJson = argv[++i];
    else if (arg === '--now') args.now = argv[++i];
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--corpus-repo') args.corpusRepo = argv[++i];
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100) throw new Error('--limit must be 1..100');
  return args;
}

function gh(args) {
  return execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

/** Completed runs of the quarantine group, newest first, turned into waves. */
export function collectWaves({ corpusRepo, group, limit, memberSlugs, api = ghJson }) {
  const nn = String(group).padStart(2, '0');
  const runs = api(['api', `repos/${corpusRepo}/actions/workflows/crawler-group-${nn}.yml/runs?status=completed&per_page=${limit}`]);
  const waves = [];
  for (const run of runs.workflow_runs ?? []) {
    if (run.conclusion !== 'success' && run.conclusion !== 'failure') continue;
    const jobs = api(['api', `repos/${corpusRepo}/actions/runs/${run.id}/jobs`]);
    const job = (jobs.jobs ?? [])[0];
    if (!job) continue;
    const annotations = api(['api', `repos/${corpusRepo}/check-runs/${job.id}/annotations?per_page=100`]);
    const wave = waveFromRunAnnotations({
      run: { id: run.id, createdAt: run.created_at, conclusion: run.conclusion },
      annotations,
      memberSlugs,
    });
    if (wave) waves.push({ ...wave, url: run.html_url });
  }
  return waves;
}

function runUrl(corpusRepo, runId) {
  return `https://github.com/${corpusRepo}/actions/runs/${runId}`;
}

function describeEvidence(decision, corpusRepo) {
  const e = decision.evidence;
  const runs = (e.runs ?? []).slice(0, 4).map((id) => `[${id}](${runUrl(corpusRepo, id)})`).join(', ');
  return `${e.streak} ondate ${e.latest === 'success' ? 'verdi' : 'rosse'} consecutive dal ${String(e.streakStart ?? '').slice(0, 16)}Z${runs ? ` (ultime: ${runs})` : ''}`;
}

/**
 * Body of the review PR. Pure, so the contract (`## Implementato` +
 * `## Non implementato (ancora)`, stati letterali) is testable without GitHub.
 */
export function buildQuarantineReviewPrBody({ decisions, registry, corpusRepo = DEFAULT_CORPUS_REPO, issues = {}, workflowPaths = [] }) {
  const lines = [];
  for (const d of decisions) {
    if (d.action === 'rejoin') {
      const target = d.homeGroup ? `nel gruppo ${d.homeGroup}` : 'in un gruppo scelto dalla regola deterministica del generatore';
      lines.push(`- **in questa PR** — \`${d.slug}\` rientra ${target}: ${describeEvidence(d, corpusRepo)}, soglia ${QUARANTINE_REJOIN_GREEN_WAVES}.`);
    } else if (d.action === 'retire') {
      lines.push(`- **in questa PR** — \`${d.slug}\` ritirato: ${d.reason}; ${describeEvidence(d, corpusRepo)}. Resta nel manifest (riattivarlo e' togliere la voce \`retired\`), non e' piu' schedulato. Annuncio: #${issues[d.slug]}.`);
    } else if (d.action === 'mark-failing') {
      const deadline = quarantineDeadline({ failingSince: d.failingSince });
      lines.push(`- **in questa PR** — \`${d.slug}\` diventa fallimento noto, tracciato da #${issues[d.slug]}: il suo rosso resta escluso dal verdetto del gruppo ${registry.group} fino al ${deadline}; ${describeEvidence(d, corpusRepo)}.`);
    } else if (d.action === 'mark-recovering') {
      lines.push(`- **in questa PR** — \`${d.slug}\` e' tornato verde (${describeEvidence(d, corpusRepo)}): perde la tolleranza, un suo nuovo rosso fa di nuovo fallire il gruppo; rientra dopo ${QUARANTINE_REJOIN_GREEN_WAVES} ondate verdi.`);
    }
  }
  if (workflowPaths.length > 0) {
    lines.push(`- **in questa PR** — registro, pin e workflow rigenerati da \`scripts/generate-crawler-group-workflows.mjs\`: \`data/crawler-quarantine.json\`, \`data/crawler-group-assignments.json\`, ${workflowPaths.map((p) => `\`${p}\``).join(', ')}.`);
  }
  const pending = decisions.filter((d) => d.action === 'keep-failing');
  const pendingLines = pending.map((d) => `- **per scelta** — \`${d.slug}\` resta fallimento noto (#${d.issue}) fino al ${d.deadline}: ${describeEvidence(d, corpusRepo)}. **Motivo:** ne' ${QUARANTINE_RETIRE_RED_WAVES} ondate rosse ne' ${QUARANTINE_RETIRE_DAYS} giorni sono ancora raggiunti. **Prossimo passo:** la review successiva lo ritira alla soglia, o lo segna in recupero al primo verde.`);
  return `## Implementato

${lines.join('\n')}

## Non implementato (ancora)

${pendingLines.length > 0 ? pendingLines.join('\n') : '- Nessuno.'}

Decisioni di \`scripts/crawler-quarantine-review.mjs\` sulle ondate osservate di \`crawler-group-${String(registry.group).padStart(2, '0')}.yml\` in \`${corpusRepo}\`: rientro dopo ${QUARANTINE_REJOIN_GREEN_WAVES} ondate verdi consecutive, ritiro dopo ${QUARANTINE_RETIRE_RED_WAVES} ondate rosse consecutive o ${QUARANTINE_RETIRE_DAYS} giorni di fallimento.
`;
}

function findOpenIssueByExactTitle(title) {
  const found = ghJson(['issue', 'list', '--state', 'open', '--search', `"${title}" in:title`, '--limit', '20', '--json', 'number,title']);
  return found.find((issue) => issue.title === title)?.number ?? null;
}

function createIssue({ title, body, labels }) {
  const url = gh(['issue', 'create', '--title', title, '--body', body, ...labels.flatMap((l) => ['--label', l])]).trim();
  const number = Number(/\/issues\/(\d+)/.exec(url)?.[1]);
  if (!Number.isSafeInteger(number)) throw new Error(`gh issue create returned no issue number: ${url}`);
  return number;
}

function comment(issue, body) {
  gh(['issue', 'comment', String(issue), '--body', body]);
}

function ensureOpen(issue, body) {
  const state = ghJson(['issue', 'view', String(issue), '--json', 'state']).state;
  if (state !== 'OPEN') gh(['issue', 'reopen', String(issue), '--comment', body]);
  return state;
}

/** Issue side effects. Returns slug -> issue number for applyQuarantineDecisions. */
function performIssueActions({ decisions, registry, corpusRepo }) {
  const issues = {};
  for (const d of decisions) {
    const evidence = describeEvidence(d, corpusRepo);
    if (d.action === 'mark-failing') {
      const deadline = quarantineDeadline({ failingSince: d.failingSince });
      const note = `Il crawler \`${d.slug}\` e' rosso nel gruppo di quarantena ${registry.group}: ${evidence}. Da ora il suo fallimento e' **noto** ed escluso dal verdetto del gruppo fino al **${deadline}** (\`data/crawler-quarantine.json\`). Alla scadenza, o dopo ${QUARANTINE_RETIRE_RED_WAVES} ondate rosse consecutive, \`scripts/crawler-quarantine-review.mjs\` lo ritira; con ${QUARANTINE_REJOIN_GREEN_WAVES} ondate verdi rientra.`;
      // The per-crawler reporter's issue first; then one this script opened on
      // an earlier run whose PR never landed, so a retry does not duplicate it.
      let issue = findOpenIssueByExactTitle(`Crawler Failure: Run ${d.slug}`)
        ?? findOpenIssueByExactTitle(`Crawler in quarantena: ${d.slug}`);
      if (issue) comment(issue, note);
      else issue = createIssue({ title: `Crawler in quarantena: ${d.slug}`, body: note, labels: ['bug', 'crawlers'] });
      issues[d.slug] = issue;
    } else if (d.action === 'keep-failing') {
      const previous = ensureOpen(d.issue, `Riaperta da \`scripts/crawler-quarantine-review.mjs\`: \`${d.slug}\` e' ancora rosso (${evidence}) ed e' escluso dal verdetto del gruppo ${registry.group} fino al ${d.deadline} solo finche' questa issue lo traccia.`);
      if (previous !== 'OPEN') console.log(`  riaperta #${d.issue} (${d.slug} ancora rosso)`);
    } else if (d.action === 'retire') {
      const body = `\`${d.slug}\` e' stato ritirato dalla quarantena del gruppo ${registry.group}: ${d.reason}; ${evidence}. Il fallimento era tracciato da #${d.issue}.\n\nEffetto: il crawler resta in \`data/crawler-manifest.json\` ma non e' piu' schedulato (\`retired\` in \`data/crawler-quarantine.json\`); i suoi annunci non vengono piu' aggiornati e scadono con la pulizia ordinaria.\n\nPer riattivarlo: riparare il crawler, togliere la voce \`retired\` e rigenerare i gruppi. Per eliminarlo: rimuoverlo dal manifest.`;
      const existing = findOpenIssueByExactTitle(`Crawler ritirato: ${d.slug}`);
      issues[d.slug] = existing ?? createIssue({ title: `Crawler ritirato: ${d.slug}`, body, labels: ['bug', 'crawlers'] });
      if (!existing) comment(d.issue, `Ritirato dalla quarantena: vedi #${issues[d.slug]}.`);
    }
  }
  return issues;
}

function openReviewPrExists() {
  const prs = ghJson(['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,headRefName']);
  return prs.find((pr) => String(pr.headRefName).startsWith(PR_BRANCH_PREFIX)) ?? null;
}

function changedWorkflowPaths() {
  const out = execFileSync('git', ['diff', '--name-only', '--', '.github/workflows', '.github/corpus-workflows'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadQuarantineRegistry(QUARANTINE_PATH);
  if (!registry) throw new Error(`${path.relative(ROOT, QUARANTINE_PATH)} is missing`);
  const now = args.now ?? new Date().toISOString();
  const memberSlugs = Object.keys(registry.members);

  const waves = args.wavesJson
    ? JSON.parse(fs.readFileSync(args.wavesJson, 'utf8'))
    : collectWaves({ corpusRepo: args.corpusRepo, group: registry.group, limit: args.limit, memberSlugs });
  console.log(`ondate osservate: ${waves.length} (${waves.filter((w) => w.source === 'notice').length} con notice, ${waves.filter((w) => w.source === 'legacy').length} lette dalle annotation)`);

  const decisions = decideQuarantine({ registry, waves, now });
  for (const d of decisions) {
    console.log(`  ${d.slug.padEnd(28)} ${d.action.padEnd(16)} ${d.evidence.latest ?? '-'} x${d.evidence.streak} (osservate ${d.evidence.observed})`);
  }
  const mutating = decisions.filter(isMutatingDecision);
  const tracked = decisions.filter((d) => d.action === 'keep-failing');
  if (!args.apply) {
    console.log(`\n${mutating.length} decisioni con effetto; --apply per eseguirle.`);
    return;
  }
  if (args.openPr) {
    const open = openReviewPrExists();
    if (open) {
      console.log(`PR di review gia' aperta (#${open.number}, ${open.headRefName}): nessuna nuova decisione finche' non e' mergiata.`);
      return;
    }
  }
  const issues = performIssueActions({ decisions: [...mutating, ...tracked], registry, corpusRepo: args.corpusRepo });
  if (mutating.length === 0) {
    console.log('Nessuna decisione cambia registro o gruppi.');
    return;
  }

  const assignments = JSON.parse(fs.readFileSync(ASSIGNMENTS_PATH, 'utf8'));
  const next = applyQuarantineDecisions({ registry, assignments: assignments.groups, decisions: mutating, now, issues });
  writeJsonAtomic(QUARANTINE_PATH, quarantineRegistryDoc(next.registry));
  writeJsonAtomic(ASSIGNMENTS_PATH, { ...assignments, groups: next.assignments });
  execFileSync('node', ['scripts/generate-crawler-group-workflows.mjs'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync('node', ['scripts/generate-crawler-group-workflows.mjs', '--check'], { cwd: ROOT, stdio: 'inherit' });
  if (!args.openPr) {
    console.log('File aggiornati; --open-pr per aprire la PR.');
    return;
  }

  const workflowPaths = changedWorkflowPaths();
  const body = buildQuarantineReviewPrBody({ decisions: [...mutating, ...tracked], registry, corpusRepo: args.corpusRepo, issues, workflowPaths });
  const bodyFile = path.join(ROOT, '.crawler-quarantine-review-pr-body.md');
  fs.writeFileSync(bodyFile, body);
  const { validatePrBodyFile } = await import('./ci/pr-body-check-gate.mjs');
  const contract = validatePrBodyFile(bodyFile, ROOT, { diffPaths: workflowPaths });
  if (contract.kind === 'contract-violation') {
    for (const v of contract.validation.violations) console.error(`  - [${v.type}] ${v.message}`);
    throw new Error('the review PR body violates the repository contract');
  }
  const stamp = now.slice(0, 16).replace(/[-:T]/g, '');
  const branch = `${PR_BRANCH_PREFIX}review-${stamp}`;
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  git('checkout', '-b', branch);
  git('add', 'data/crawler-quarantine.json', 'data/crawler-group-assignments.json', 'scripts/ci/crawler-generation-roster.json', '.github/workflows', '.github/corpus-workflows');
  const summary = mutating.map((d) => `${d.action} ${d.slug}`).join(', ');
  git('commit', '-m', `chore(crawlers): quarantine review — ${summary}`);
  git('push', '-u', 'origin', branch);
  const url = gh(['pr', 'create', '--base', 'main', '--head', branch, '--title', `Quarantena crawler: ${summary}`.slice(0, 250), '--body-file', bodyFile]).trim();
  fs.rmSync(bodyFile, { force: true });
  console.log(`PR aperta: ${url}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
