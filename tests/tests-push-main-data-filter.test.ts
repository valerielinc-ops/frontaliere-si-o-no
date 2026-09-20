import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

/**
 * `tests.yml` era l'UNICO dei 28 workflow con `push: branches: [main]` a girare
 * senza filtro di path. Misura del 2026-09-19 su 24 h: 288 delle sue 631 run
 * nascono da un push su `main` (45,6%), ~10,7 minuti l'una, mentre 198 dei 333
 * commit di quella giornata (59,5%) non toccano una riga di codice — sono i
 * payload che i cron riversano in `data/`. Con un tetto di account di 20-22 job
 * insieme, quelle run tolgono slot alla coda che serve le PR.
 *
 * Questo file tiene insieme le DUE meta' della scelta, perche' separate sono
 * entrambe pericolose:
 *
 *  1. il filtro non deve poter ingoiare codice — `data/` contiene 32 moduli
 *     TypeScript veri, quindi un `data/**` secco avrebbe spento i test proprio
 *     dove servono;
 *  2. quello che `tests.yml` smette di guardare deve restare guardato da un
 *     altro workflow sullo STESSO evento — qui `guard-data-integrity.yml`.
 */

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOWS = resolve(ROOT, '.github/workflows');

const load = (name: string) => YAML.parse(readFileSync(resolve(WORKFLOWS, name), 'utf8'));

const TESTS = load('tests.yml');
const GUARD = load('guard-data-integrity.yml');

/** `on` in YAML è il booleano `true` quando non è quotato. */
const on = (doc: any) => doc.on ?? doc[true as unknown as string] ?? doc[true];

const IGNORED: string[] = on(TESTS).push['paths-ignore'];

/** Estensioni che portano comportamento: se una finisce nel filtro, il gate mente. */
const CODE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.yml', '.yaml', '.css', '.html', '.sh', '.py',
];

/** I file tracciati che un pattern `paths-ignore` copre davvero, chiesti a git. */
function trackedMatching(pattern: string): string[] {
  const out = execFileSync('git', ['ls-files', '--', pattern], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter((line) => line.trim() !== '');
}

describe('tests.yml — filtro di path sui push a main', () => {
  it('dichiara un `paths-ignore` sul push a main e lascia intatti PR e merge queue', () => {
    expect(Array.isArray(IGNORED)).toBe(true);
    expect(IGNORED.length).toBeGreaterThan(0);
    // Il required check vive qui, e qui NON deve esserci nessun filtro.
    expect(on(TESTS).pull_request.branches).toEqual(['main']);
    expect(on(TESTS).pull_request).not.toHaveProperty('paths');
    expect(on(TESTS).pull_request).not.toHaveProperty('paths-ignore');
    expect(on(TESTS)).toHaveProperty('merge_group');
    // `paths` e `paths-ignore` insieme non sono ammessi da GitHub.
    expect(on(TESTS).push).not.toHaveProperty('paths');
  });

  it('ignora solo payload di dati: nessun pattern può coprire un file di codice', () => {
    for (const pattern of IGNORED) {
      expect(pattern, `pattern senza estensione esplicita: ${pattern}`).toMatch(/\.[a-z]+$/u);
      const extension = pattern.slice(pattern.lastIndexOf('.'));
      expect(CODE_EXTENSIONS, `estensione di codice nel filtro: ${pattern}`)
        .not.toContain(extension);
    }
  });

  it('nessun file di codice tracciato finisce dentro un pattern ignorato', () => {
    const swallowed = IGNORED
      .flatMap(trackedMatching)
      .filter((file) => CODE_EXTENSIONS.some((extension) => file.endsWith(extension)));
    expect(swallowed).toEqual([]);
  });

  it('il filtro copre davvero i payload che i cron riversano, non un insieme vuoto', () => {
    // Se un refactor spostasse i dati altrove, il filtro resterebbe formalmente
    // valido ma non salterebbe piu' niente: questo lo rende visibile.
    expect(trackedMatching('data/**/*.json').length).toBeGreaterThan(100);
  });

  it('ogni path tolto a tests.yml resta coperto da guard-data-integrity.yml', () => {
    const guardPaths: string[] = on(GUARD).push.paths;
    expect(on(GUARD).push.branches).toEqual(['main']);
    // I prefissi sorvegliati dal guard, senza il `/**` finale.
    const guarded = guardPaths.map((p) => p.replace(/\/\*\*$/u, ''));
    for (const pattern of IGNORED) {
      const covered = guarded.some((prefix) => pattern.startsWith(`${prefix}/`));
      expect(covered, `path ignorato da tests.yml e non coperto dal guard: ${pattern}`).toBe(true);
    }
  });

  it('il guard sui dati non ha a sua volta un paths-ignore che riapra il buco', () => {
    expect(on(GUARD).push).not.toHaveProperty('paths-ignore');
  });

  // La classe, non il solo `tests.yml` (AGENTS.md #6): la trappola e' un
  // `paths-ignore` ancorato a `data/` che, essendo scritto per directory,
  // ingoia anche i 32 moduli TypeScript che vivono li' dentro. Fuori da `data/`
  // l'esclusione e' un'altra decisione — `deploy.yml` ignora `.github/**` e
  // `tests/**` di proposito, perche' un workflow non deve far ripartire un
  // deploy di produzione — quindi l'invariante resta ancorato dove sta il buco.
  it('nessun workflow su push a main esclude codice attraverso un path sotto data/', () => {
    const swallowed: string[] = [];
    for (const name of readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'))) {
      let doc: any;
      try {
        doc = YAML.parse(readFileSync(resolve(WORKFLOWS, name), 'utf8'));
      } catch {
        continue;
      }
      const push = on(doc)?.push;
      if (!push || typeof push !== 'object') continue;
      const branches: string[] | undefined = push.branches;
      if (branches && !branches.includes('main')) continue;
      for (const pattern of (push['paths-ignore'] ?? []) as string[]) {
        if (!/^(public\/)?data\//u.test(pattern)) continue;
        for (const file of trackedMatching(pattern)) {
          if (CODE_EXTENSIONS.some((extension) => file.endsWith(extension))) {
            swallowed.push(`${name}: '${pattern}' ingoia ${file}`);
          }
        }
      }
    }
    expect(swallowed).toEqual([]);
  });
});
