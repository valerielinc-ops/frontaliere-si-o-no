/**
 * La catena transitiva importata da `prospect-promote.mjs` non ha side-effect a
 * load-time (#7292, item 1).
 *
 * Il rilievo: dal 2026-09-04 lo stage 6 del prospector importa
 * `scripts/ci/followup-drainer.mjs` per `canPushWorkflows()`, e il drainer si
 * porta dietro `claude-rate-limit.mjs`, `close-recovered-failure-issues.mjs`,
 * `lib/run-budget.mjs` e il resto della loro chiusura. L'argomento di sicurezza
 * scritto allora copriva SOLO il drainer — «ha un guard di entrypoint sul suo
 * `main()`» — non i moduli che porta con sé. Sotto questo entrypoint `argv` è
 * `--max=/--min-days=/--open-pr` e l'env è quello del job del prospector: un
 * `process.exit`/`throw` a load-time in uno qualunque di quei moduli ucciderebbe
 * la promozione dei crawler PRIMA dello scaffolding, cioè in silenzio e nel
 * punto del funnel che alimenta nuovi annunci indicizzabili.
 *
 * Oggi la proprietà vale — verificata modulo per modulo il 2026-09-05 — ma non
 * la teneva niente: bastava che un modulo della catena aggiungesse un
 * `readFileSync` di un file assente, o che qualcuno importasse un nuovo CLI, e
 * il guasto sarebbe comparso in produzione. Questo è l'osservatore.
 *
 * Perché è scritto sulla CHIUSURA calcolata e non su una lista fissa: la
 * regressione arriva quasi sempre da un modulo NUOVO nella catena, che una
 * lista scritta a mano non conoscerebbe. Il walker la ricalcola a ogni run, e
 * il primo test verifica che stia davvero guardando qualcosa (una chiusura
 * vuota renderebbe verdi anche i due successivi).
 *
 * L'entrypoint stesso è ESCLUSO dalla propria chiusura di proposito: non ha un
 * guard e non deve averlo — quando è lui l'entrypoint, eseguire è il suo
 * lavoro.
 *
 * Il test copre DUE entrypoint, non uno: `generate-crawler-group-workflows.mjs`
 * importa anch'esso da `scripts/ci/` ed è `prospect-promote.mjs` a lanciarlo
 * subito dopo lo scaffolding, quindi è lo stesso difetto un passo più in là —
 * stessa classe, stessa PR (AGENTS.md #6).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

// I due entrypoint della promozione che importano moduli di `scripts/ci/`, con
// l'argv sotto cui girano davvero. Il secondo non e' un extra: e'
// `prospect-promote.mjs` stesso a lanciarlo (`execFileSync`) subito dopo lo
// scaffolding per rigenerare i workflow di gruppo, quindi un side-effect nella
// SUA catena rompe la stessa promozione, un passo piu' in la'.
const ENTRYPOINTS = [
  { entry: 'scripts/prospect-promote.mjs', argv: ['--max=5', '--min-days=1', '--open-pr'] },
  { entry: 'scripts/generate-crawler-group-workflows.mjs', argv: [] },
];

// Uno specifier relativo puo' essere scritto senza estensione (`'./foo'`, forma
// gia' presente nel repo) o puntare a una directory con `index.*`: risolverlo
// come fa Node e' l'unico modo perche' il suo sottoalbero entri nella chiusura.
const RESOLVE_EXTS = ['', '.mjs', '.js', '.cjs', '.mts', '.ts', '.tsx'];

/** Il file puntato dallo specifier gia' risolto ad assoluto, o null. */
function resolveModule(abs: string): string | null {
  const candidates = [
    ...RESOLVE_EXTS.map((ext) => abs + ext),
    ...RESOLVE_EXTS.slice(1).map((ext) => path.join(abs, `index${ext}`)),
  ];
  for (const cand of candidates) {
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {
      // candidato assente: si prova il prossimo
    }
  }
  return null;
}

/**
 * Chiusura transitiva degli import relativi, a partire dall'entrypoint.
 *
 * `unresolved` non e' un extra diagnostico: uno specifier relativo che non
 * risolve a un file e' un pezzo di catena che sparisce dalla chiusura, e il
 * test resterebbe verde su un sottoalbero che non ha mai guardato. Viene
 * restituito per essere asserito vuoto, invece di essere scartato in silenzio.
 */
function importClosure(entry: string): { modules: string[]; unresolved: string[] } {
  const seen = new Set<string>();
  const unresolved = new Set<string>();
  const stack = [path.join(ROOT, entry)];
  while (stack.length) {
    const abs = stack.pop()!;
    const file = resolveModule(abs);
    if (!file) {
      unresolved.add(path.relative(ROOT, abs));
      continue;
    }
    const rel = path.relative(ROOT, file);
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = readFileSync(file, 'utf8');
    const here = path.dirname(file);
    // Anche `import './x.mjs';` senza `from`: e' la forma dell'import di puro
    // side-effect, cioe' esattamente quella che questo osservatore esiste per
    // prendere. Riconoscere solo `from` lo lascerebbe verde sulla regressione.
    for (const m of src.matchAll(/(?:from\s+|import\s+)['"](\.[^'"]+)['"]/g)) {
      stack.push(path.resolve(here, m[1]));
    }
  }
  seen.delete(entry);
  return { modules: [...seen].sort(), unresolved: [...unresolved].sort() };
}

describe('promozione crawler — nessun side-effect a load-time nelle catene importate (#7292)', () => {
  it('la chiusura di prospect-promote contiene davvero la catena del drainer', () => {
    // Se il walker smettesse di risolvere gli import, i test qui sotto
    // passerebbero su un insieme vuoto senza provare niente.
    const { modules, unresolved } = importClosure('scripts/prospect-promote.mjs');
    expect(modules).toContain('scripts/ci/followup-drainer.mjs');
    expect(modules).toContain('scripts/ci/claude-rate-limit.mjs');
    expect(modules).toContain('scripts/ci/close-recovered-failure-issues.mjs');
    expect(modules).toContain('scripts/ci/lib/run-budget.mjs');
    expect(modules).not.toContain('scripts/prospect-promote.mjs');
    // Un buco nel walker si vede qui, non come chiusura piu' piccola del vero.
    expect(unresolved).toEqual([]);
  });

  it.each(ENTRYPOINTS)('importare la catena di $entry sotto il suo argv non esce né lancia', ({ entry, argv }) => {
    const { modules: CLOSURE, unresolved } = importClosure(entry);
    expect(unresolved).toEqual([]);
    expect(CLOSURE.length).toBeGreaterThan(0);
    // Un solo processo figlio invece di uno per modulo: se un import muore, il
    // marker mancante dice QUALE, che è l'informazione che serve in rosso.
    // Il driver vive in un file vero, chiamato come l'entrypoint di
    // produzione: così `process.argv[1]` ha la stessa FORMA che ha nel job del
    // prospector — un path che finisce col nome dell'entrypoint e non con
    // quello di un modulo della catena.
    const dir = mkdtempSync(path.join(tmpdir(), 'promote-import-'));
    const driver = path.join(dir, path.basename(entry));
    writeFileSync(
      driver,
      `const mods = ${JSON.stringify(CLOSURE)};\n`
        + `for (const m of mods) {\n`
        + `  await import(${JSON.stringify(ROOT)} + '/' + m);\n`
        + `  process.stdout.write('LOADED ' + m + '\\n');\n`
        + `}\n`,
    );

    const res = spawnSync(process.execPath, [driver, ...argv], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    const loaded = res.stdout.split('\n').filter((l) => l.startsWith('LOADED '));
    if (res.status !== 0) {
      throw new Error(
        `import fallito al modulo #${loaded.length + 1} (${CLOSURE[loaded.length] ?? '?'}, o un modulo della sua catena): `
          + `side-effect a load-time (exit ${res.status}, segnale ${res.signal}).\n${res.stderr}`,
      );
    }

    expect(loaded).toHaveLength(CLOSURE.length);
    // Silenzio oltre i marker: il prospector logga il proprio esito su stdout, e
    // un banner a load-time di un modulo CI ne sporcherebbe l'audit trail.
    expect(res.stdout.trimEnd().split('\n')).toEqual(loaded);
    expect(res.stderr).toBe('');
  }, 30_000);
});
