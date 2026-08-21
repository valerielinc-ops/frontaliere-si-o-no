/**
 * fetch-pr-files.mjs — CLI condiviso da `pr-redflag-fixer.yml` e
 * `pr-review-loop.yml` (issue #6233): entrambi reimplementavano in bash la
 * STESSA logica di fallback GraphQL→REST/cap-100 già presente in JS su
 * `pr-collision-detector.mjs` — tre copie tenute allineate a mano. Questo CLI
 * è l'unico chiamante shell dell'algoritmo condiviso in
 * `scripts/ci/lib/fetchPrFiles.mjs`: i due workflow invocano `node
 * scripts/ci/fetch-pr-files.mjs` invece di reimplementare `expected`/`count`/
 * `files_complete` inline.
 *
 * Stdout: una riga JSON `{ expected, count, complete, files }`.
 *   - expected: `changedFiles` dichiarato da GitHub (0 = sconosciuto/fetch fallito)
 *   - files: elenco path (GraphQL, o REST se il fallback è scattato)
 *   - count: files.length
 *   - complete: l'elenco è la lista VERA (non troncata dal cap GraphQL)
 *
 * Uso:  node scripts/ci/fetch-pr-files.mjs --repo <owner/repo> --pr <N>
 */
import { execFileSync } from 'node:child_process';
import { fetchPrFiles } from './lib/fetchPrFiles.mjs';

export function parseArgs(argv) {
  let repo = '';
  let pr = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') repo = argv[++i] || '';
    else if (argv[i] === '--pr') pr = argv[++i] || '';
  }
  return { repo, pr };
}

function gh(args, { json = true, allowFail = false } = {}) {
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return json ? JSON.parse(out) : out;
  } catch (e) {
    if (allowFail) return json ? null : '';
    throw e;
  }
}

/** `changedFiles` come oracolo: 0 vale sia per «PR senza modifiche» sia per
 * «gh non ha risposto» — la stessa ambiguità che `fetchPrFiles` risolve per
 * l'elenco file, qui non serve distinguerla perché `expected=0` fa già
 * ricadere `complete` sul ramo "unknown" (vedi fetchPrFiles.mjs). */
export function fetchExpectedChangedFiles(number, ghFn, repo) {
  try {
    const raw = ghFn(['pr', 'view', String(number), '--repo', repo, '--json', 'changedFiles',
      '--jq', '.changedFiles // 0'], { json: false, allowFail: true }) || '';
    const n = Number.parseInt(String(raw).trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function main() {
  const { repo, pr } = parseArgs(process.argv.slice(2));
  if (!repo || !pr) {
    console.error('Uso: fetch-pr-files.mjs --repo <owner/repo> --pr <N>');
    process.exit(1);
  }
  const expected = fetchExpectedChangedFiles(pr, gh, repo);
  const { files, complete } = fetchPrFiles(Number(pr), expected, gh, repo);
  process.stdout.write(JSON.stringify({ expected, count: files.length, complete, files }));
}

if (process.argv[1]?.endsWith('fetch-pr-files.mjs')) {
  main();
}
