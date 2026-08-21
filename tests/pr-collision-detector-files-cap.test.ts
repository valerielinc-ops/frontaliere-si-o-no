/**
 * pr-collision-detector: l'elenco file di una PR, e SOPRATTUTTO se e' completo.
 *
 * `gh pr view --json files` interroga la connection GraphQL `files(first: 100)`
 * e non pagina. Le modalita' sono TRE, non due, e la #6190 ne copriva una sola
 * perche' keyava il fallback sulla lista VUOTA:
 *
 *   <= 100     completa
 *   101..N     troncata a 100, in ordine alfabetico, exit 0, NON vuota
 *   oversize   `.files: null`
 *
 * Misurato il 2026-08-20 su questo repo: #6121 (changedFiles=183) → GraphQL
 * 100, REST `--paginate` 183/183; #6175 (oversize) → GraphQL null, REST 100.
 * Nella banda di mezzo la REST e' completa, quindi il campione non era un male
 * necessario ma una chiamata non fatta.
 *
 * Il fetch viveva inline in `main()`, e per questo il cap a 100 e' passato
 * senza copertura: qui e' una funzione pura con `gh` iniettato.
 */
import { describe, it, expect } from 'vitest';
import { fetchPrFiles, GRAPHQL_FILES_CAP } from '../scripts/ci/pr-collision-detector.mjs';

/** `gh` finto: risponde in base al primo argomento (`pr` = GraphQL, `api` = REST). */
function fakeGh({ graphql, rest }: { graphql?: unknown; rest?: string | Error }) {
  const calls: string[] = [];
  const fn = (args: string[], opts: { json?: boolean } = {}) => {
    calls.push(args[0]);
    if (args[0] === 'pr') {
      if (graphql instanceof Error) throw graphql;
      return graphql ?? [];
    }
    if (rest instanceof Error) throw rest;
    return rest ?? '';
  };
  return { fn, calls };
}

const listOf = (n: number, prefix = 'a/f') =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, '0')}.ts`);

describe('fetchPrFiles — le tre modalita di gh pr view --json files', () => {
  it('<=100 file: usa GraphQL e NON chiama la REST', () => {
    const { fn, calls } = fakeGh({ graphql: listOf(12), rest: 'non-deve-servire\n' });
    const { files, complete } = fetchPrFiles(1, 12, fn as never, 'o/r');
    expect(files).toHaveLength(12);
    expect(complete).toBe(true);
    expect(calls).toEqual(['pr']);
  });

  it('TRONCATA a 100 con 183 attesi: il fallback parte e la REST vince (era il buco della #6190)', () => {
    const { fn, calls } = fakeGh({
      graphql: listOf(GRAPHQL_FILES_CAP),
      rest: `${listOf(183).join('\n')}\n`,
    });
    const { files, complete } = fetchPrFiles(6121, 183, fn as never, 'o/r');
    expect(files).toHaveLength(183);
    expect(complete).toBe(true);
    expect(calls).toEqual(['pr', 'api']);
  });

  it('lista NON vuota ma piu corta degli attesi: fallback anche sotto il cap', () => {
    const { fn } = fakeGh({ graphql: listOf(40), rest: `${listOf(57).join('\n')}\n` });
    const { files, complete } = fetchPrFiles(2, 57, fn as never, 'o/r');
    expect(files).toHaveLength(57);
    expect(complete).toBe(true);
  });

  it('oversize (`.files: null` → []) con REST troncata: campione, e complete=false', () => {
    const { fn, calls } = fakeGh({ graphql: [], rest: `${listOf(100).join('\n')}\n` });
    // changedFiles=0 e' cio' che GitHub riporta sul diff oversize: 0 dichiarati
    // ma file veri. Non e' una PR vuota.
    const { files, complete } = fetchPrFiles(6175, 0, fn as never, 'o/r');
    expect(files).toHaveLength(100);
    expect(complete).toBe(false);
    expect(calls).toEqual(['pr', 'api']);
  });

  it('PR rebase-only: 0 attesi e 0 trovati → completa, non «sconosciuta»', () => {
    const { fn } = fakeGh({ graphql: [], rest: '' });
    const { files, complete } = fetchPrFiles(3, 0, fn as never, 'o/r');
    expect(files).toEqual([]);
    expect(complete).toBe(true);
  });

  it('REST che esplode: tiene la lista GraphQL e la dichiara incompleta', () => {
    const { fn } = fakeGh({ graphql: listOf(GRAPHQL_FILES_CAP), rest: new Error('rate limit') });
    const { files, complete } = fetchPrFiles(4, 183, fn as never, 'o/r');
    expect(files).toHaveLength(GRAPHQL_FILES_CAP);
    expect(complete).toBe(false);
  });

  it('entrambe le sorgenti a vuoto con file attesi: complete=false, non un vuoto credibile', () => {
    const { fn } = fakeGh({ graphql: [], rest: '' });
    const { files, complete } = fetchPrFiles(5, 9, fn as never, 'o/r');
    expect(files).toEqual([]);
    expect(complete).toBe(false);
  });

  it('changedFiles assente (campo non chiesto) con file trovati: complete=false', () => {
    const { fn } = fakeGh({ graphql: listOf(3), rest: '' });
    const { complete } = fetchPrFiles(6, undefined as never, fn as never, 'o/r');
    expect(complete).toBe(false);
  });

  it('la REST non vince mai se restituisce MENO file di GraphQL', () => {
    const { fn } = fakeGh({ graphql: listOf(GRAPHQL_FILES_CAP), rest: 'solo/uno.ts\n' });
    const { files } = fetchPrFiles(8, 183, fn as never, 'o/r');
    expect(files).toHaveLength(GRAPHQL_FILES_CAP);
  });

  it('righe vuote e spazi nella REST non diventano path', () => {
    const { fn } = fakeGh({ graphql: [], rest: '  a.ts  \n\n b.ts\n   \n' });
    const { files } = fetchPrFiles(9, 2, fn as never, 'o/r');
    expect(files).toEqual(['a.ts', 'b.ts']);
  });
});
