/**
 * followup-has-candidates.mjs — no-op pre-gate (zero-Claude, deterministico).
 *
 * `post-merge-followup.yml` invoca Claude (sonnet, ~20 turni) su OGNI PR mergiata
 * dall'owner per triagiare i candidati follow-up. Ma una larga fetta di quelle PR
 * NON ha nulla da triagiare: `## Non implementato (ancora)` legge «Nessuno» e il
 * reviewer ha lasciato un `## LGTM` pulito senza 🟡/❓. Per quelle, la run Claude è
 * sprecata sulla quota Max OAuth CONDIVISA con la sessione interattiva owner
 * (AGENTS.md § frugalità). Questo gate le individua deterministicamente e salta
 * la run — stessa filosofia di `issue-triage` (zero-Claude) e del sibling
 * grandchild-gate `is-followup-fix-pr.mjs`.
 *
 * COSA NON FA: il filtro funnel-critico (giudizio semantico «vale la pena?») resta
 * a Claude — replicarlo in regex spammerebbe issue o perderebbe follow-up reali.
 * Questo gate decide solo «c'è ALMENO UN candidato plausibile?», non «quali».
 *
 * Emette `has_candidates=false` (→ skip Claude) SOLO quando, con certezza:
 *   - `## Non implementato` è assente / vuoto / «Nessuno» / TBD / N/A, E
 *   - l'ultima review del reviewer bot non ha righe 🟡/❓, E
 *   - (se ci sono item) OGNI item matcha un hard-exclude noto (churn / missing-test
 *     / live-verify, come in FOLLOWUP.md + prompt del workflow).
 * In tutti gli altri casi → `has_candidates=true`.
 *
 * PROCEED-SAFE: qualunque dubbio, errore gh, body illeggibile → `true` → Claude gira.
 * Meglio una run Claude in più che perdere un follow-up legittimo.
 *
 * Output (GITHUB_OUTPUT): `has_candidates=true|false`.
 * Env: PR_NUMBER (richiesto), GH_REPO|GITHUB_REPOSITORY,
 *      GITHUB_OUTPUT/GITHUB_STEP_SUMMARY (opz).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// Direzione dell'import voluta: questo file è site-only (non compare nel
// manifest del ciclo), `pr-body-sections-check.mjs` è `mode: identical`. Un
// file `identical` che importasse un file site-only arriverebbe sul corpus
// senza la sua dipendenza (ERR_MODULE_NOT_FOUND con la CI verde); così invece
// è il file che NON viaggia a dipendere da quello che viaggia.
import { bulletState } from '../lib/pr-body-sections-check.mjs';

const PR = process.env.PR_NUMBER;
const repoArgs = (process.env.GH_REPO || process.env.GITHUB_REPOSITORY)
  ? ['--repo', process.env.GH_REPO || process.env.GITHUB_REPOSITORY]
  : [];

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return ''; // proceed-safe: any gh fault → "can't confirm" → run Claude.
  }
}

function setOutput(hasCandidates) {
  console.log(`has_candidates=${hasCandidates}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_candidates=${hasCandidates}\n`);
  }
}

// ── Pure helpers (no I/O) → unit-testable ───────────────────────────

/** Empty markers for the `## Non implementato` section (case-insensitive). */
const EMPTY_NI_RE = /^(nessuno|nessun[ao]?|none|n\/?a|tbd|—|-)?\.?$/i;

// Hard-exclude classes that the Claude prompt ALWAYS drops (FOLLOWUP.md). An item
// is a candidate only if it does NOT match any of these. Kept conservative: a
// partial match is enough to treat an item as non-actionable, because dropping a
// borderline item here only happens when ALL items are droppable (else we run
// Claude anyway).
const HARD_EXCLUDE_RES = [
  // live-verification-only
  /\b(verif(y|ica)\s+live|post-?deploy|live-?200|curl\s+(the\s+)?(url|prod|live)|render\s+at\s+\d|devtools|playwright\s+hydration|\(live\)|\(post-merge,\s*live\))\b/i,
  // missing-test nit
  /\b(missing\s+test|add(\s+a)?\s+(unit\s+)?test|aggiung\w*\s+(un\s+)?test|manca\s+(un\s+)?test|add\s+coverage|aggiung\w*\s+coverage|committ?a\s+il\s+test|pin\w*\s+(the\s+)?behaviou?r\s+with\s+a\s+test)\b/i,
  // documentation / churn / pure style
  /\b(de-?rot|line-?number\s+rot|anchor\s+rot|document\s+the\s+(intent|rationale)|comment\s+only|pure\s+(style|naming|format)|nit\s+puro|non\s+funnel-?critical|deferred)\b/i,
];

/**
 * Extract the body lines under `## Non implementato (ancora)` up to the next
 * `## ` heading. Returns the raw bullet item strings (without the leading `- `).
 * @param {string} body
 * @returns {string[]}
 */
export function extractNonImplementedItems(body) {
  const text = String(body || '');
  // No `m` flag: `$` must mean end-of-string (not end-of-line), else the non-greedy
  // capture stops after the first bullet. Lookahead ends the section at the next
  // `## ` heading or EOS. No `^` anchor: the heading is rarely at string start.
  const m = /##\s+Non implementato[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i.exec(text);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter((l) => l.length > 0 && !/^##/.test(l));
}

/**
 * Gli stati che CHIUDONO una voce: dichiarano che non c'è lavoro residuo da
 * riaprire come follow-up.
 *
 *   `in questa PR`      — è già dentro il diff che si sta mergiando;
 *   `PR concatenata #N` — ha già il suo tracciamento, la issue sarebbe un doppione;
 *   `per scelta` / `by construction`         — è un no motivato, non un rinvio;
 *   `blocked: decisione del proprietario`    — idem, deciso da chi decide.
 *
 * Restano candidati `blocked: <causa tecnica>` (lavoro sospeso su una causa
 * esterna: va riaperto) e — deliberatamente — i bullet SENZA stato.
 *
 * SUL BULLET SENZA STATO, che è il punto che decide se questo filtro è sicuro:
 * resta ATTIVO, cioè continua a generare follow-up. Misurato il 2026-08-14
 * sulle ultime 60 PR mergiate: 604 bullet su 830 (73%) non dichiarano stato.
 * Filtrarli qui aprirebbe una finestra
 * cieca proprio sulla classe più numerosa, per giunta senza che nessuno se ne
 * accorga. Spariranno alla fonte quando l'advisory di
 * `scripts/lib/pr-body-sections-check.mjs` (classe `bullet-without-state`) avrà
 * ripulito i generatori; fino ad allora il fail-safe è tenerli.
 *
 * RESA MISURATA OGGI: 2 PR su 60 passano da «apri follow-up» a «non aprire
 * nulla». È poco, ed è voluto:
 * il guadagno vero arriva quando i bullet senza stato spariscono e la classe
 * «chiusa per decisione» diventa la maggioranza dichiarata.
 *
 * La tassonomia NON è riscritta qui: `bulletState()` è importata da
 * `pr-body-sections-check.mjs`, che è il modulo che la definisce e la valida.
 * Due copie divergerebbero al primo stato nuovo — e divergerebbero in silenzio,
 * perché nessun test le confronta.
 */
const CLOSING_STATES = new Set([
  'in-this-pr',
  'chained-pr',
  'by-choice',
  'by-construction',
  'blocked-owner',
]);

/** True if a `## Non implementato` item is a real, non-excluded candidate. */
export function isCandidateItem(item) {
  const s = String(item || '').trim();
  if (!s || EMPTY_NI_RE.test(s)) return false;
  if (HARD_EXCLUDE_RES.some((re) => re.test(s))) return false;
  // Stato letterale che chiude la voce → niente follow-up. `null` (nessuno
  // stato) NON è in CLOSING_STATES: resta candidato, per progetto.
  if (CLOSING_STATES.has(bulletState(s))) return false;
  return true;
}

/** Count reviewer markers (🟡 nit / ❓ question) in a review body. */
export function reviewerMarkerLines(reviewBody) {
  const text = String(reviewBody || '');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /[🟡❓]/.test(l) && !HARD_EXCLUDE_RES.some((re) => re.test(l)));
}

/**
 * Pick the body of the LATEST review left by the Claude reviewer bot.
 *
 * Matches on `user.type === 'Bot' && /^claude/i.test(user.login)` — the SAME
 * convention as the sibling gates `pr-autorebase.mjs` / `auto-merge-eval.mjs`.
 * The reviewer posts as `claude[bot]` (verified on #3074), NOT
 * `github-actions[bot]`: an exact-match on the wrong login matched zero reviews
 * and silently killed the 🟡/❓ branch (🔴 caught in review of this PR).
 *
 * @param {Array<{user?:{login?:string,type?:string}, body?:string}>} reviews
 * @returns {string}
 */
export function selectReviewerBody(reviews) {
  if (!Array.isArray(reviews)) return '';
  const mine = reviews.filter(
    (r) => r?.user?.type === 'Bot' && /^claude/i.test(r?.user?.login || '') && r?.body,
  );
  return mine.length ? String(mine[mine.length - 1].body) : '';
}

/**
 * Decide whether a PR has at least one plausible follow-up candidate.
 * @param {{body:string, reviewBody:string}} input
 * @returns {boolean}
 */
export function hasCandidates({ body, reviewBody }) {
  const items = extractNonImplementedItems(body).filter(isCandidateItem);
  if (items.length > 0) return true;
  if (reviewerMarkerLines(reviewBody).length > 0) return true;
  return false;
}

// ── I/O entrypoint ──────────────────────────────────────────────────

function latestReviewerBody() {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  if (!repo) return '';
  const raw = gh(['api', `repos/${repo}/pulls/${PR}/reviews`, '--paginate']);
  if (!raw) return '';
  try {
    return selectReviewerBody(JSON.parse(raw));
  } catch {
    return ''; // proceed-safe upstream: empty review body → decision falls to NI items.
  }
}

export function main() {
  if (!PR || !/^\d+$/.test(String(PR).trim())) {
    console.log('No valid PR_NUMBER — proceed-safe (run Claude triage).');
    return setOutput(true);
  }

  const raw = gh(['pr', 'view', String(PR), ...repoArgs, '--json', 'body']);
  if (!raw) {
    console.log(`PR #${PR}: body unreadable — proceed-safe (run Claude triage).`);
    return setOutput(true);
  }

  let body = '';
  try {
    body = JSON.parse(raw).body || '';
  } catch {
    console.log(`PR #${PR}: body unparseable — proceed-safe (run Claude triage).`);
    return setOutput(true);
  }

  const reviewBody = latestReviewerBody();
  const candidates = hasCandidates({ body, reviewBody });

  if (candidates) {
    console.log(`PR #${PR}: at least one plausible follow-up candidate → run Claude triage.`);
    return setOutput(true);
  }

  console.log(
    `PR #${PR}: '## Non implementato' empty/Nessuno/all-excluded AND no reviewer 🟡/❓ → ` +
    `nothing to triage. Skipping Claude run (quota saved).`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Follow-up no-op gate: PR #${PR} has no triage candidates\n` +
      `No actionable \`## Non implementato\` items and no reviewer 🟡/❓ → Claude triage skipped ` +
      `(1 Claude run saved on shared Max quota).\n`,
    );
  }
  return setOutput(false);
}

// CLI entrypoint only (importing for tests must not invoke gh). Proceed-safe: any
// uncaught error → emit true (run triage), never strand a real follow-up.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.log(`followup-has-candidates: unexpected error (${e?.message || e}) — proceed-safe (run triage).`);
    setOutput(true);
  }
}
