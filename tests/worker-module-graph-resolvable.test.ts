import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';

/**
 * Preflight statico sul grafo dei worker (#5131).
 *
 * I plugin di build girano in due mondi con REGOLE DI RISOLUZIONE DIVERSE:
 *
 *  - main thread → Vite risolve gli specifier, e uno specifier relativo senza
 *    estensione (`./foo`, `../packages/articles/engine/foo`) funziona;
 *  - dentro un `worker_thread` → Node ESM puro (+ tsx come loader). Lì un deep
 *    specifier senza estensione NON risolve, e `packages/articles` è per giunta
 *    un package `"type": "module"` a sé.
 *
 * Il risultato è un guasto che non si vede finché il build non ci arriva. È già
 * successo: `flatHtmlRedirectPlugin.ts` importava
 * `../packages/articles/engine/flatHtmlRedirect` senza estensione e il build è
 * morto con ERR_MODULE_NOT_FOUND **dentro post-walk-coordinator, a ~68 minuti**
 * dall'inizio dello step (run 30909956797 e le 3 failure consecutive
 * 30897951299 / 30884117744 / 30870925311 — tutti e 4 i locale insieme, cioè
 * deterministico, non OOM). Decine di ore-runner bruciate per un errore
 * decidibile in millisecondi a build ferma.
 *
 * Questo test cammina il grafo a partire dagli entrypoint worker e verifica che
 * ogni specifier relativo (a) porti un'estensione esplicita e (b) esista su
 * disco. Costa millisecondi e gira su ogni PR, quindi l'errore che prima
 * arrivava a T+68min arriva a T+0.
 *
 * NB: il guard è deliberatamente ristretto al grafo RAGGIUNGIBILE DAI WORKER.
 * Altrove nei build-plugin gli import extensionless sono legittimi — li risolve
 * Vite. Allargare la regola a tutto `build-plugins/` sarebbe churn senza
 * invariante dietro.
 */

const ROOT = resolve(import.meta.dirname, '..');
const BUILD_PLUGINS = resolve(ROOT, 'build-plugins');

// Estensioni che Node ESM (+ tsx) accetta come specifier esplicito.
const EXPLICIT_EXT = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|json)$/;

/**
 * Entrypoint worker = un modulo che gira DENTRO il thread, non quello che lo
 * spawna. La distinzione sta in cosa importa da `node:worker_threads`:
 *
 *   entrypoint  → `import { parentPort, workerData } from 'node:worker_threads'`
 *   coordinator → `import { Worker } from 'node:worker_threads'` (main thread)
 *
 * Cercare solo il nome `workerData` nel sorgente NON basta: i coordinator lo
 * passano come chiave di option a `new Worker(url, { workerData })`, e
 * `jobsSeoPagesPlugin.ts` finiva così classificato come entrypoint, trascinando
 * nel grafo mezzo build-plugins (dove gli specifier extensionless sono
 * legittimi, perché li risolve Vite). Qui si guarda la LISTA di named import.
 */
function findWorkerEntrypoints(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(mjs|ts)$/.test(entry)) continue;
      const src = readFileSync(full, 'utf-8');
      const m = src.match(/import\s*\{([^}]*)\}\s*from\s*['"]node:worker_threads['"]/);
      if (!m) continue;
      const named = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim());
      // `parentPort` è il canale verso il parent: solo chi gira nel thread lo usa.
      if (named.includes('parentPort')) out.push(full);
    }
  };
  walk(BUILD_PLUGINS);
  return out.sort();
}

/**
 * Specifier relativi con la posizione, saltando gli import TYPE-ONLY (`import
 * type ... from`, `export type ... from`): tsx li cancella, non esistono a
 * runtime, quindi non devono risolvere.
 */
function relativeSpecifiers(src: string): { spec: string; line: number }[] {
  const found: { spec: string; line: number }[] = [];
  const lines = src.split('\n');
  // Comment-aware, come già fa `ci-vitest-check-name.test.ts`: in questo repo i
  // docblock DESCRIVONO spesso gli import (`flatHtmlRedirectPlugin.ts` racconta
  // nel commento proprio lo specifier che causò l'incidente). Un match dentro un
  // commento sarebbe un falso positivo che blocca una PR estranea — cioè
  // esattamente il danno che questo guard esiste per evitare. I commenti sono
  // sostituiti con spazi, non rimossi, così gli offset restano validi e la riga
  // riportata resta quella vera.
  const blanked = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  // `from '...'` (import/export statici) e `import('...')` (dinamici). Il
  // specifier può stare su una riga diversa dalla keyword (import multilinea),
  // quindi si lavora sul sorgente intero e si risale alla riga per offset.
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
  src = blanked;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue; // bare package o node: builtin
    const line = src.slice(0, m.index).split('\n').length;
    // Type-only: guarda l'inizio dello statement, non la riga del specifier.
    const stmtStart = Math.max(src.lastIndexOf('import', m.index), src.lastIndexOf('export', m.index));
    const head = src.slice(stmtStart, m.index);
    if (/^(import|export)\s+type\b/.test(head)) continue;
    found.push({ spec, line });
    void lines;
  }
  return found;
}

/** Risolve uno specifier ESPLICITO relativo a `fromFile`. */
function resolveExplicit(fromFile: string, spec: string): string {
  return resolve(dirname(fromFile), spec);
}

interface Violation {
  file: string;
  line: number;
  spec: string;
  reason: string;
}

/** BFS sul grafo, raccogliendo violazioni. Segue solo gli specifier risolvibili. */
function walkWorkerGraph(entrypoints: string[]): { visited: Set<string>; violations: Violation[] } {
  const visited = new Set<string>();
  const violations: Violation[] = [];
  const queue = [...entrypoints];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    if (!existsSync(file)) continue;

    const src = readFileSync(file, 'utf-8');
    for (const { spec, line } of relativeSpecifiers(src)) {
      const rel = relative(ROOT, file);
      if (!EXPLICIT_EXT.test(spec)) {
        violations.push({
          file: rel,
          line,
          spec,
          reason:
            'specifier relativo SENZA estensione esplicita: risolve sotto Vite sul main ' +
            'thread ma NON dentro un worker_thread (Node ESM puro) → ERR_MODULE_NOT_FOUND ' +
            'a build quasi finita. Aggiungi l\'estensione (es. "' + spec + '.ts").',
        });
        continue; // non risolvibile in modo affidabile → non seguirlo
      }
      const target = resolveExplicit(file, spec);
      if (!existsSync(target)) {
        // Worktree sparse (gli agent lavorano con `git sparse-checkout` perché
        // un worktree pieno costa 3,7 GB): una cartella top-level non
        // materializzata NON è un import rotto. In CI il checkout è completo,
        // quindi lì il ramo non scatta mai e il controllo resta pieno.
        const topLevel = relative(ROOT, target).split('/')[0];
        if (topLevel && !existsSync(join(ROOT, topLevel))) continue;
        violations.push({
          file: rel,
          line,
          spec,
          reason: `il target non esiste su disco (atteso: ${relative(ROOT, target)})`,
        });
        continue;
      }
      queue.push(target);
    }
  }
  return { visited, violations };
}

describe('grafo moduli dei worker: risolvibile sotto Node ESM (#5131)', () => {
  const entrypoints = findWorkerEntrypoints();

  it('trova almeno un entrypoint worker (il guard non passa a vuoto)', () => {
    expect(
      entrypoints.length,
      'nessun entrypoint worker trovato sotto build-plugins/ — la discovery si è rotta ' +
        'e questo test starebbe verificando il nulla',
    ).toBeGreaterThan(0);
    // postWalkWorker.mjs è quello che ha causato l'incidente: se sparisce dalla
    // discovery, il guard ha smesso di coprire il caso noto.
    expect(entrypoints.map((f) => relative(ROOT, f))).toContain('build-plugins/postWalkWorker.mjs');
  });

  it('ogni specifier relativo nel grafo dei worker porta un\'estensione esplicita e risolve', () => {
    const { violations } = walkWorkerGraph(entrypoints);
    const report = violations.map((v) => `  ${v.file}:${v.line}  '${v.spec}'\n      → ${v.reason}`).join('\n');
    expect(violations, violations.length ? `\nViolazioni nel grafo worker:\n${report}\n` : '').toEqual([]);
  });

  it('il grafo attraversa davvero il confine build-plugins → packages/articles', () => {
    // Regressione del caso reale: postWalkWorker importa
    // ../packages/articles/engine/shared/contextualLinkInjector.ts, e
    // flatHtmlRedirectPlugin.ts importa .../engine/flatHtmlRedirect.ts. Se il
    // walk smettesse di attraversare quel confine il test resterebbe verde
    // senza coprire la classe che ha causato l'incidente.
    const { visited } = walkWorkerGraph(entrypoints);
    const crossed = [...visited]
      .map((f) => relative(ROOT, f))
      .filter((f) => f.startsWith('packages/articles/'));
    expect(
      crossed.length,
      'il grafo worker non raggiunge più packages/articles — verifica la discovery prima ' +
        'di considerare questo test significativo',
    ).toBeGreaterThan(0);
  });
});
