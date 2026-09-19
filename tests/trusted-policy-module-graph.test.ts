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
