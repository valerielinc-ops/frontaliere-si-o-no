import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BUCKETS, ROOT, bucketAliasPaths, symlinkTargetAbs } from '../scripts/ci/checkout-profile-analyzer.mjs';

/**
 * Issue #6223 — «23 symlink pendenti nello sparse checkout».
 *
 * L'analizzatore dei profili di checkout mappa i symlink verso i bucket pesanti
 * (`services/seo/seo-blog-2.ts` -> `packages/articles/content/seo/...`) proprio
 * perche' il codice nomina il LINK e mai il bersaglio: senza quella mappa il
 * bucket risulta non servito e il job materializza un link pendente, che a
 * runtime e' un `ENOENT` su un path che in git c'e'.
 *
 * Il difetto era che la mappa si costruiva con `realpathSync`, che STATTA il
 * bersaglio: sul link pendente lanciava e l'alias spariva in silenzio. Cioe' il
 * meccanismo funzionava solo dove non serviva (checkout pieno) e si spegneva
 * esattamente dove serve (checkout sparse). Questi due casi lo pinnano sul
 * COMPORTAMENTO — nessuna regex sul sorgente dell'analizzatore.
 */
describe('checkout profile analyzer: gli alias non dipendono da cosa e stato materializzato', () => {
  it('risolve un symlink PENDENTE, dove realpathSync lancia', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dangling-alias-'));
    try {
      const link = path.join(dir, 'alias.ts');
      fs.symlinkSync('../bucket/target.ts', link);

      // La premessa del difetto, asserita e non assunta: senza bersaglio
      // materializzato `realpathSync` non risponde affatto.
      expect(() => fs.realpathSync(link)).toThrow();

      expect(symlinkTargetAbs(link)).toBe(path.resolve(dir, '../bucket/target.ts'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('un link non leggibile resta null invece di far saltare il walk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dangling-alias-'));
    try {
      expect(symlinkTargetAbs(path.join(dir, 'non-esiste'))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ogni symlink TRACCIATO che punta dentro un bucket e nella mappa alias, materializzato o no', () => {
    // La verita' e' git, non il filesystem: in un worktree sparse i bersagli non
    // ci sono, ed e' precisamente la popolazione su cui il difetto si manifesta.
    // Il bersaglio si legge dall'INDEX di git (`git cat-file -p :<path>`), non
    // con la funzione sotto esame: se la popolazione la scegliesse
    // `symlinkTargetAbs`, una regressione che smette di risolvere i link
    // pendenti li toglierebbe anche dall'insieme controllato e il caso
    // resterebbe verde — lo stesso auto-inganno del difetto.
    // Solo l'assenza di git salta il caso. Qualunque ALTRO errore deve farlo
    // fallire: un `catch` che ingoia tutto trasforma un `ENOBUFS` su
    // `git ls-files` (41.707 path, il buffer di default di execFileSync non
    // basta) in un verde che non ha guardato niente — osservato mentre si
    // scriveva questo caso.
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, stdio: 'pipe' });
    } catch {
      return; // non un checkout git (tarball CI): niente da asserire
    }
    const gitOut = (args: string[]) =>
      execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

    const tracked = gitOut(['ls-files', '-s'])
      .split('\n')
      .filter((l) => l.startsWith('120000 '))
      .map((l) => l.split('\t')[1])
      .filter(Boolean)
      .map((link) => ({ link, target: gitOut(['cat-file', '-p', `:${link}`]) }));

    const aliases = bucketAliasPaths();
    const known = new Set([...aliases.values()].flatMap((s) => [...s]));
    const bucketDirs = BUCKETS.map((b) => b.id.replace(/\/$/, ''));

    const missed: string[] = [];
    let intoBucket = 0;
    for (const { link, target } of tracked) {
      const rel = path.relative(ROOT, path.resolve(ROOT, path.dirname(link), target));
      if (!bucketDirs.some((b) => rel === b || rel.startsWith(b + '/'))) continue;
      intoBucket += 1;
      if (!known.has(link)) missed.push(link);
    }

    expect(intoBucket, 'nessun symlink tracciato punta dentro un bucket: la misura non sta guardando niente').toBeGreaterThan(0);
    expect(missed, `symlink verso un bucket assenti dalla mappa alias: ${missed.join(', ')}`).toEqual([]);
  });
});
