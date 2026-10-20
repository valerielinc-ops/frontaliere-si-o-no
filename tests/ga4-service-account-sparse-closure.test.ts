import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
// Import reale, non decorativo: e' l'arco che fa scegliere questo test alla
// selezione related (scripts/ci/run-related-tests.mjs) quando cambia l'helper o
// uno dei moduli che importa. I workflow li collega il letterale della
// directory qui sotto, che il runner indicizza.
import { PRODUCTION_HOST_REGEXP, productionAppErrorFilter } from '../scripts/lib/ga4-service-account.mjs';

// scripts/lib/ga4-service-account.mjs e' elencato FILE PER FILE nello
// sparse-checkout dei workflow dei loop e di alcuni monitor. Un import nuovo da
// quel file verso un modulo che gli elenchi non nominano li rompe tutti a
// runtime con ERR_MODULE_NOT_FOUND, e nessun import statico collega la modifica
// ai workflow. Il 2026-10-03 una PR gli ha fatto importare
// scripts/lib/app-error-recency.mjs: solo l'exporter L8 aveva un test che lo
// caricava dal proprio elenco, gli altri workflow sarebbero caduti in
// produzione. Qui la domanda si ripone per tutti a ogni modifica dell'helper.

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github/workflows');
const HELPER = 'scripts/lib/ga4-service-account.mjs';

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"`;]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

function relativeImports(repoPath: string): string[] {
  const source = fs.readFileSync(path.join(ROOT, repoPath), 'utf8');
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2];
    found.push(path.posix.normalize(path.posix.join(path.posix.dirname(repoPath), specifier)));
  }
  return found;
}

function importClosure(entry: string): string[] {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length) {
    const current = queue.shift() as string;
    for (const next of relativeImports(current)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen];
}

type SparseList = { workflow: string; job: string; entries: string[] };

function sparseLists(): SparseList[] {
  const lists: SparseList[] = [];
  for (const name of fs.readdirSync(WORKFLOWS_DIR).filter((file) => /\.ya?ml$/.test(file)).sort()) {
    const doc = YAML.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8'));
    for (const [job, spec] of Object.entries<any>(doc?.jobs ?? {})) {
      for (const step of spec?.steps ?? []) {
        const sparse = step?.with?.['sparse-checkout'];
        if (typeof sparse !== 'string') continue;
        const entries = sparse
          .split('\n')
          .map((line) => line.trim().replace(/^\//, '').replace(/\/$/, ''))
          .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'));
        lists.push({ workflow: name, job, entries });
      }
    }
  }
  return lists;
}

/** Un elenco copre un file se lo nomina, nomina una sua directory o un glob che lo prende. */
function covers(entries: string[], file: string): boolean {
  return entries.some((entry) => {
    if (entry === file || file.startsWith(`${entry}/`)) return true;
    if (!entry.includes('*')) return false;
    const pattern = entry
      .split('**')
      .map((part) => part.split('*').map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
      .join('.*');
    return new RegExp(`^${pattern}$`).test(file);
  });
}

describe('sparse-checkout dei workflow che elencano ga4-service-account.mjs', () => {
  const closure = importClosure(HELPER);
  const listingHelper = sparseLists().filter((list) => list.entries.includes(HELPER));

  it("la chiusura degli import dell'helper esiste davvero sul disco", () => {
    expect(closure).toContain(HELPER);
    for (const file of closure) {
      expect(fs.existsSync(path.join(ROOT, file)), `import non risolto dalla chiusura: ${file}`).toBe(true);
    }
  });

  it("il filtro di produzione appartiene all'helper, che non importa il modulo di funzionalita'", () => {
    expect(typeof productionAppErrorFilter).toBe('function');
    expect(new RegExp(PRODUCTION_HOST_REGEXP).test('frontaliereticino.ch')).toBe(true);
    expect(closure).not.toContain('scripts/lib/app-error-recency.mjs');
  });

  it("almeno un workflow elenca l'helper file per file (altrimenti questo test non misura niente)", () => {
    expect(listingHelper.length).toBeGreaterThan(0);
  });

  it("ogni elenco che nomina l'helper copre tutta la chiusura dei suoi import", () => {
    const missing: string[] = [];
    for (const list of listingHelper) {
      for (const file of closure) {
        if (!covers(list.entries, file)) missing.push(`${list.workflow} (${list.job}): manca ${file}`);
      }
    }
    // Se questo elenco non e' vuoto, la correzione giusta di solito NON e'
    // allungare gli sparse-checkout: e' togliere l'import dall'helper e
    // invertire la dipendenza (il modulo di funzionalita' importa l'helper).
    expect(missing).toEqual([]);
  });

  it('riconosce un elenco che non copre un import (controllo del controllo)', () => {
    const fake = ['scripts/lib/ga4-service-account.mjs', 'scripts/ci'];
    expect(covers(fake, 'scripts/lib/ga4-service-account.mjs')).toBe(true);
    expect(covers(fake, 'scripts/ci/export-loop-outcomes.mjs')).toBe(true);
    expect(covers(fake, 'scripts/lib/app-error-recency.mjs')).toBe(false);
    expect(covers(['scripts/lib/*.mjs'], 'scripts/lib/app-error-recency.mjs')).toBe(true);
    expect(covers(['scripts/lib/*.mjs'], 'scripts/lib/nested/x.mjs')).toBe(false);
    expect(covers(['scripts/**'], 'scripts/lib/nested/x.mjs')).toBe(true);
  });
});
