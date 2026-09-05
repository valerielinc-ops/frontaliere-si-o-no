/**
 * Reading and writing article body strings under
 * `services/locales/blog-body[-ch]/<locale>/<id>.ts`.
 *
 * Extracted 2026-07-28. Three scripts had grown their own copy of the same
 * extraction, and they had already drifted:
 *
 *   - repair-repetitive-articles.mjs — the reference implementation
 *   - audit-article-factuality.mjs   — a verbatim copy of it
 *   - audit-articles-factcheck.mjs   — a variant whose regex never anchored the
 *     closing quote and which skipped the backslash unescape, so a body
 *     containing an escaped backslash came out different from the other two
 *
 * Per AGENTS.md #6, a regex duplicated in ≥2 files goes into one shared module
 * so drift is impossible by construction.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { unescapeTsString } from './unescape-ts-string.mjs';

/**
 * Both body dirs share the same {id}.ts-per-locale layout (create-article.mjs
 * bodyDir: 'blog-body' for frontaliere articles, 'blog-body-ch' for svizzera).
 * Scan both: PR #4650's two live repetition bugs were in blog-body-ch and
 * survived a repair pass that only looked at blog-body.
 */
export const BODY_DIRS = ['services/locales/blog-body', 'services/locales/blog-body-ch'];

export const LOCALES = ['it', 'en', 'de', 'fr'];

/** Body dir for a section id ('svizzera' → blog-body-ch, anything else → blog-body). */
export function bodyDirForSection(section) {
  return section === 'svizzera' ? 'services/locales/blog-body-ch' : 'services/locales/blog-body';
}

/**
 * Extracts body1..body3 from a body module's source text.
 *
 * @param {string} content raw .ts file contents
 * @param {string} id      article id (the file's basename)
 * @returns {Record<string,string>} e.g. { body1, body2, body3 } — missing keys omitted
 */
export function extractBodies(content, id) {
  const bodies = {};
  if (typeof content !== 'string' || !id) return bodies;
  for (let i = 1; i <= 3; i++) {
    const key = `blog.article.${id}.body${i}`;
    const pattern = new RegExp(`'${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`, 's');
    const m = content.match(pattern);
    if (m) bodies[`body${i}`] = unescapeFromTS(m[1]);
  }
  return bodies;
}

/** Reads and extracts in one step. Returns {} when the file cannot be read. */
export function readBodies(filePath, id) {
  try {
    return extractBodies(readFileSync(filePath, 'utf-8'), id);
  } catch {
    return {};
  }
}

/** Decodes a single-quoted TS string literal body back to plain text. */
export function unescapeFromTS(s) {
  return unescapeTsString(String(s || ''), { "'": "'", n: '\n', '\\': '\\' });
}

/** Encodes plain text for embedding in a single-quoted TS string literal. */
export function escapeForTS(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

// ── Locating which article ids a diff touches ───────────────────────────
//
// Extracted 2026-08-13 from audit-article-factuality.mjs so
// report-synced-article-fabrication.mjs (issue #5671) could scope itself to
// the same "what is about to change" set without a second hand-copy of the
// same regex and the same three-git-calls union. Per AGENTS.md #6: a
// regex/constant duplicated in ≥2 files goes into one shared module so drift
// is impossible by construction — audit-article-factuality.mjs now imports
// this instead of carrying its own copy.
//
// Two prefixes, because `services/locales/blog-body[-ch]` is a SYMLINK to
// `packages/articles/content/blog-body[-ch]`. `git diff --name-only` reports
// the resolved path, so a regex anchored on the symlink prefix alone matched
// nothing and a caller exited 0 on every diff — verifying nothing while
// looking green. Accepts whichever prefix the repo happens to be using.
//
// Any locale, not just `it`: callers judge translations too (the fabrication
// guard's FABRICATED_LABOR_OFFICE check runs per-locale), and a change that
// only touches `<root>/blog-body/en/<id>.ts` is exactly the shape that must
// still be caught.
export const BODY_PATH_RE =
  /^(?:services\/locales|packages\/articles\/content)\/blog-body(?:-ch)?\/(?:it|en|de|fr)\/(.+)\.ts$/;

/** Article ids named by `git diff --name-only`-shaped output. */
function articleIdsFromPaths(out) {
  const ids = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(BODY_PATH_RE);
    if (m) ids.add(m[1]);
  }
  return ids;
}

// The index carries 30k+ entries and the corpus alone is ~15k files, so a
// full-corpus refresh can print a name list far past execFileSync's 1 MB
// default. ENOBUFS there would be caught by the `catch` below and reported as
// "diff unavailable" — i.e. the scan would silently cover nothing on exactly
// the largest, most interesting change.
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_OPTS = { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: GIT_MAX_BUFFER };

/**
 * Article ids touched in the diff against `base`.
 * @param {string} base
 * @returns {Set<string>|'unavailable'}
 */
export function changedArticleIds(base) {
  let out = '';
  try {
    // Three-dot first (changes introduced by this branch since the merge base).
    // CI checks out shallow, so the merge base is often absent — fall back to a
    // plain two-dot tree diff, which only needs both tips to be present.
    try {
      out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], GIT_OPTS);
    } catch {
      out = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], GIT_OPTS);
    }
  } catch {
    // `::error::` (not a plain console.error): issue #6058 — a base ref that
    // fails to resolve used to degrade this gate to a silent no-op (exit 0,
    // scanned=0, indistinguishable from "diff computed, nothing touched a
    // body"). The only caller (audit-article-factuality.mjs, --changed mode)
    // still exits 0 here by design — recovering by falling back to a full
    // corpus scan would turn a resolution glitch into an unrelated PR being
    // blocked by pre-existing corpus defects — but the annotation makes the
    // "I verified nothing" case visibly red in the Actions UI instead of
    // reading exactly like a clean run.
    console.error(`::error::git diff contro "${base}" non riuscito (clone shallow o ref assente).`);
    console.error('   Scope NON calcolabile su questo diff — nessun articolo verificato.');
    return 'unavailable';
  }
  return articleIdsFromPaths(out);
}

/**
 * Article ids changed in the working tree but not yet committed: unstaged
 * edits, staged edits and new untracked files.
 *
 * All three, because callers run between `pull-articles-corpus.mjs` (which
 * overwrites tracked bodies AND drops brand-new ones in, untracked) and the
 * `git add` that stages them. Reading only the unstaged diff would miss every
 * NEW article — the majority of what a sync brings — and reading only the
 * index would miss everything if a caller ever moves earlier. The union is
 * correct at any point before the commit.
 *
 * @returns {Set<string>|'unavailable'}
 */
export function changedArticleIdsWorktree() {
  let out = '';
  try {
    out = [
      execFileSync('git', ['diff', '--name-only'], GIT_OPTS),
      execFileSync('git', ['diff', '--name-only', '--cached'], GIT_OPTS),
      execFileSync('git', ['ls-files', '--others', '--exclude-standard'], GIT_OPTS),
    ].join('\n');
  } catch {
    console.error('⚠️  git diff/ls-files sul working tree non riuscito.');
    console.error('   Scope NON calcolabile — nessun articolo verificato.');
    return 'unavailable';
  }
  return articleIdsFromPaths(out);
}

/**
 * Sottoinsieme di `changedArticleIdsWorktree()`: gli articoli **nuovi** in
 * questo sync, cioe' i soli file di body ancora untracked.
 *
 * ── Perche' serve distinguerli (issue #5661, riapertura del 2026-09-05) ─────
 *
 * `changedArticleIdsWorktree()` unisce di proposito modificati e nuovi, ed e'
 * l'insieme giusto per DIRE cosa e' successo in un sync. Non e' l'insieme
 * giusto per decidere che una condizione si e' RIPRESENTATA: un articolo
 * vecchio riscritto per un motivo qualunque — un fix mirato, un backfill, un
 * riformat — rientra nel diff e diventa indistinguibile da uno appena ammesso.
 *
 * Misurato sul caso che ha riaperto #5661 trentaquattro minuti dopo la
 * chiusura: l'unico articolo segnalato,
 * `vivere-tovo-di-sant-agata-e-lavorare-in-grigioni-da-frontaliere`, era stato
 * generato il 2026-08-11T08:43:30Z — venticinque giorni prima della guardia di
 * ammissione (corpus #951, 2026-09-05T21:29:43Z) — ed era entrato nel diff
 * solo perche' la PR corpus #915 gli aveva corretto un errore geografico alle
 * 17:41Z dello stesso giorno. Nessuno dei due rilievi era nuovo, e nessuna
 * guardia di ammissione puo' riguardare un testo scritto prima che esistesse.
 *
 * Uno stock storico non e' una ricorrenza: e' un residuo noto e dichiarato.
 * Confonderli rende la issue immortale, perche' basta toccare uno qualunque
 * dei ~2.400 articoli con rilievi preesistenti per farla riaprire — e ogni
 * riapertura consuma un tentativo del ciclo, per sempre.
 *
 * `'unavailable'` (mai un insieme vuoto) quando git non risponde: un chiamante
 * che non riesce a distinguere flusso e stock deve poter scegliere di NON
 * filtrare, invece di smettere silenziosamente di segnalare — che e'
 * esattamente la forma di no-op silenzioso che questi script esistono per
 * evitare.
 *
 * @returns {Set<string>|'unavailable'}
 */
export function newArticleIdsWorktree() {
  try {
    return articleIdsFromPaths(
      execFileSync('git', ['ls-files', '--others', '--exclude-standard'], GIT_OPTS),
    );
  } catch {
    console.error('⚠️  git ls-files sul working tree non riuscito.');
    console.error('   Flusso e stock NON distinguibili — nessun filtro applicato.');
    return 'unavailable';
  }
}
