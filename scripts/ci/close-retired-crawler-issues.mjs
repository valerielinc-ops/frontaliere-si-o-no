#!/usr/bin/env node
/**
 * close-retired-crawler-issues.mjs — un crawler RITIRATO con evidenza chiude le
 * sue issue di FALLIMENTO; un ritiro da sola soglia automatica no.
 *
 * ─── Perché esiste ───────────────────────────────────────────────────────
 *
 * Un crawler ritirato (`retired` in `data/crawler-quarantine.json`) non ha piu'
 * uno step `Run <slug>` in alcun `crawler-group-*.yml`. Il chiuditore centrale
 * `close-recovered-failure-issues.mjs` giudica una `Crawler Failure: Run <slug>`
 * leggendo proprio quello step: non trovandolo, logga «not found … keep open» e
 * la lascia aperta per sempre. Caso misurato: la issue 10083 («Crawler Failure:
 * Run knowledge-lab») e' rimasta aperta dal 30-09 al 03-10 con il crawler gia'
 * ritirato. Le `[parser-health] <slug>:` (aperte da `assemble-jobs-dataset.mjs`)
 * non hanno alcun chiuditore. Le `[crawler-health] <slug>:` invece si chiudono
 * gia' (`check-crawler-health.mjs` marca il ritirato `healthy`, `_retired`): qui
 * NON si toccano, come «Crawler ritirato:» e «Crawler in quarantena:».
 *
 * ─── Quando chiude ───────────────────────────────────────────────────────
 *
 * Per ogni slug in `retired`, TUTTE le prove:
 *   (a) la voce ha `retiredAt`;
 *   (b) il roster e' d'accordo: nessuno step `Run <slug>` in un
 *       `crawler-group-*.yml` (`findCrawlerGroupWorkflow`). Se c'e', registro e
 *       roster sono in disaccordo: nessuna chiusura, warning;
 *   (c) tracker o evidenza: la issue `retired[slug].issue` e' APERTA, oppure il
 *       motivo NON e' quello scritto dalla soglia automatica
 *       (`isAutomaticRetireReason`). DECISIONS 2026-09-23 chiede il ritiro con
 *       evidenza triangolata, e «N ondate rosse consecutive» non lo e': senza un
 *       tracker aperto chiudere le issue di fallimento cancellerebbe l'unica
 *       traccia del guasto. Nessuna chiusura, warning nello step summary.
 *
 * La chiusura passa da `resolveGithubIssue(…, { reason: 'not_planned' })` di
 * `scripts/lib/github-issue-creator.mjs` (equivalente a `--resolve --reason
 * not_planned`): un `gh issue close` diretto e' invisibile al gate statico
 * apertura/chiusura (incidente 5437). Titolo ESATTO, issue con `keep-open` /
 * `agent:no-age-out` / `agent:in-progress` saltate, stato riletto subito prima,
 * al piu' MAX_CLOSURES_PER_RUN chiusure per run.
 *
 * ─── Uso ─────────────────────────────────────────────────────────────────
 *
 *   node scripts/ci/close-retired-crawler-issues.mjs --dry-run   # stampa e basta
 *   node scripts/ci/close-retired-crawler-issues.mjs             # chiude
 *
 * Solo stdlib (il workflow che lo esegue non fa `npm ci`). Esce 1 solo se una
 * chiusura tentata viene rifiutata; i warning escono 0.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGithubIssue, commentOnGithubIssue } from '../lib/github-issue-creator.mjs';
import { isAutomaticRetireReason, loadQuarantineRegistry } from '../lib/crawler-quarantine.mjs';
import { findCrawlerGroupWorkflow } from './close-recovered-failure-issues.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'data', 'crawler-quarantine.json');

export const MAX_CLOSURES_PER_RUN = 20;
export const SKIP_LABELS = Object.freeze(['keep-open', 'agent:no-age-out', 'agent:in-progress']);
export const RETIRED_WITHOUT_EVIDENCE_TITLE =
  'Crawler ritirato senza tracker aperto né evidenza: issue di fallimento non chiudibili';

/** Le famiglie di issue di FALLIMENTO di uno slug, per titolo esatto o prefisso con `:`. */
export function failureFamilyOf(title, slug) {
  if (title === `Crawler Failure: Run ${slug}`) return 'crawler-failure';
  if (title.startsWith(`[parser-health] ${slug}: `)) return 'parser-health';
  return null;
}

/** Un motivo scritto a mano (non vuoto, non quello della soglia automatica) e' evidenza. */
export function hasManualRetireReason(entry) {
  return typeof entry?.reason === 'string' && entry.reason.trim() !== '' && !isAutomaticRetireReason(entry.reason);
}

/**
 * Verdetto puro su UNO slug ritirato.
 *
 * @param {{ slug: string, entry: object, inRoster: boolean, trackerState: 'OPEN'|'CLOSED'|null }} input
 *   `trackerState` null = non leggibile (fail-closed per un ritiro da soglia);
 *   conta solo quando il motivo non basta da solo come evidenza.
 * @returns {{ slug: string, closable: boolean, evidence?: string,
 *            kind?: 'no-retired-at'|'roster-disagreement'|'no-evidence', warning?: string }}
 */
export function judgeRetiredSlug({ slug, entry, inRoster, trackerState }) {
  if (!entry?.retiredAt) {
    return { slug, closable: false, kind: 'no-retired-at', warning: `${slug}: voce \`retired\` senza \`retiredAt\` — nessuna chiusura.` };
  }
  if (inRoster) {
    return {
      slug,
      closable: false,
      kind: 'roster-disagreement',
      warning: `${slug}: registro e roster in disaccordo — ritirato in data/crawler-quarantine.json ma ancora con uno step \`Run ${slug}\` in un crawler-group-*.yml. Nessuna chiusura.`,
    };
  }
  if (hasManualRetireReason(entry)) return { slug, closable: true, evidence: 'motivo del ritiro scritto con la fonte, non da soglia automatica' };
  if (trackerState === 'OPEN') return { slug, closable: true, evidence: `ritiro da soglia automatica con tracker #${entry.issue} aperto` };
  const tracker = trackerState === 'CLOSED' ? 'chiuso' : 'non leggibile';
  return {
    slug,
    closable: false,
    kind: 'no-evidence',
    warning: `${slug}: ritiro senza tracker aperto né evidenza — motivo «${entry.reason ?? ''}» da soglia automatica, tracker #${entry.issue} ${tracker}. Le issue di fallimento restano aperte.`,
  };
}

/**
 * Piano puro: quali issue chiudere, quali saltare, quali warning riportare.
 *
 * @param {{ registry: { retired?: object }, openIssues: {number:number,title:string,labels?:string[]}[],
 *           inRoster: (slug: string) => boolean, trackerState: (issue: number) => ('OPEN'|'CLOSED'|null),
 *           max?: number }} input
 */
export function planRetiredClosures({ registry, openIssues, inRoster, trackerState, max = MAX_CLOSURES_PER_RUN }) {
  const closures = [];
  const skipped = [];
  const warnings = [];
  const deferred = [];
  for (const [slug, entry] of Object.entries(registry?.retired ?? {})) {
    const issues = openIssues
      .map((issue) => ({ ...issue, family: failureFamilyOf(String(issue.title ?? ''), slug) }))
      .filter((issue) => issue.family);
    // Ogni ritiro viene giudicato, anche senza issue da chiudere: un ritiro da
    // soglia senza tracker aperto va visto nello step summary PRIMA che arrivi
    // la prossima issue di fallimento. Il tracker si legge (una chiamata) solo
    // quando il motivo da solo non e' evidenza.
    const needsTracker = !hasManualRetireReason(entry);
    const verdict = judgeRetiredSlug({
      slug,
      entry,
      inRoster: inRoster(slug),
      trackerState: needsTracker && entry?.issue ? trackerState(entry.issue) : null,
    });
    if (!verdict.closable) {
      warnings.push({ ...verdict, issues: issues.map((i) => i.number) });
      continue;
    }
    // Un titolo con una gemella protetta si salta intero: resolveGithubIssue
    // sceglie da solo fra le aperte con lo stesso titolo esatto.
    const protectedTitles = new Set(issues
      .filter((i) => (i.labels ?? []).some((l) => SKIP_LABELS.includes(l)))
      .map((i) => i.title));
    for (const issue of issues) {
      if (protectedTitles.has(issue.title)) {
        skipped.push({ number: issue.number, title: issue.title, slug, why: 'etichetta protetta' });
        continue;
      }
      const item = { number: issue.number, title: issue.title, family: issue.family, slug, entry, evidence: verdict.evidence };
      if (closures.length < max) closures.push(item);
      else deferred.push(item);
    }
  }
  return { closures, skipped, warnings, deferred };
}

/** Commento con la voce `retired` citata: perche' questa issue si chiude. */
export function retiredClosureNote({ slug, entry, evidence }) {
  return [
    `Il crawler \`${slug}\` e' ritirato: \`data/crawler-quarantine.json\` → \`retired.${slug}\``,
    `- ritirato il ${entry.retiredAt}`,
    `- motivo: ${entry.reason ?? '(nessuno)'}`,
    `- tracker del ritiro: #${entry.issue}`,
    `- prova: ${evidence}; nessuno step \`Run ${slug}\` nei crawler-group-*.yml.`,
    '',
    'Non e\' piu\' schedulato, quindi questo fallimento non puo\' ne\' ripetersi ne\' tornare verde: chiusa come «not planned» da `scripts/ci/close-retired-crawler-issues.mjs`. Per riattivarlo: togliere la voce `retired` e rigenerare i gruppi.',
  ].join('\n');
}

/* ── effetti ─────────────────────────────────────────────────────────── */

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function repoFlag() {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  return repo ? ['--repo', repo] : [];
}

function listOpenIssues() {
  // Listing diretto, non `--search`: l'indice di ricerca e' in ritardo.
  const out = gh(['issue', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,labels', ...repoFlag()]);
  return JSON.parse(out).map((i) => ({
    number: i.number,
    title: i.title,
    labels: (i.labels ?? []).map((l) => l?.name).filter(Boolean),
  }));
}

function readIssue(number) {
  try {
    const view = JSON.parse(gh(['issue', 'view', String(number), '--json', 'state,title,labels', ...repoFlag()]));
    return { state: String(view.state ?? '').toUpperCase(), title: view.title, labels: (view.labels ?? []).map((l) => l?.name).filter(Boolean) };
  } catch {
    return null;
  }
}

function summary(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try { fs.appendFileSync(file, `${lines.join('\n')}\n`); } catch { /* best effort */ }
}

function issueList(numbers) {
  return numbers.length > 0 ? numbers.map((n) => `#${n}`).join(', ') : 'nessuna aperta';
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const registry = loadQuarantineRegistry(REGISTRY_PATH);
  if (!registry || Object.keys(registry.retired ?? {}).length === 0) {
    console.log('[close-retired] nessun crawler ritirato: niente da fare.');
    return 0;
  }
  const trackerCache = new Map();
  const plan = planRetiredClosures({
    registry,
    openIssues: listOpenIssues(),
    inRoster: (slug) => findCrawlerGroupWorkflow(slug) !== null,
    trackerState: (issue) => {
      if (!trackerCache.has(issue)) trackerCache.set(issue, readIssue(issue)?.state || null);
      return trackerCache.get(issue);
    },
  });

  const runUrl = process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
  const workflow = process.env.GITHUB_WORKFLOW || undefined;

  for (const w of plan.warnings) {
    // Niente `title=`: nelle proprieta' di un workflow command `:` e `,` vanno
    // escapati, e il titolo li contiene.
    const prefix = w.kind === 'no-evidence' ? `${RETIRED_WITHOUT_EVIDENCE_TITLE} — ` : '';
    console.log(`::warning::${prefix}${w.warning} Issue di fallimento: ${issueList(w.issues)}`);
  }
  for (const s of plan.skipped) console.log(`  #${s.number} "${s.title}" — ${s.why}, saltata`);
  for (const d of plan.deferred) console.log(`  #${d.number} "${d.title}" — oltre il tetto di ${MAX_CLOSURES_PER_RUN}, alla prossima run`);

  let closed = 0;
  let refused = 0;
  for (const item of plan.closures) {
    if (dryRun) {
      console.log(`  #${item.number} WOULD CLOSE (not_planned) — "${item.title}" (${item.evidence})`);
      continue;
    }
    // Stato riletto subito prima: fra il listing e qui un umano o un fixer puo'
    // averla chiusa, rinominata o reclamata.
    const fresh = readIssue(item.number);
    if (!fresh || fresh.state !== 'OPEN' || fresh.title !== item.title
      || fresh.labels.some((l) => SKIP_LABELS.includes(l))) {
      console.log(`  #${item.number} "${item.title}" — cambiata dopo il listing (${fresh ? fresh.state : 'non leggibile'}), saltata`);
      continue;
    }
    try {
      const result = resolveGithubIssue(item.title, { workflow, runUrl, exactTitle: true, reason: 'not_planned' });
      if (result?.persisted) {
        commentOnGithubIssue(result.number, retiredClosureNote(item));
        console.log(`  #${result.number} CLOSED (not_planned) — "${item.title}" (${item.evidence})`);
        closed += 1;
      } else {
        console.log(`  #${item.number} "${item.title}" — resolve non ha chiuso nulla, resta com'e'`);
      }
    } catch (err) {
      console.error(`::error::#${item.number} "${item.title}": chiusura rifiutata — ${err.message}`);
      refused += 1;
    }
  }

  const lines = [`### Crawler ritirati: issue di fallimento`, ''];
  lines.push(`- chiuse: ${dryRun ? `0 (dry-run, ${plan.closures.length} candidate)` : closed}; rifiutate: ${refused}; saltate: ${plan.skipped.length}; rinviate: ${plan.deferred.length}`);
  const noEvidence = plan.warnings.filter((w) => w.kind === 'no-evidence');
  const otherWarnings = plan.warnings.filter((w) => w.kind !== 'no-evidence');
  if (noEvidence.length > 0) {
    lines.push('', `**${RETIRED_WITHOUT_EVIDENCE_TITLE}**`, '');
    for (const w of noEvidence) lines.push(`- ${w.warning} Issue di fallimento: ${issueList(w.issues)}`);
  }
  if (otherWarnings.length > 0) {
    lines.push('', '**Ritiri non verificabili**', '');
    for (const w of otherWarnings) lines.push(`- ${w.warning} Issue di fallimento: ${issueList(w.issues)}`);
  }
  summary(lines);
  console.log(`[close-retired] done: closed=${closed} refused=${refused} skipped=${plan.skipped.length} deferred=${plan.deferred.length} warnings=${plan.warnings.length}${dryRun ? ' (dry-run)' : ''}`);
  return refused > 0 ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = main();
}
