/**
 * Il checkout del job `vitest (unit + integration)` e' treeless (`filter: tree:0`,
 * `fetch-depth: 0`): tutti i commit, nessun tree storico. Le operazioni che
 * servono al job (merge-base, `rev-list --count`, diff fra due commit,
 * `merge-tree`, `git merge` e push dell'autorebase) leggono pochi tree e li
 * scaricano pigri a lotti. Una storia PER PATH (`git log -- <path>`,
 * `rev-list ... -- <path>`, `blame`) invece deve aprire il tree di ogni commit
 * visitato, e ogni tree mancante e' un fetch: misurato su un clone treeless di
 * questo repo, `git log -3 -- data/slug-registry.json` = 186 fetch in 120 s,
 * senza finire.
 *
 * Questo test tiene quel vincolo sugli script che il workflow esegue, e sulla
 * chiusura dei loro import relativi. E' un'analisi statica: se uno script
 * nuovo ne ha bisogno davvero, la risposta e' portarlo fuori da questo job o
 * dargli un checkout suo, non tornare a `blob:none`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const TESTS_YML = readFileSync(resolve(ROOT, '.github/workflows/tests.yml'), 'utf-8');
const steps: any[] = (YAML.parse(TESTS_YML) as any).jobs.vitest.steps;

// Storia per path: un comando di storia seguito, nella stessa riga/array, da
// un separatore `--` di pathspec.
const PATH_HISTORY_PATTERNS = [
  /git\s+(?:-C\s+\S+\s+)?(?:log|rev-list|blame|shortlog)\b[^\n;|&]*\s--\s/,
  /\[\s*'(?:log|rev-list|blame|shortlog)'[^\]]*'--'/,
  /\[\s*"(?:log|rev-list|blame|shortlog)"[^\]]*"--"/,
  /git\s+(?:-C\s+\S+\s+)?blame\b/,
  /\[\s*'blame'/,
];

// File importati dal job che CONTENGONO una storia per path ma non la eseguono
// nel job: la funzione sta dietro al guard `isInvokedDirectly` della CLI e il
// job ne importa solo gli helper esportati. Ogni voce porta il motivo; una
// voce che non serve piu' fa fallire il test (niente allowlist stantie).
const CLI_ONLY_HISTORY: Record<string, string> = {
  'scripts/backfill-prev-slugs-from-loss-events.mjs':
    '`buildFileLocaleIndex` (git log -- <slice>) non e` esportata e la chiama solo il main della CLI; ' +
    'slug-preservation-guard importa gli helper puri (denylist, recovery target).',
};

function invokedScripts(): string[] {
  const found = new Set<string>();
  for (const step of steps) {
    const run = typeof step.run === 'string' ? step.run : '';
    for (const m of run.matchAll(/\bscripts\/[A-Za-z0-9_./-]+\.(?:mjs|js|cjs|sh|ts)\b/g)) found.add(m[0]);
  }
  // `npm run <script>` degli step: risolti via package.json.
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
  for (const step of steps) {
    const run = typeof step.run === 'string' ? step.run : '';
    for (const m of run.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
      const cmd = String(pkg.scripts?.[m[1]] ?? '');
      for (const s of cmd.matchAll(/\bscripts\/[A-Za-z0-9_./-]+\.(?:mjs|js|cjs|sh|ts)\b/g)) found.add(s[0]);
    }
  }
  return [...found].filter((p) => existsSync(resolve(ROOT, p))).sort();
}

function importClosure(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = entries.map((e) => resolve(ROOT, e));
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    if (!/\.(mjs|js|cjs|ts)$/.test(file)) continue;
    const src = readFileSync(file, 'utf-8');
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), m[1]);
      for (const candidate of [target, `${target}.mjs`, `${target}.js`, `${target}.ts`]) {
        if (existsSync(candidate) && /\.(mjs|js|cjs|ts)$/.test(candidate)) {
          queue.push(candidate);
          break;
        }
      }
    }
  }
  return [...seen].map((f) => relative(ROOT, f)).sort();
}

/** Toglie i commenti di riga e di blocco, cosi' la prosa non conta. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|#|\*)/.test(line))
    .join('\n');
}

describe('tests.yml: checkout treeless', () => {
  it('il checkout principale e` treeless con la storia completa dei commit', () => {
    const checkout = steps.find((s) => s.uses === 'actions/checkout@v5' && !s.with?.path);
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(checkout?.with?.filter).toBe('tree:0');
  });

  it('gli step inline non chiedono una storia per path', () => {
    for (const step of steps) {
      const run = typeof step.run === 'string' ? code(step.run) : '';
      for (const re of PATH_HISTORY_PATTERNS) expect(re.test(run), `${step.name}: ${re}`).toBe(false);
    }
  });

  it('gli script eseguiti dal job (e i loro import) non chiedono una storia per path', () => {
    const scripts = invokedScripts();
    // Pavimento indipendente dal conteggio: se l'estrazione si rompe e trova
    // zero script, il test deve fallire, non passare a vuoto.
    expect(scripts).toContain('scripts/ci/pr-autorebase.mjs');
    expect(scripts).toContain('scripts/ci/run-related-tests.mjs');
    expect(scripts).toContain('scripts/ci/check-sibling-patterns.mjs');
    const offenders: string[] = [];
    const allowlistedSeen = new Set<string>();
    for (const file of importClosure(scripts)) {
      const src = code(readFileSync(resolve(ROOT, file), 'utf-8'));
      if (!PATH_HISTORY_PATTERNS.some((re) => re.test(src))) continue;
      if (CLI_ONLY_HISTORY[file]) {
        allowlistedSeen.add(file);
        continue;
      }
      offenders.push(file);
    }
    expect(offenders).toEqual([]);
    expect([...allowlistedSeen].sort()).toEqual(Object.keys(CLI_ONLY_HISTORY).sort());
  });

  it('il pattern riconosce le forme reali di storia per path', () => {
    const hit = (s: string) => PATH_HISTORY_PATTERNS.some((re) => re.test(s));
    expect(hit('git log -1 --format=%H -- data/jobs/by-crawler')).toBe(true);
    expect(hit("runGit(['rev-list', '--count', 'HEAD', '--', dir])")).toBe(true);
    expect(hit('git -C repo log --oneline -- file')).toBe(true);
    expect(hit("git(['merge-base', 'HEAD', 'origin/main'])")).toBe(false);
    expect(hit('git rev-list --count base..HEAD')).toBe(false);
    expect(hit('git diff --name-only "$base" HEAD')).toBe(false);
  });
});
