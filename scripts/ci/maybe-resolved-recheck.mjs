#!/usr/bin/env node
/**
 * maybe-resolved-recheck.mjs — zero-Claude: una `maybe-resolved` smentita dai
 * fatti torna nel ciclo, e ogni `maybe-resolved` aperta ha un proprietario
 * della prova che le manca.
 *
 * Il difetto. `maybe-resolved` e' uno stadio di verifica che tiene la issue
 * FUORI dal ciclo: `triage-sweep.mjs` (`VERIFICATION_LABEL`) non la
 * re-instrada, il drainer non la riprende, e `route-already-fixed.mjs` la
 * applica togliendo `agent:fix*` («MAI chiude la issue»). Il contratto dice
 * «chi toglie `maybe-resolved` la rimette nel ciclo» — ma nessun processo
 * deterministico la TOGLIEVA quando i fatti smentiscono il verdetto. Una issue
 * marcata «forse risolta» che riceve poi una ricorrenza `🔁` o viene riaperta
 * restava fuori da triage e fixer per sempre (misurato il 2026-10-03: 8591,
 * 8670, 7421, 9247; 0 rigetti storici).
 *
 * Cosa fa, a ogni tick:
 *   1. INVENTARIO (anche in --dry-run): ogni issue aperta con `maybe-resolved`
 *      riceve UNA classe e il proprietario della prova che manca, stampati nello
 *      step summary:
 *        bucket           label `follow-up` → `followup-reconcile` (tier 2)
 *        pinned           pin esplicito (`isFixerExempt`, `pinned`, `revenue`,
 *                         `tracker`, `do-not-close`)
 *        claimed          `agent:in-progress` o una PR aperta che la cita
 *        owned            famiglia con un monitor proprietario (titolo o
 *                         label `loop-l<N>`): lo chiude o lo riconferma lui
 *        unreadable       eventi, commenti o lista PR illeggibili: nessuna
 *                         mutazione (fail-closed)
 *        reject           DOPO l'ultimo evento `labeled maybe-resolved`
 *                         esiste un commento `🔁` di autore fidato o un evento
 *                         `reopened`: il verdetto e' smentito
 *        evidence-unbound titolo `(Workflow|CI) Failure: <nome>` e la run del
 *                         marker `ALREADY_FIXED_ROUTED` appartiene a un
 *                         workflow DIVERSO da `<nome>`: la label e' stata messa
 *                         con una prova non pertinente (caso 7421). Solo
 *                         informazione: il generatore si corregge in
 *                         `route-already-fixed.mjs`, non qui.
 *        awaiting-metric  nessuna obiezione nota: serve la METRICA della issue
 *                         o una run verde, successiva alla fix, del workflow
 *                         che l'ha aperta. NON significa «pronta da chiudere».
 *   2. RIGETTO (l'unica mutazione), solo sulla classe `reject` e mai su
 *      bucket/pinned/claimed/owned: toglie `maybe-resolved` e posta
 *      `<!-- MAYBE_RESOLVED_REJECTED: reason=<recurrence|reopened> at=<iso> -->`
 *      con il link all'evento. Non aggiunge label di routing: il secondo
 *      passaggio di `triage-sweep.mjs` (triaged ma senza routing) la ritrova e
 *      la re-instrada; `fu-parked`/`automation-deferred` restano dove sono e la
 *      issue torna allo sweep giornaliero che li possiede.
 *
 * Questo script NON chiude issue, in nessun ramo: `maybe-resolved` e il marker
 * `ALREADY_FIXED_ROUTED` non sono prove di guarigione (8868 e 9815 portano la
 * label e il difetto e' ancora vero). Non importa e non modifica
 * `route-already-fixed.mjs`, `reconcile-followups.mjs`,
 * `close-recovered-failure-issues.mjs`.
 *
 *   GH_TOKEN=… GH_REPO=owner/repo node scripts/ci/maybe-resolved-recheck.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isFixerExempt } from '../lib/classify-issue.mjs';

export const VERIFY_LABEL = 'maybe-resolved';
export const REJECT_MARKER = 'MAYBE_RESOLVED_REJECTED';
export const MAX_REJECTS_PER_RUN = 10;
export const RECURRENCE_PREFIX = '🔁';
const ROUTED_MARKER_RE = /<!--\s*ALREADY_FIXED_ROUTED:([^>]*?)-->/gu;
const FAILURE_TITLE_RE = /^(?:Workflow|CI) Failure: (.+)$/u;

export const CLAIM_LABEL = 'agent:in-progress';
export const BUCKET_LABEL = 'follow-up';
export const PIN_LABELS = Object.freeze(['pinned', 'revenue', 'tracker', 'do-not-close']);

/**
 * Famiglie con un monitor proprietario: le chiude o le riconferma lui, non
 * questo script. Il titolo e' quello che il monitor conia.
 */
export const OWNED_FAMILIES = Object.freeze([
  { re: /^\[crawler-health\]/iu, owner: 'check-crawler-health.mjs' },
  { re: /^\[parser-health\]/iu, owner: 'assemble-jobs-dataset.mjs (parser-health)' },
  { re: /^Validation Failure \(dist\):/u, owner: 'report-validate-dist-failure.mjs' },
  { re: /^SEO gates regression:/u, owner: 'cathedral-seo-gates-check.yml' },
  { re: /^CF 5xx:/u, owner: 'cf-5xx-issue-sync.mjs' },
  { re: /^App Error:/u, owner: 'app-error-issue-sync.mjs' },
  { re: /^CWV Regression/u, owner: 'cwv-monitor-check.mjs' },
]);
const LOOP_LABEL_RE = /^loop-l\d+/u;

/**
 * Copia locale, come funzione pura, di `isTrustedAuthor` di
 * `route-already-fixed.mjs` (stessi bot di `AUTHORIZED_QUOTA_BEACON_BOTS` in
 * `claude-rate-limit.mjs`, stesse associazioni). Accetta sia la forma REST
 * (`user.login` con `[bot]`, `author_association`) sia quella GraphQL
 * (`author.login`, `authorAssociation`).
 */
const TRUSTED_BOTS = new Set(['github-actions', 'claude', 'frontaliere-automation']);
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function isTrustedAuthor(comment) {
  const rawLogin = String(comment?.user?.login ?? comment?.author?.login ?? '').trim().toLowerCase();
  const login = rawLogin.replace(/\[bot\]$/u, '');
  const type = comment?.user?.type ? String(comment.user.type).toLowerCase() : null;
  // REST espone il tipo: un utente umano che si chiama come un bot non e' il bot.
  if (login && TRUSTED_BOTS.has(login) && (type === null || type === 'bot')) return true;
  return TRUSTED_ASSOCIATIONS.has(String(comment?.author_association ?? comment?.authorAssociation ?? ''));
}

export function labelNames(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((l) => String(typeof l === 'string' ? l : l?.name ?? '').toLowerCase())
    .filter(Boolean);
}

const timeOf = (x) => Date.parse(x?.created_at ?? x?.createdAt ?? '');

/**
 * Numeri delle issue citate da almeno una PR aperta (titolo o corpo).
 * `#N` o `/issues/N`, mai un prefisso di un numero piu' lungo.
 * @param {Array<{title?: string, body?: string}>} prs
 */
export function openPrIssueRefs(prs) {
  const refs = new Set();
  for (const pr of Array.isArray(prs) ? prs : []) {
    const text = `${pr?.title ?? ''}\n${pr?.body ?? ''}`;
    for (const m of text.matchAll(/(?:#|\/issues\/)(\d{1,7})(?!\d)/gu)) refs.add(Number(m[1]));
  }
  return refs;
}

/**
 * Le classi che non dipendono dalla storia della issue. `null` = nessuna.
 * Senza lista PR leggibile `claimed` non si decide qui (lo fa il chiamante).
 * @param {{number:number,title:string,labels:unknown[]}} issue
 * @param {Set<number>|null} openPrRefs
 */
export function staticClass(issue, openPrRefs) {
  const names = labelNames(issue?.labels);
  const has = (l) => names.includes(l);
  if (has(BUCKET_LABEL)) return { cls: 'bucket', owner: 'followup-reconcile (tier 2)' };
  if (isFixerExempt(names) || PIN_LABELS.some(has)) return { cls: 'pinned', owner: 'proprietario (pin esplicito)' };
  if (has(CLAIM_LABEL)) return { cls: 'claimed', owner: 'sessione con agent:in-progress' };
  if (openPrRefs instanceof Set && openPrRefs.has(Number(issue?.number))) {
    return { cls: 'claimed', owner: 'PR aperta che la cita' };
  }
  const title = String(issue?.title ?? '');
  const family = OWNED_FAMILIES.find((f) => f.re.test(title));
  if (family) return { cls: 'owned', owner: family.owner };
  const loop = names.find((l) => LOOP_LABEL_RE.test(l));
  if (loop) return { cls: 'owned', owner: `loop-fleet observer (${loop})` };
  return null;
}

/** Istante dell'ULTIMO evento `labeled maybe-resolved`, o `null`. */
export function lastVerifyLabeledAt(events) {
  let last = null;
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev?.event !== 'labeled') continue;
    if (String(ev?.label?.name ?? '').toLowerCase() !== VERIFY_LABEL) continue;
    const t = timeOf(ev);
    if (Number.isFinite(t) && (last === null || t > last)) last = t;
  }
  return last;
}

/**
 * La prima obiezione successiva alla label: un commento che COMINCIA con `🔁`
 * di autore fidato (ricorrenza) o un evento `reopened`.
 * @returns {{reason:'recurrence'|'reopened', at:number, url:string|null}|null}
 */
export function findObjection({ events, comments, labeledAt, issueUrl = '' }) {
  const found = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    const t = timeOf(c);
    if (!Number.isFinite(t) || t <= labeledAt) continue;
    if (!String(c?.body ?? '').trimStart().startsWith(RECURRENCE_PREFIX)) continue;
    if (!isTrustedAuthor(c)) continue;
    found.push({ reason: 'recurrence', at: t, url: c?.html_url ?? c?.url ?? null });
  }
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev?.event !== 'reopened') continue;
    const t = timeOf(ev);
    if (!Number.isFinite(t) || t <= labeledAt) continue;
    found.push({ reason: 'reopened', at: t, url: issueUrl && ev?.id ? `${issueUrl}#event-${ev.id}` : issueUrl || null });
  }
  found.sort((a, b) => a.at - b.at);
  return found[0] ?? null;
}

/** `run=` dell'ULTIMO marker `ALREADY_FIXED_ROUTED` di autore fidato, o `null`. */
export function routedRunId(comments) {
  let run = null;
  let at = -Infinity;
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!isTrustedAuthor(c)) continue;
    const t = timeOf(c);
    for (const m of String(c?.body ?? '').matchAll(ROUTED_MARKER_RE)) {
      const id = /(?:^|\s)run=([1-9]\d*)(?=\s|$)/u.exec(m[1]);
      if (!id) continue;
      const when = Number.isFinite(t) ? t : at;
      if (when >= at) { at = when; run = Number(id[1]); }
    }
  }
  return run !== null && Number.isSafeInteger(run) ? run : null;
}

/**
 * La run del marker appartiene al workflow del titolo?
 * `null` = non si sa (titolo non di fallimento, run o elenco workflow
 * illeggibili, nome non risolvibile): la classe NON si assegna.
 * @param {{title:string, runPath:string|null, workflows:Array<{name:string,path:string}>|null}} input
 * @returns {'bound'|'unbound'|null}
 */
export function evidenceBinding({ title, runPath, workflows }) {
  const m = FAILURE_TITLE_RE.exec(String(title ?? ''));
  if (!m || !runPath || !Array.isArray(workflows)) return null;
  const name = m[1].trim();
  const paths = new Set(workflows.filter((w) => String(w?.name ?? '').trim() === name).map((w) => String(w.path)));
  if (paths.size === 0) return null;
  const normalized = String(runPath).split('@', 1)[0];
  return paths.has(normalized) ? 'bound' : 'unbound';
}

export const PROOF_OWNER = Object.freeze({
  unreadable: 'nessuno: si rilegge al prossimo tick',
  reject: 'triage-sweep (rientro nel ciclo)',
  'evidence-unbound': 'run verde del workflow del titolo (generatore: route-already-fixed.mjs)',
  'awaiting-metric': 'orchestratore: metrica della issue o run verde del workflow d\'origine',
});

/**
 * Classe di UNA issue `maybe-resolved`. Pura.
 * `events`/`comments` `null` = illeggibili; `openPrRefs` `null` = lista PR
 * illeggibile; `binding` e' il risultato gia' calcolato di `evidenceBinding`.
 */
export function classifyMaybeResolved({ issue, events, comments, openPrRefs, binding = null }) {
  const base = { number: issue?.number, title: String(issue?.title ?? ''), binding: binding ?? null, objection: null };
  const fixed = staticClass(issue, openPrRefs);
  if (fixed) return { ...base, ...fixed, detail: '' };
  if (!(openPrRefs instanceof Set)) return { ...base, cls: 'unreadable', owner: PROOF_OWNER.unreadable, detail: 'lista PR aperte illeggibile' };
  if (!Array.isArray(events)) return { ...base, cls: 'unreadable', owner: PROOF_OWNER.unreadable, detail: 'eventi illeggibili' };
  if (!Array.isArray(comments)) return { ...base, cls: 'unreadable', owner: PROOF_OWNER.unreadable, detail: 'commenti illeggibili' };
  const labeledAt = lastVerifyLabeledAt(events);
  if (labeledAt === null) return { ...base, cls: 'unreadable', owner: PROOF_OWNER.unreadable, detail: 'nessun evento labeled maybe-resolved' };
  const objection = findObjection({ events, comments, labeledAt, issueUrl: issue?.url ?? '' });
  const detail = `label ${new Date(labeledAt).toISOString()}`;
  if (objection) {
    return { ...base, cls: 'reject', owner: PROOF_OWNER.reject, objection, labeledAt, detail: `${detail}; ${objection.reason} ${new Date(objection.at).toISOString()}` };
  }
  if (binding === 'unbound') return { ...base, cls: 'evidence-unbound', owner: PROOF_OWNER['evidence-unbound'], labeledAt, detail };
  return { ...base, cls: 'awaiting-metric', owner: PROOF_OWNER['awaiting-metric'], labeledAt, detail };
}

export function rejectCommentBody({ reason, at, url, labeledAt }) {
  const iso = new Date(at).toISOString();
  const what = reason === 'reopened' ? 'la issue è stata **riaperta**' : 'è arrivata una **ricorrenza** `🔁` di un autore fidato';
  return [
    `<!-- ${REJECT_MARKER}: reason=${reason} at=${iso} -->`,
    `↩️ **\`${VERIFY_LABEL}\` smentita dai fatti (zero-Claude)**: dopo l'applicazione della label (${new Date(labeledAt).toISOString()}) ${what} il ${iso}${url ? ` — ${url}` : ''}.`,
    '',
    `Tolta \`${VERIFY_LABEL}\`: la issue torna nel ciclo (il secondo passaggio di \`triage-sweep\` la re-instrada; \`fu-parked\`/\`automation-deferred\`, se presenti, restano allo sweep che li possiede). Nessuna chiusura e nessuna label di routing aggiunta da questo passo.`,
  ].join('\n');
}

/**
 * Esegue l'inventario e i rigetti con dipendenze iniettate (testabile).
 * Ogni `deps.*` di lettura restituisce `null` (o lancia) quando non legge.
 */
export function runRecheck({ issues, deps, dryRun, maxRejects = MAX_REJECTS_PER_RUN }) {
  const log = deps.log ?? ((line) => console.log(line));
  const safe = (fn) => { try { const v = fn(); return v === undefined ? null : v; } catch { return null; } };
  const prs = safe(() => deps.openPrs());
  const openPrRefs = Array.isArray(prs) ? openPrIssueRefs(prs) : null;
  let workflows;
  const workflowList = () => {
    if (workflows === undefined) workflows = safe(() => deps.workflows());
    return Array.isArray(workflows) ? workflows : null;
  };

  const rows = [];
  for (const issue of issues) {
    if (staticClass(issue, openPrRefs)) {
      rows.push(classifyMaybeResolved({ issue, events: [], comments: [], openPrRefs }));
      continue;
    }
    const events = safe(() => deps.events(issue.number));
    const comments = safe(() => deps.comments(issue.number));
    let binding = null;
    if (Array.isArray(comments) && FAILURE_TITLE_RE.test(String(issue.title ?? ''))) {
      const run = routedRunId(comments);
      if (run !== null) {
        const runPath = safe(() => deps.runPath(run));
        binding = evidenceBinding({ title: issue.title, runPath, workflows: workflowList() });
      }
    }
    rows.push(classifyMaybeResolved({ issue, events, comments, openPrRefs, binding }));
  }

  const rejects = rows.filter((r) => r.cls === 'reject');
  const applied = [];
  const overflow = rejects.slice(maxRejects).map((r) => r.number);
  if (overflow.length) {
    log(`eccedenza: ${overflow.length} reject oltre il tetto MAX_REJECTS_PER_RUN=${maxRejects}, rimandati al prossimo tick: ${overflow.map((n) => `#${n}`).join(', ')}`);
  }
  if (!dryRun) {
    for (const row of rejects.slice(0, maxRejects)) {
      // Rilettura subito prima di scrivere: un'altra mano puo' aver gia' tolto
      // la label, chiuso la issue o reclamato il lavoro.
      const fresh = safe(() => deps.readIssue(row.number));
      if (!fresh) { row.note = 'rilettura fallita: nessuna scrittura'; continue; }
      const freshIssue = { number: row.number, title: row.title, labels: fresh.labels };
      if (String(fresh.state ?? '').toLowerCase() !== 'open') { row.note = 'non piu\' aperta'; continue; }
      if (!labelNames(fresh.labels).includes(VERIFY_LABEL)) { row.note = 'label gia\' tolta'; continue; }
      const now = staticClass(freshIssue, openPrRefs);
      if (now) { row.note = `ora ${now.cls}: nessuna scrittura`; continue; }
      try {
        deps.removeLabel(row.number);
      } catch (e) {
        row.note = `rimozione label fallita: ${String(e?.message ?? e).slice(0, 120)}`;
        continue;
      }
      try {
        deps.comment(row.number, rejectCommentBody({ ...row.objection, labeledAt: row.labeledAt }));
        row.note = 'label tolta';
      } catch (e) {
        row.note = `label tolta, commento fallito: ${String(e?.message ?? e).slice(0, 120)}`;
      }
      applied.push(row.number);
    }
  }
  return { rows, applied, overflow };
}

const CLASS_ORDER = ['reject', 'evidence-unbound', 'awaiting-metric', 'unreadable', 'claimed', 'owned', 'pinned', 'bucket'];

export function renderSummary({ rows, applied, overflow }, { dryRun, repo }) {
  const counts = Object.fromEntries(CLASS_ORDER.map((c) => [c, 0]));
  for (const r of rows) counts[r.cls] = (counts[r.cls] ?? 0) + 1;
  const cell = (s) => String(s ?? '').replace(/\|/gu, '\\|').replace(/\n/gu, ' ');
  const sorted = [...rows].sort((a, b) => CLASS_ORDER.indexOf(a.cls) - CLASS_ORDER.indexOf(b.cls) || a.number - b.number);
  const lines = [
    `## maybe-resolved recheck${dryRun ? ' (dry-run)' : ''} — ${repo}`,
    '',
    `Issue aperte con \`${VERIFY_LABEL}\`: **${rows.length}** · rigetti applicati: **${applied.length}**${overflow.length ? ` · eccedenza rimandata: ${overflow.length}` : ''}`,
    '',
    '| classe | n |',
    '|---|---:|',
    ...CLASS_ORDER.filter((c) => counts[c]).map((c) => `| ${c} | ${counts[c]} |`),
    '',
    '| issue | titolo | classe | proprietario della prova | prova del marker | dettaglio |',
    '|---|---|---|---|---|---|',
    ...sorted.map((r) => `| #${r.number} | ${cell(r.title.slice(0, 70))} | ${r.cls} | ${cell(r.owner)} | ${r.binding ?? '—'} | ${cell([r.detail, r.note].filter(Boolean).join('; '))} |`),
  ];
  return lines.join('\n');
}

// ─── I/O reale (gh) ─────────────────────────────────────────────────────────

function gh(args, input) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    input,
  });
}

/** `gh api --paginate` di un array, una riga JSON per elemento. */
function ghApiList(endpoint, jq = '.[] | tojson') {
  const out = gh(['api', '--paginate', endpoint, '--jq', jq]);
  return out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function realDeps(repo) {
  return {
    openPrs: () => JSON.parse(gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '500', '--json', 'number,title,body'])),
    events: (n) => ghApiList(`repos/${repo}/issues/${n}/events?per_page=100`),
    comments: (n) => ghApiList(`repos/${repo}/issues/${n}/comments?per_page=100`),
    runPath: (id) => gh(['api', `repos/${repo}/actions/runs/${id}`, '--jq', '.path']).trim() || null,
    workflows: () => ghApiList(`repos/${repo}/actions/workflows?per_page=100`, '.workflows[] | {name, path} | tojson'),
    readIssue: (n) => JSON.parse(gh(['api', `repos/${repo}/issues/${n}`, '--jq', '{state, labels: [.labels[].name]}'])),
    removeLabel: (n) => gh(['issue', 'edit', String(n), '--repo', repo, '--remove-label', VERIFY_LABEL]),
    comment: (n, body) => gh(['issue', 'comment', String(n), '--repo', repo, '--body-file', '-'], body),
    log: (line) => console.log(line),
  };
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  if (!repo) { console.error('GH_REPO/GITHUB_REPOSITORY mancante'); process.exit(1); }
  let issues;
  try {
    issues = JSON.parse(gh(['issue', 'list', '--repo', repo, '--state', 'open', '--label', VERIFY_LABEL,
      '--limit', '500', '--json', 'number,title,labels,url']));
  } catch (e) {
    // Senza l'inventario non si decide niente: rosso visibile, zero scritture.
    console.error(`inventario illeggibile: ${String(e?.message ?? e).slice(0, 200)}`);
    process.exit(1);
  }
  const result = runRecheck({ issues, deps: realDeps(repo), dryRun });
  const summary = renderSummary(result, { dryRun, repo });
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`); } catch { /* il log resta */ }
  }
}

const isDirectRun = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; }
  catch { return false; }
})();
if (isDirectRun) main();
