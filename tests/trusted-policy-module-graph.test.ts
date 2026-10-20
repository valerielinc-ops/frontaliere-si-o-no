import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

/**
 * La copia trusted della review policy è un elenco di path scritto a mano, ma
 * `review-gate.mjs` ha un grafo di import. `node --check` prova la sintassi e
 * non la risolvibilità: un modulo nuovo nel grafo che l'elenco non nomina
 * passerebbe il check e morirebbe dentro il gate a runtime. Questi test
 * pinnano il guard che cammina il grafo, e il fatto che lo cammini SENZA
 * eseguire i moduli.
 */
const workflow = YAML.parse(readFileSync('.github/workflows/tests.yml', 'utf8'));

function stepsOf(): { id?: string; run?: string }[] {
  return Object.values(workflow.jobs as Record<string, { steps?: { id?: string; run?: string }[] }>)
    .flatMap((job) => job.steps ?? []);
}

function graphScript(): string {
  const step = stepsOf().find((candidate) => candidate.id === 'review_policy');
  const run = String(step?.run ?? '');
  const open = run.indexOf("<<'GRAPH'\n");
  const close = run.indexOf('\nGRAPH\n');
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return run.slice(open + "<<'GRAPH'\n".length, close);
}

function writeModule(root: string, path: string, source: string) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  return file;
}

function runGraph(script: string, entries: string[]) {
  const scriptFile = join(mkdtempSync(join(tmpdir(), 'graph-')), 'graph.mjs');
  writeFileSync(scriptFile, script);
  try {
    const stdout = execFileSync(process.execPath, [scriptFile, ...entries], { encoding: 'utf8' });
    return { ok: true, output: stdout };
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string };
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('guard del grafo di import della copia trusted', () => {
  it('ogni passo che scarica la policy scarica anche i moduli opzionali e cammina il grafo', () => {
    const downloaders = stepsOf().filter((step) => String(step.run ?? '').includes('download_main'));
    expect(downloaders.length).toBeGreaterThanOrEqual(2);
    const withGate = downloaders.filter((step) =>
      String(step.run).includes('scripts/ci/review-gate.mjs'));
    expect(withGate.length).toBeGreaterThanOrEqual(2);
    for (const step of withGate) {
      const run = String(step.run);
      expect(run).toContain('download_optional');
      expect(run).toContain('scripts/ci/lib/review-findings.mjs');
      expect(run).toContain('scripts/ci/followup-resolution-match.mjs');
      expect(run).toContain('trusted-module-graph.mjs');
    }
  });

  it('non usa `import()` per provare il grafo: eseguirebbe i moduli', () => {
    // `isDirectRun` confronta `process.argv[1]`: importare un modulo passandogli
    // il proprio path lo fa PARTIRE (run 35473808729, il gate ha chiamato
    // `gh api .../pulls/` e ha risposto 404).
    for (const step of stepsOf()) {
      const run = String(step.run ?? '');
      if (!run.includes('trusted-module-graph.mjs')) continue;
      expect(run).not.toMatch(/await import\(process\.argv\[1\]\)/u);
    }
    expect(graphScript()).not.toMatch(/\bawait\s+import\(/u);
  });

  it('fallisce e nomina il modulo mancante', () => {
    const root = mkdtempSync(join(tmpdir(), 'policy-'));
    const entry = writeModule(root, 'scripts/ci/review-gate.mjs',
      "import { x } from './lib/review-findings.mjs';\nexport const gate = x;\n");
    const result = runGraph(graphScript(), [entry]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('review-findings.mjs');
  });

  it('passa quando il modulo è presente, e conta i moduli risolti', () => {
    const root = mkdtempSync(join(tmpdir(), 'policy-'));
    const entry = writeModule(root, 'scripts/ci/review-gate.mjs',
      "import { x } from './lib/review-findings.mjs';\nexport const gate = x;\n");
    writeModule(root, 'scripts/ci/lib/review-findings.mjs',
      "import { y } from '../followup-resolution-match.mjs';\nexport const x = y;\n");
    writeModule(root, 'scripts/ci/followup-resolution-match.mjs', 'export const y = 1;\n');
    const result = runGraph(graphScript(), [entry]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('3 moduli risolti');
  });

  it('non esegue il modulo che ispeziona', () => {
    const root = mkdtempSync(join(tmpdir(), 'policy-'));
    const marker = join(root, 'eseguito.txt');
    const entry = writeModule(root, 'scripts/ci/review-gate.mjs',
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'boom');\n`);
    const result = runGraph(graphScript(), [entry]);
    expect(result.ok).toBe(true);
    expect(() => readFileSync(marker, 'utf8')).toThrow();
  });
});

/**
 * Il CLI trusted è risolto PRIMA del checkout proprio perché dopo il checkout
 * `PATH` è influenzabile dal codice della PR (npm lifecycle compreso). Una
 * hardening che si ferma ai soli step di download lascia la DECISIONE della
 * review — chi risolve la PR, il guard di re-review, il tier, il prefetch, il
 * marker — a chiamare `gh` per PATH: è il 🔴 della review su #9313.
 */
describe('ogni step che decide la review usa il CLI trusted', () => {
  // `head_watch` NON è in elenco di proposito: parte PRIMA del checkout, dove
  // `PATH` è ancora quello del runner — la stessa ragione per cui `trusted_gh`
  // può risolvere il binario proprio lì. Il rischio che questa lista copre è
  // il codice della PR e i lifecycle hook di npm, che esistono solo dopo.
  const REVIEW_DECISION_STEPS = [
    'corpus',
    'resolve',
    'review_input',
    'guard',
    'tier',
    'prefetch',
    'review_abort',
    'review_marker',
    'review_policy',
    'review_policy_final',
  ];
  const BARE_GH_RE = /(?<![\w"/$.-])gh (?:api|pr|run|workflow) /u;

  function stepById(id: string) {
    const step = stepsOf().find((candidate) => candidate.id === id) as
      { id?: string; run?: string; env?: Record<string, string> } | undefined;
    expect(step, `step ${id} assente da tests.yml`).toBeTruthy();
    return step!;
  }

  it.each(REVIEW_DECISION_STEPS)('%s riceve TRUSTED_GH_BIN', (id) => {
    const env = stepById(id).env ?? {};
    expect(Object.keys(env)).toContain('TRUSTED_GH_BIN');
    expect(String(env.TRUSTED_GH_BIN)).toContain('steps.trusted_gh.outputs.path');
  });

  it.each(REVIEW_DECISION_STEPS)('%s non invoca mai un `gh` risolto per PATH', (id) => {
    const bare = String(stepById(id).run ?? '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .filter((line) => BARE_GH_RE.test(line));
    expect(bare, `invocazioni gh non trusted in ${id}:\n${bare.join('\n')}`).toEqual([]);
  });

  it('il CLI trusted è risolto prima del checkout', () => {
    const steps = stepsOf() as { id?: string; uses?: string }[];
    const trusted = steps.findIndex((step) => step.id === 'trusted_gh');
    const checkout = steps.findIndex((step) => String(step.uses ?? '').startsWith('actions/checkout'));
    expect(trusted).toBeGreaterThan(-1);
    expect(checkout).toBeGreaterThan(-1);
    expect(trusted).toBeLessThan(checkout);
  });
});

/**
 * Il guard runtime qui sopra cammina il grafo della copia scaricata DA MAIN:
 * una PR che aggiunge un import a un modulo trusted resta verde, e il rosso
 * compare solo dopo il merge, su ogni PR successiva. È successo con #9887:
 * `scripts/ci/claude-codex-fallback.mjs` ha iniziato a importare
 * `scripts/lib/codex-fallback-contract.mjs`, che nessun elenco di `tests.yml`
 * scaricava (run 36152537527: «moduli mancanti nella copia trusted»). Questo
 * test chiude il buco prima del merge: per ogni step che scarica file trusted,
 * l'insieme scaricato deve essere chiuso rispetto agli import relativi reali
 * del repo (stessa regex del guard runtime).
 */
const TRUSTED_SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*)(['"])(\.[^'"]+)\1/gu;

export function downloadedTrustedPaths(run: string): Set<string> {
  const paths = new Set<string>();
  for (const match of run.matchAll(/\bdownload_(?:main|optional) ([\w.-]+\/[\w./-]+\.(?:m?js|cjs))\b/gu)) {
    paths.add(match[1]);
  }
  const loops = run.matchAll(
    /for (\w+) in \\\n((?:[ \t]*\S+[ \t]*\\\n)*[ \t]*\S+?);[ \t]*do\n[ \t]*download_(?:main|optional) "\$\1"/gu,
  );
  for (const loop of loops) {
    for (const item of loop[2].split(/\\\n/u)) {
      const path = item.trim();
      if (/^[\w.-]+\/[\w./-]+\.(?:m?js|cjs)$/u.test(path)) paths.add(path);
    }
  }
  return paths;
}

function unresolvedTrustedImports(downloaded: Set<string>): string[] {
  const missing: string[] = [];
  for (const file of downloaded) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue; // opzionale e non ancora su main: il guard runtime lo tratta a parte
    }
    for (const match of source.matchAll(TRUSTED_SPEC_RE)) {
      const target = join(dirname(file), match[2]).replace(/\\/gu, '/');
      if (!downloaded.has(target)) missing.push(`${file} → ${target}`);
    }
  }
  return [...new Set(missing)].sort();
}

describe('gli elenchi trusted di tests.yml sono chiusi rispetto agli import del repo', () => {
  const steps = stepsOf().filter((step) => /\bdownload_main\b/u.test(String(step.run ?? '')));

  it('trova gli step che scaricano la policy trusted (non vacuo)', () => {
    expect(steps.length).toBeGreaterThanOrEqual(3);
    for (const step of steps) {
      expect(downloadedTrustedPaths(String(step.run)).size, `step ${step.id}`).toBeGreaterThan(0);
    }
  });

  it.each(steps.map((step) => [step.id ?? '(senza id)', step] as const))(
    '%s scarica ogni modulo importato dai file che scarica',
    (_id, step) => {
      const missing = unresolvedTrustedImports(downloadedTrustedPaths(String(step.run)));
      expect(missing, 'moduli importati ma non scaricati nella copia trusted').toEqual([]);
    },
  );

  it('legge sia le righe download_main sia i cicli `for … in … do download_main`', () => {
    const run = [
      'download_main scripts/ci/a.mjs "$policy_root/scripts/ci/a.mjs"',
      'for trusted_path in \\',
      '  scripts/ci/b.mjs \\',
      '  scripts/lib/c.mjs; do',
      '  download_main "$trusted_path"',
      'done',
    ].join('\n');
    expect([...downloadedTrustedPaths(run)].sort()).toEqual([
      'scripts/ci/a.mjs',
      'scripts/ci/b.mjs',
      'scripts/lib/c.mjs',
    ]);
  });
});
