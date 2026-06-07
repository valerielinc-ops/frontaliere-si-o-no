/**
 * check-sibling-patterns.mjs — surface untouched sibling files that share the
 * code constructs your branch just changed (zero-Claude, deterministico).
 *
 * Root cause (issue #1348): la regola AGENTS.md #6 / Fix flow chiede al fixer di
 * `grep` i file gemelli per lo stesso costrutto e sweepare l'intera classe del
 * bug nella STESSA PR. La regola è prosa: spiega il "cosa" ma non il "come"
 * meccanico, quindi il fixer deve costruire la grep a mano ogni volta e spesso
 * salta un sibling → 🔴 reviewer "stesso antipattern nel file gemello" ricorrente
 * (bucket `reviewer-finding/sibling-class-fix`, ×7 in 14gg). Questo script
 * AUTOMATIZZA quella grep: prende i costrutti distintivi che il diff ha toccato
 * (costanti SCREAMING_SNAKE, helper camelCase distintivi, moduli kebab-case in
 * import/require) e cerca quali ALTRI file di codice — non toccati dal branch —
 * li contengono. Il fixer li ispeziona e decide: includere il fix o giustificare
 * in `## Non implementato`.
 *
 * NON è un gate (advisory, exit 0 di default): è un candidate-surfacer. Surfacare
 * candidati basati su token condivisi non garantisce che ognuno abbia lo stesso
 * antipattern — è il punto di partenza della grep, non il verdetto. Per usarlo
 * come gate CI: `--strict` (exit 1 se trova ≥1 candidato).
 *
 * Logica:
 *   1. Diff del branch vs base (default `origin/main`, three-dot dal merge-base).
 *   2. File di codice cambiati (CODE_DIRS, esclusi data/public/reports/dist/…).
 *   3. Dalle righe cambiate (+/-) estrae token distintivi (vedi extractTokens).
 *   4. Per ogni token `git grep -lF` sui CODE_DIRS → file che lo contengono.
 *   5. Riporta i file NON toccati dal branch, rankati per # di token condivisi.
 *
 * Uso:
 *   node scripts/ci/check-sibling-patterns.mjs            # advisory, exit 0
 *   node scripts/ci/check-sibling-patterns.mjs --base <ref>
 *   node scripts/ci/check-sibling-patterns.mjs --strict   # exit 1 se candidati
 *   node scripts/ci/check-sibling-patterns.mjs --json
 *
 * Zero dipendenze, solo git in PATH. Cerca solo file tracked (git grep).
 */
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict');
const JSON_OUT = argv.includes('--json');
const HELP = argv.includes('--help') || argv.includes('-h');
const baseIdx = argv.indexOf('--base');
const BASE_ARG = baseIdx >= 0 ? argv[baseIdx + 1] : null;

if (HELP) {
  console.log(
    'check-sibling-patterns.mjs — surface untouched sibling files sharing the\n' +
      'code constructs your branch changed (sibling-class-fix helper, issue #1348).\n\n' +
      'Flags: --base <ref> (default origin/main) · --strict (exit 1 if candidates)\n' +
      '       --json · --help',
  );
  process.exit(0);
}

// Directory di codice funnel-critical da analizzare e cercare. I blob rigenerati
// (data/public/reports/_newsletter_variants/dist) sono ESCLUSI: non sono code da
// sweepare per antipattern (CODE vs DATA, AGENTS.md / ISSUES.md).
const CODE_DIRS = [
  'scripts',
  'build-plugins',
  'services',
  'functions',
  'server',
  'hooks',
  'components',
  '.github/workflows',
];
const EXCLUDE_PATHSPECS = [
  ':(exclude)**/data/**',
  ':(exclude)data/**',
  ':(exclude)public/**',
  ':(exclude)reports/**',
  ':(exclude)_newsletter_variants/**',
  ':(exclude)dist/**',
  ':(exclude)node_modules/**',
];

const isCodeFile = (f) =>
  CODE_DIRS.some((d) => f === d || f.startsWith(d + '/')) &&
  !/(^|\/)(data|public|reports|_newsletter_variants|dist|node_modules)\//.test(f);

// Token troppo comuni per essere segnale di "classe" condivisa: built-in JS/DOM,
// idiomi onnipresenti, env globali. Un match qui non distingue un file gemello.
const STOP = new Set([
  // JS/DOM idioms
  'toString', 'valueOf', 'forEach', 'hasOwnProperty', 'getElementById',
  'querySelector', 'querySelectorAll', 'addEventListener', 'removeEventListener',
  'parseInt', 'parseFloat', 'toISOString', 'toLocaleString', 'toLowerCase',
  'toUpperCase', 'charAt', 'indexOf', 'lastIndexOf', 'includes', 'replaceAll',
  'startsWith', 'endsWith', 'getAttribute', 'setAttribute', 'createElement',
  'appendChild', 'textContent', 'innerHTML', 'getTime', 'getFullYear',
  'stringify', 'execFileSync', 'execSync', 'spawnSync', 'readFileSync',
  'writeFileSync', 'existsSync', 'readdirSync', 'mkdirSync', 'createHash',
  'fileURLToPath', 'dirname', 'basename', 'resolve', 'process', 'console',
  'undefined', 'function', 'require', 'module', 'default', 'constructor',
  'localStorage', 'sessionStorage', 'JSON', 'Promise', 'Object', 'Array',
  'Boolean', 'Number', 'String', 'Symbol', 'Reflect', 'isArray', 'isInteger',
  'fromEntries', 'getOwnPropertyNames', 'setTimeout', 'setInterval',
  // env / common consts
  'GITHUB_TOKEN', 'GITHUB_PAT', 'GH_TOKEN', 'GITHUB_REPOSITORY', 'NODE_ENV',
  'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GITHUB_OUTPUT', 'GITHUB_ENV',
  'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_ACTOR', 'GITHUB_EVENT_NAME',
]);

// Un token che compare in più di MAX_FILES file tracked è troppo generico per
// indicare un file gemello specifico → lo scartiamo (sarebbe solo rumore).
const MAX_FILES = 15;

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

function resolveBase() {
  if (BASE_ARG) return BASE_ARG;
  for (const ref of ['origin/main', 'main']) {
    if (git(['rev-parse', '--verify', '--quiet', ref], { allowFail: true }).trim()) {
      return ref;
    }
  }
  return 'HEAD~1';
}

/**
 * Estrae token distintivi da un blocco di righe diff (contenuto +/-).
 * Tre classi, ciascuna scelta perché identifica un costrutto CONDIVISIBILE tra
 * gemelli (non rumore generico):
 *   - COST SCREAMING_SNAKE (≥1 underscore): es. SPA_BUNDLE_RX, POST_WALK_WORKERS.
 *   - helper camelCase/PascalCase distintivi (≥8 char, mixedCase): es.
 *     truncateSlugAtWordBoundary, resolveSearchConsoleCompatTarget.
 *   - basename kebab-case in import/require (≥1 hyphen): es.
 *     compat-paths-floor-guard, slug-truncate (idiomi condivisi via modulo).
 */
function extractTokens(text) {
  const tokens = new Set();

  // SCREAMING_SNAKE_CASE con almeno un underscore, lunghezza ≥5.
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
    const t = m[0];
    if (t.length >= 5 && !STOP.has(t)) tokens.add(t);
  }

  // camelCase / PascalCase distintivi: ≥8 char, almeno una transizione di case.
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*\b/g)) {
    const t = m[0];
    if (t.length < 8 || STOP.has(t)) continue;
    const mixed = /[a-z][A-Z]/.test(t) || /[A-Z][a-z].*[A-Z]/.test(t);
    if (mixed) tokens.add(t);
  }

  // basename kebab-case in stringhe di import/require/from.
  for (const m of text.matchAll(/['"`][^'"`]*?\/([a-z0-9]+(?:-[a-z0-9]+)+)(?:\.[a-z]+)?['"`]/g)) {
    const t = m[1];
    if (t.length >= 5) tokens.add(t);
  }

  return tokens;
}

function main() {
  const base = resolveBase();
  // merge-base per il three-dot: cambiamenti del branch dalla divergenza.
  const mergeBase =
    git(['merge-base', base, 'HEAD'], { allowFail: true }).trim() || base;

  // Diff del working tree vs base (committed + staged + unstaged): copre tutto
  // ciò che il branch introdurrà, anche se il fixer non ha ancora committato.
  const changedRaw = git(
    ['diff', '--name-only', '--diff-filter=ACMR', mergeBase],
    { allowFail: true },
  );
  const changedAll = changedRaw.split('\n').map((s) => s.trim()).filter(Boolean);
  const changedCode = changedAll.filter(isCodeFile);
  const changedSet = new Set(changedAll);

  if (changedCode.length === 0) {
    const msg =
      'check-sibling-patterns: nessun file di codice funnel-critical cambiato vs ' +
      `${base} — niente da analizzare.`;
    if (JSON_OUT) console.log(JSON.stringify({ base, changedCode: [], candidates: [] }, null, 2));
    else console.log(msg);
    process.exit(0);
  }

  // Raccoglie i token distintivi dalle righe cambiate dei file di codice.
  const tokenToChangedFiles = new Map(); // token -> Set(file che l'ha cambiato)
  for (const file of changedCode) {
    const diff = git(['diff', mergeBase, '--', file], { allowFail: true });
    const touched = diff
      .split('\n')
      .filter((l) => (l.startsWith('+') || l.startsWith('-')) && !/^(\+\+\+|---)/.test(l))
      .map((l) => l.slice(1))
      .join('\n');
    for (const tok of extractTokens(touched)) {
      if (!tokenToChangedFiles.has(tok)) tokenToChangedFiles.set(tok, new Set());
      tokenToChangedFiles.get(tok).add(file);
    }
  }

  if (tokenToChangedFiles.size === 0) {
    const msg =
      'check-sibling-patterns: nessun costrutto distintivo (costante/​helper/​modulo) ' +
      'estratto dalle righe cambiate — niente classe di pattern da sweepare.';
    if (JSON_OUT) console.log(JSON.stringify({ base, changedCode, candidates: [] }, null, 2));
    else console.log(msg);
    process.exit(0);
  }

  // Per ogni token: git grep dei file tracked nei CODE_DIRS; tieni i candidati
  // non toccati dal branch. Scarta i token troppo generici (> MAX_FILES match).
  const candidateTokens = new Map(); // file -> Set(token condiviso)
  const pathspecs = [...CODE_DIRS, ...EXCLUDE_PATHSPECS];
  for (const [tok, srcFiles] of tokenToChangedFiles) {
    const out = git(
      ['grep', '-l', '--fixed-strings', '-e', tok, '--', ...pathspecs],
      { allowFail: true },
    );
    const hits = out.split('\n').map((s) => s.trim()).filter(Boolean);
    if (hits.length > MAX_FILES) continue; // troppo comune → rumore
    for (const f of hits) {
      if (changedSet.has(f)) continue; // già nel branch
      if (!isCodeFile(f)) continue;
      // ignora self-match dei file sorgente del token (sono già changed)
      if (srcFiles.has(f)) continue;
      if (!candidateTokens.has(f)) candidateTokens.set(f, new Set());
      candidateTokens.get(f).add(tok);
    }
  }

  const candidates = [...candidateTokens.entries()]
    .map(([file, toks]) => ({ file, tokens: [...toks].sort() }))
    .sort((a, b) => b.tokens.length - a.tokens.length || a.file.localeCompare(b.file));

  if (JSON_OUT) {
    console.log(JSON.stringify({ base, changedCode, candidates }, null, 2));
    process.exit(STRICT && candidates.length ? 1 : 0);
  }

  console.log(`check-sibling-patterns — base ${base}`);
  console.log(`File di codice cambiati: ${changedCode.length}`);
  if (candidates.length === 0) {
    console.log(
      '✓ Nessun file gemello non-toccato condivide i costrutti modificati. ' +
        'Sweep di classe verosimilmente completo (verifica comunque i casi strutturali ' +
        'che il token-match non cattura, es. guard mancante in un twin).',
    );
    process.exit(0);
  }

  console.log(
    `\n⚠ ${candidates.length} file gemello/i NON toccato/i condivide/ono costrutti che il tuo diff ha modificato.`,
  );
  console.log(
    'Ispeziona ognuno: ha lo STESSO antipattern? → includi il fix nella STESSA PR ' +
      '(AGENTS.md #6) oppure giustificalo in `## Non implementato`.\n',
  );
  for (const c of candidates) {
    console.log(`  ${c.file}`);
    console.log(`      costrutti condivisi: ${c.tokens.join(', ')}`);
  }
  console.log(
    '\nNB: candidate-surfacer euristico — token condivisi ≠ stesso antipattern. ' +
      'Conferma a mano prima di toccare/giustificare.',
  );
  process.exit(STRICT ? 1 : 0);
}

main();
