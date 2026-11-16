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

/**
 * I file sotto `data/`/`public/data/` che una riga di codice IMPORTA davvero.
 * Si legge dal sorgente, non da un elenco scritto a mano, perche' l'elenco
 * scritto a mano e' esattamente cio' che va a male in silenzio. E' anche il
 * criterio che usa `scripts/ci/run-related-tests.mjs` per scegliere i test:
 * un grafo di import statici, non le menzioni.
 */
function staticallyImportedDataFiles(): Set<string> {
  const pattern = String.raw`from '[^']*(public/)?data/[^']*\.(json|jsonl)'`;
  const out = grep(['-hoE', pattern, '--', '*.ts', '*.tsx', '*.mjs', '*.js']);
  const files = new Set<string>();
  for (const line of out) {
    // Le righe di commento citano gli import per spiegare perche' NON si fanno
    // (`// NOT a static import … from '@/data/job-popularity.json'`): contarle
    // renderebbe il controllo inservibile con due falsi positivi.
    if (/^\s*(\/\/|\*|"\/\/)/u.test(line)) continue;
    const match = /((?:public\/)?data\/[^']*\.(?:json|jsonl))'$/u.exec(line.trim());
    if (match) files.add(match[1]);
  }
  return files;
}

/**
 * I file di `data/` che un test apre dal DISCO per path assoluto o relativo al
 * repo. Non sono selezionati dal grafo di import, quindi `tests.yml` su un push
 * di soli dati non li girerebbe comunque — ma ignorare il file li toglierebbe
 * da `main` per sempre, ed e' una porta che questa PR non vuole chiudere.
 * Le letture dentro un repo temporaneo (`join(repoDir, 'data/...')`) non
 * contano: sono fixture, non l'albero vero.
 *
 * Contano anche i lettori a prova di limite V8 (`readJsonFile`,
 * `iterateJsonArrayFile`, scripts/lib/read-large-json.mjs): `data/jobs.json` e'
 * oltre i 512 MB, i test che lo aprono sono stati migrati ad essi, e senza questi
 * nomi il rilevatore diventa cieco (era l'asserzione sotto).
 */
function diskReadDataFiles(): Set<string> {
  const pattern = String.raw`(readFileSync|readFile|existsSync|readdirSync|readJsonFile|iterateJsonArrayFile)\([^)]*(path\.resolve|__dirname|'data/)[^)]*data/[^']*\.(json|jsonl)`;
  const out = grep(['-hoE', pattern, '--', 'tests/']);
  const files = new Set<string>();
  for (const line of out) {
    for (const match of line.matchAll(/(data\/[^']*\.(?:json|jsonl))/gu)) files.add(match[1]);
  }
  return files;
}

/**
 * Directory reads: a test (or a store helper it calls on the real tree) that
 * enumerates `data/<dir>` opens every file below it, but never writes a
 * `.json` path, so `diskReadDataFiles` cannot see it. This is the shape of the
 * first-seen ledger once it is sharded (`data/url-first-seen/<h>.json`): a
 * `readdirSync` over the directory. Returns the directories (`data/<dir>/`)
 * that the given source text enumerates from the repository tree.
 */
export function dataDirReadsIn(text: string): Set<string> {
  const dirs = new Set<string>();
  const pattern = /(?:readdirSync|readdir|opendirSync|opendir|globSync)\([^)]*?data\/([A-Za-z0-9_-]+)(?=[/'"`),*])/gu;
  for (const match of text.matchAll(pattern)) dirs.add(`data/${match[1]}/`);
  // Segment form: path.join(root, 'data', 'url-first-seen') handed to a directory reader.
  const segments = /(?:readdirSync|readdir|opendirSync|opendir)\([^)]*?['"`]data['"`]\s*,\s*['"`]([A-Za-z0-9_-]+)['"`]/gu;
  for (const match of text.matchAll(segments)) dirs.add(`data/${match[1]}/`);
  return dirs;
}

function diskReadDataDirs(): Set<string> {
  const dirs = new Set<string>();
  // This file is excluded: its detector self-checks quote the very patterns it looks for.
  const self = ':(exclude)tests/tests-push-main-data-filter.test.ts';
  for (const line of grep(['-hE', '(readdirSync|readdir|opendirSync|opendir|globSync)\\(', '--', 'tests/', self])) {
    for (const dir of dataDirReadsIn(line)) dirs.add(dir);
  }
  return dirs;
}

function grep(args: string[]): string[] {
  try {
    return execFileSync('git', ['grep', ...args], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter((line) => line.trim() !== '');
  } catch {
    return []; // `git grep` esce 1 quando non trova niente.
  }
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

  // IL controllo che rende sicuro il filtro, e quello che una lista per
  // directory non avrebbe superato. `data/` non e' una cartella di soli
  // payload: 37 dei suoi JSON sono importati STATICAMENTE da test e sorgenti,
  // e 9 di quei 37 sono stati toccati dai commit di soli dati del 2026-09-19.
  // Un `data/**/*.json` secco sembra prudente — esclude le estensioni di
  // codice — ma spegnerebbe `tests/canton-registry-integrity.test.ts` proprio
  // sul file che quel test legge. Il grafo si ricalcola qui a ogni run, quindi
  // il giorno in cui qualcuno importa un file oggi ignorato, questo diventa
  // rosso e l'elenco deve accorciarsi.
  it('nessun file ignorato è importato staticamente da test o sorgenti', () => {
    const imported = staticallyImportedDataFiles();
    expect(imported.size, 'grafo di import vuoto: la misura non ha misurato niente')
      .toBeGreaterThan(10);
    // Prova che il rilevatore vede i casi reali, non un insieme a caso.
    expect(imported).toContain('data/canton-url-slugs.json');
    expect(imported).toContain('data/pharmacy-duties-ticino.json');
    const swallowed = IGNORED
      .flatMap(trackedMatching)
      .filter((file) => imported.has(file));
    expect(swallowed).toEqual([]);
  });

  it('nessun file ignorato è aperto dal disco da un test', () => {
    const read = diskReadDataFiles();
    expect(read, 'rilevatore delle letture da disco cieco').toContain('data/slug-registry.json');
    const swallowed = IGNORED
      .flatMap(trackedMatching)
      .filter((file) => read.has(file));
    expect(swallowed).toEqual([]);
  });

  it('nessun file ignorato sta sotto una cartella di dati che un test enumera dal disco', () => {
    const dirs = diskReadDataDirs();
    const swallowed = IGNORED
      .flatMap(trackedMatching)
      .filter((file) => [...dirs].some((dir) => file.startsWith(dir)));
    expect(swallowed).toEqual([]);
  });

  // The detector above must SEE the read it exists for: a `readdirSync` over
  // the sharded first-seen directory. Without these cases a blind detector
  // would keep passing after the shards (which tests.yml ignores) were read.
  it('il rilevatore delle letture di cartella vede readdirSync sulla cartella degli shard', () => {
    expect([...dataDirReadsIn("const names = readdirSync(path.join(ROOT, 'data/url-first-seen'));")])
      .toEqual(['data/url-first-seen/']);
    expect([...dataDirReadsIn("fs.readdirSync(resolve(__dirname, '../data/url-first-seen/'))")])
      .toEqual(['data/url-first-seen/']);
    expect([...dataDirReadsIn("readdirSync(path.join(ROOT, 'data', 'url-first-seen'))")])
      .toEqual(['data/url-first-seen/']);
    expect([...dataDirReadsIn("globSync(`data/url-first-seen/*.json`)")]).toEqual(['data/url-first-seen/']);
  });

  it('il rilevatore delle letture di cartella non scatta su cio\' che non e\' una lettura', () => {
    expect([...dataDirReadsIn("const p = 'data/url-first-seen/a.json';")]).toEqual([]);
    expect([...dataDirReadsIn("readdirSync(tmpDir)")]).toEqual([]);
  });

  it('la cartella degli shard first-seen e\' nei pattern ignorati, e il rilevatore le dà un senso', () => {
    expect(IGNORED).toContain('data/url-first-seen/*.json');
    // Nessun test legge oggi quella cartella dal disco reale: se qualcuno lo fa,
    // il test sopra diventa rosso e il pattern va tolto dall'elenco.
    expect([...diskReadDataDirs()]).not.toContain('data/url-first-seen/');
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
    expect(IGNORED.flatMap(trackedMatching).length).toBeGreaterThan(100);
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
