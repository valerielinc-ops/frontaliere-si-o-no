#!/usr/bin/env node
/**
 * repair-point-lease.mjs - deterministic ZERO-LLM gate for issue-fix.yml: one
 * repair point, one fixer.
 *
 * Il 2026-11-26 `issue-fix.yml` ha lanciato in parallelo ~8 fixer su issue
 * diverse (#19854, #19903, #19906, #19910, #19909, #19202, #19959) che avevano
 * la STESSA riparazione (coordinate Workday egress: `workday-client.mjs`, il
 * suo test e i workflow generati): 22 issue «Conflitto con main: riapplicare la
 * PR #N». L'unico controllo degli overlap era l'istruzione «Overlap-file» nel
 * prompt del fixer (valutata dentro l'agente, a PR gia' in lavorazione) e il
 * claim `agent:in-progress` (claim-issue-in-flight.mjs) e' per singola issue,
 * non per punto di riparazione.
 *
 * Qui il punto di riparazione diventa una lease: se i path target della issue
 * si sovrappongono ai file di una PR aperta del ciclo (`isAgentOwnedPr` di
 * pr-autorebase.mjs: label `agent:autofix` oppure branch `fix/*` /
 * `automerge-*`) o al punto di riparazione di un altro fixer in volo, la issue
 * NON parte: torna in `agent:fix-queued` con un commento marker idempotente che
 * nomina il blocco.
 *
 * Ripartenza: con una PR bloccante il commento porta anche
 * `FIX_OUTCOME: overlap-skip` + «in volo nella PR #N», il contratto che il
 * drainer gia' legge (`overlapSkipBlocker`/`overlapBlockerActive`): la issue
 * resta in coda finche' la PR e' aperta e attiva e viene ripromossa appena
 * mergia o si chiude. Con un peer in volo (nessuna PR) il drainer la ripromuove
 * al tick dopo e questo gate la rivaluta: zero token, nessun tentativo
 * consumato.
 *
 * Path target, in ordine (il primo insieme non vuoto vince):
 *   1. righe `Repair point: \`<path>\``;
 *   2. `[crawler-health] <slug>`: libreria di famiglia (`scripts/lib/ats-clients/*`)
 *      importata dallo script del crawler, ricavato da data/crawler-manifest.json
 *      (altrimenti lo script stesso);
 *   3. path in `## Suggested action`, `## Item` e blocchi di codice.
 * I file generati (registro `generated-files-registry.mjs`, `.github/corpus-workflows/*`)
 * non contano: li gestisce la rigenerazione. Nessun path -> no-op fail-open con log.
 *
 * Tie-break fra issue lanciate insieme: un peer con `agent:fix` e numero piu'
 * basso vince (cosi' di N fixer simultanei ne parte uno); un peer con claim
 * `agent:in-progress` vince sempre. Limite noto: il gate precede il claim, due
 * run nello stesso secondo senza `agent:fix` visibile possono passare entrambe.
 *
 * Env: GH_TOKEN, GH_REPO, ISSUE_NUMBER, DRY_RUN=1 (niente scritture),
 *      GITHUB_OUTPUT (`repair_point_blocked`, `repair_point_blocker`).
 * FAIL-OPEN: qualunque errore gh/parse -> `repair_point_blocked=false` (il
 * backlog non si ferma per un guasto del gate), sempre con riga di log.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isAgentOwnedPr } from './pr-autorebase.mjs';

export const LEASE_MARKER = 'REPAIR_POINT_LEASE';
const LBL_FIX = 'agent:fix';
const LBL_QUEUED = 'agent:fix-queued';
const LBL_CLAIM = 'agent:in-progress';

// Copia di STALLED_PR_LABELS / conflictHandoffOriginPr di followup-drainer.mjs
// (non importato: modulo da ~7000 righe con budget a livello di modulo). Una PR
// ferma non mergera' da sola e aspettarla chiude un cerchio (#10586 su #10555);
// in «riapplicare la PR #N su main» la PR #N e' quella da sostituire.
const STALLED_PR_LABELS = Object.freeze(['has-conflicts', 'stale-review', 'needs-human']);
const CONFLICT_HANDOFF_TITLE_RE = /^Conflitto con main(?: dopo LGTM)?: riapplicare la PR #(\d+) su main$/u;

const PATH_CHARS = String.raw`[\w.@+()[\]{}-]+`;
// Lista chiusa come GROUP_PATH_RE del drainer, piu' le radici di workflow generati
// e di codice (`functions/`, `server/`, `hooks/`) che il fixer puo' toccare.
const TARGET_PATH_RE = new RegExp(
  String.raw`(?<![\w./-])(?:\.github\/(?:workflows|corpus-workflows)|scripts|build-plugins|services|components|packages|generator|content|tests|functions|server|hooks)(?:\/${PATH_CHARS})+\.[A-Za-z0-9]+`,
  'g',
);
const SAFE_PATH_RE = new RegExp(String.raw`^(?:\.github\/)?${PATH_CHARS}(?:\/${PATH_CHARS})+$`);
const REPAIR_POINT_LINE_RE = /^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?Repair point(?:\*\*)?[ \t]*:(?:\*\*)?[ \t]*(.+)$/gim;

function cleanPath(raw) {
  const p = String(raw || '').trim().replace(/^\.\//, '').replace(/[),.;:]+$/, '');
  if (!p || p.startsWith('/') || p.split('/').includes('..')) return null;
  return SAFE_PATH_RE.test(p) ? p : null;
}

/** Path dichiarati con `Repair point: \`<path>\`` (un path o piu' path per riga). */
export function extractDeclaredRepairPoints(body) {
  const out = new Set();
  for (const m of String(body || '').matchAll(REPAIR_POINT_LINE_RE)) {
    const value = m[1];
    const ticked = [...value.matchAll(/`([^`\n]+)`/g)].map((t) => t[1]);
    const candidates = ticked.length ? ticked : [value.trim().split(/\s+/)[0]];
    for (const c of candidates) {
      const p = cleanPath(c);
      if (p) out.add(p);
    }
  }
  return [...out];
}

/** Testo delle sezioni `## Suggested action` / `## Item` piu' i blocchi di codice. */
function targetRegionText(body) {
  const text = String(body || '');
  const chunks = [];
  for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) chunks.push(m[1]);
  const lines = text.split('\n');
  let depth = 0;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (/^(?:suggested action|item)\b/i.test(heading[2].trim())) { depth = level; continue; }
      if (depth && level <= depth) depth = 0;
    }
    if (depth) chunks.push(line);
  }
  return chunks.join('\n');
}

/** Path di codice citati nelle regioni target del body (equivalente del prompt «Overlap-file»). */
export function extractRegionPaths(body) {
  const out = new Set();
  for (const raw of targetRegionText(body).match(TARGET_PATH_RE) || []) {
    const p = cleanPath(raw);
    if (p) out.add(p);
  }
  return [...out];
}

function resolveImport(fromFile, spec) {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  return resolved.startsWith('..') ? null : resolved;
}

function crawlerScriptFor(slug, { manifest, packageScripts, exists }) {
  const entry = (manifest?.manifest || []).find((e) => e?.slug === slug);
  let run = String(entry?.runStep?.run || '');
  const npm = /^(?:xvfb-run\s+-a\s+)?npm\s+run\s+([\w:.-]+)/.exec(run);
  if (npm) run = String(packageScripts?.[npm[1]] || '');
  const direct = /\bnode\s+(scripts\/[\w./-]+\.mjs)/.exec(run);
  if (direct) return direct[1];
  const guess = `scripts/update-${slug}-jobs.mjs`;
  return exists(guess) ? guess : null;
}

/**
 * Libreria di famiglia di un crawler: gli `scripts/lib/ats-clients/*` importati
 * direttamente dal suo script (profondita' 1). Senza famiglia, lo script stesso.
 * Pura rispetto al filesystem: `readText`/`exists` iniettati.
 */
export function crawlerRepairPoints(slug, { manifest, packageScripts, readText, exists }) {
  const script = crawlerScriptFor(slug, { manifest, packageScripts, exists });
  if (!script) return [];
  const source = readText(script);
  if (typeof source !== 'string') return [script];
  const libs = new Set();
  for (const m of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const resolved = resolveImport(script, m[1]);
    if (resolved && resolved.startsWith('scripts/lib/ats-clients/')) libs.add(resolved);
  }
  return libs.size ? [...libs].sort() : [script];
}

/** Punto di riparazione di una issue: ordine 1 -> 2 -> 3, primo insieme non vuoto. */
export function extractRepairPoints(issue, deps = {}) {
  const body = String(issue?.body || '');
  const declared = extractDeclaredRepairPoints(body);
  if (declared.length) return { source: 'repair-point-line', paths: declared };
  const slug = /^\s*\[crawler-health\]\s+([a-z0-9][\w.-]*)/i.exec(String(issue?.title || ''))?.[1];
  if (slug && deps.readText) {
    const family = crawlerRepairPoints(slug.toLowerCase(), deps);
    if (family.length) return { source: 'crawler-family', paths: family };
  }
  const region = extractRegionPaths(body);
  return { source: region.length ? 'body-regions' : 'none', paths: region };
}

/** Un file rigenerato dal registro dei workflow crawler non e' un punto di riparazione. */
export function isGeneratedPath(p, registryPlan = null) {
  if (p.startsWith('.github/corpus-workflows/')) return true;
  if (!registryPlan) return false;
  const plan = registryPlan([p]);
  return Array.isArray(plan?.rules) && plan.rules.length > 0;
}

function isOwnPr(pr, issueNumber) {
  return new RegExp(`(?:^|[/-])issue-${issueNumber}(?:$|[^\\d])`).test(String(pr?.headRefName || ''));
}

function isStalled(labels = []) {
  return labels.some((l) => STALLED_PR_LABELS.includes(typeof l === 'string' ? l : l?.name));
}

/**
 * Decisione pura. `paths` sono i path target gia' privi dei file generati.
 * @param {{issueNumber:number, title?:string, paths:string[],
 *   openPrs:Array<{number:number,title?:string,labels?:any[],headRefName?:string,files:Iterable<string>}>,
 *   peers?:Array<{number:number,claimed:boolean,paths:string[]}>}} input
 * @returns {{blocked:false}|{blocked:true,kind:'pr'|'issue',number:number,file:string,title?:string}}
 */
export function decideLease({ issueNumber, title = '', paths, openPrs, peers = [] }) {
  if (!paths.length) return { blocked: false };
  const target = new Set(paths);
  const originPr = Number(CONFLICT_HANDOFF_TITLE_RE.exec(String(title).trim())?.[1]) || null;
  for (const pr of openPrs) {
    if (originPr !== null && Number(pr.number) === originPr) continue;
    if (!isAgentOwnedPr(pr.labels || [], pr.headRefName || '')) continue;
    if (isStalled(pr.labels || []) || isOwnPr(pr, issueNumber)) continue;
    for (const f of pr.files) {
      if (target.has(f)) return { blocked: true, kind: 'pr', number: pr.number, file: f, title: pr.title };
    }
  }
  for (const peer of [...peers].sort((a, b) => a.number - b.number)) {
    if (peer.number === issueNumber) continue;
    if (!peer.claimed && peer.number > issueNumber) continue; // vince il numero piu' basso
    const hit = peer.paths.find((p) => target.has(p));
    if (hit) return { blocked: true, kind: 'issue', number: peer.number, file: hit };
  }
  return { blocked: false };
}

export function blockerKey(decision) {
  return `${decision.kind}-${decision.number}`;
}

/** Commento marker. Con una PR bloccante porta il contratto che il drainer legge. */
export function buildLeaseComment(decision) {
  const key = blockerKey(decision);
  const head = `<!-- ${LEASE_MARKER} blocker=${key} -->`;
  if (decision.kind === 'pr') {
    return [
      head,
      '<!-- FIX_OUTCOME: overlap-skip -->',
      `⏸️ **Pre-flight lease del punto di riparazione (zero-LLM)**: il file \`${decision.file}\` e' già in volo nella PR #${decision.number}${decision.title ? ` (${String(decision.title).slice(0, 80)})` : ''}.`,
      '',
      `Il fixer non parte: la issue torna in \`${LBL_QUEUED}\` senza consumare un tentativo e riparte da sola quando la PR #${decision.number} viene mergiata o chiusa (il drainer la trattiene finché è attiva).`,
    ].join('\n');
  }
  return [
    head,
    '<!-- FIX_OUTCOME: overlap-skip -->',
    `⏸️ **Pre-flight lease del punto di riparazione (zero-LLM)**: il file \`${decision.file}\` è il punto di riparazione dell'issue #${decision.number}, già in lavorazione da un altro fixer.`,
    '',
    `Il fixer non parte: la issue torna in \`${LBL_QUEUED}\` senza consumare un tentativo e il drainer la ripromuove quando #${decision.number} ha finito (PR o chiusura).`,
  ].join('\n');
}

/** Marker gia' postato per lo stesso blocco? Guarda l'ultimo commento marker. Pura. */
export function leaseCommentAlreadyPosted(comments, decision) {
  const re = new RegExp(`<!--\\s*${LEASE_MARKER}\\s+blocker=([\\w-]+)\\s*-->`);
  let last = null;
  for (const c of comments || []) {
    const m = re.exec(String(c?.body || ''));
    if (m) last = m[1];
  }
  return last === blockerKey(decision);
}

// --- CLI -------------------------------------------------------------------

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

function setOutputs(values) {
  for (const [k, v] of Object.entries(values)) console.log(`${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  }
}

function readRepoText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { /* sparse: prova da git */ }
  try {
    return execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}

function loadDeps() {
  const readJson = (file) => { try { return JSON.parse(readRepoText(file)); } catch { return null; } };
  return {
    manifest: readJson('data/crawler-manifest.json'),
    packageScripts: readJson('package.json')?.scripts || {},
    readText: readRepoText,
    exists: (file) => readRepoText(file) !== null,
  };
}

async function loadRegistryPlan() {
  try {
    const mod = await import('./generated-files-registry.mjs');
    return (paths) => mod.generatedConflictPlan(paths);
  } catch (e) {
    console.log(`::warning::repair-point-lease: registro file generati non caricabile (${String(e?.message || e).slice(0, 120)}): vale solo il prefisso .github/corpus-workflows/.`);
    return null;
  }
}

function labelNames(labels) {
  return (labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
}

export async function main() {
  const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];
  const dry = process.env.DRY_RUN === '1';
  const issueNumber = Number(process.env.ISSUE_NUMBER);
  const proceed = (why) => {
    console.log(`repair-point-lease: ${why} -> il fixer procede.`);
    setOutputs({ repair_point_blocked: false, repair_point_blocker: '' });
  };
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return proceed('ISSUE_NUMBER mancante/invalido (fail-open)');

  let issue;
  try {
    issue = JSON.parse(gh(['issue', 'view', String(issueNumber), ...repoArgs, '--json', 'title,body,labels,comments']));
  } catch (e) {
    return proceed(`issue illeggibile (fail-open): ${String(e?.message || e).slice(0, 120)}`);
  }

  const deps = loadDeps();
  const registryPlan = await loadRegistryPlan();
  const notGenerated = (paths) => paths.filter((p) => !isGeneratedPath(p, registryPlan));
  const own = extractRepairPoints(issue, deps);
  const paths = notGenerated(own.paths);
  if (!paths.length) {
    return proceed(`nessun punto di riparazione ricavabile (fonte=${own.source}, ${own.paths.length - paths.length} file generati ignorati; no-op fail-open)`);
  }
  console.log(`repair-point-lease: #${issueNumber} punto di riparazione (${own.source}): ${paths.join(', ')}`);

  let openPrs;
  let peers = [];
  try {
    openPrs = JSON.parse(gh(['pr', 'list', ...repoArgs, '--state', 'open', '--limit', '300', '--json', 'number,title,labels,headRefName,files']))
      .map((pr) => ({ ...pr, labels: labelNames(pr.labels), files: (pr.files || []).map((f) => f.path) }));
    const seen = new Map();
    for (const label of [LBL_CLAIM, LBL_FIX]) {
      const rows = JSON.parse(gh(['issue', 'list', ...repoArgs, '--state', 'open', '--label', label, '--limit', '100', '--json', 'number,title,body,labels']));
      for (const row of rows) {
        if (row.number === issueNumber) continue;
        const names = labelNames(row.labels);
        const claimed = names.includes(LBL_CLAIM);
        const prev = seen.get(row.number);
        if (prev) { prev.claimed ||= claimed; continue; }
        seen.set(row.number, { number: row.number, claimed, paths: notGenerated(extractRepairPoints(row, deps).paths) });
      }
    }
    peers = [...seen.values()];
  } catch (e) {
    return proceed(`lettura PR/peer fallita (fail-open): ${String(e?.message || e).slice(0, 120)}`);
  }

  const decision = decideLease({ issueNumber, title: issue.title, paths, openPrs, peers });
  if (!decision.blocked) return proceed(`nessuna sovrapposizione (${openPrs.length} PR, ${peers.length} peer in volo)`);

  const key = blockerKey(decision);
  console.log(`repair-point-lease: #${issueNumber} BLOCCATA da ${decision.kind === 'pr' ? 'PR' : 'issue'} #${decision.number} su \`${decision.file}\` -> ${LBL_QUEUED}.`);
  if (!dry) {
    if (!leaseCommentAlreadyPosted(issue.comments, decision)) {
      gh(['issue', 'comment', String(issueNumber), ...repoArgs, '--body', buildLeaseComment(decision)]);
    } else {
      console.log('repair-point-lease: marker gia\' presente per questo blocco, nessun secondo commento.');
    }
    gh(['issue', 'edit', String(issueNumber), ...repoArgs, '--add-label', LBL_QUEUED, '--remove-label', LBL_FIX]);
  }
  setOutputs({ repair_point_blocked: true, repair_point_blocker: key });
}

if (process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  main().catch((e) => {
    // FAIL-OPEN: un guasto del gate non deve fermare il backlog.
    console.log(`::warning::repair-point-lease: errore (fail-open): ${String(e?.message || e).slice(0, 200)}`);
    setOutputs({ repair_point_blocked: false, repair_point_blocker: '' });
    process.exit(0);
  });
}
