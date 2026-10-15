/**
 * pr-autorebase — auto-resolve dei conflitti import-union (la classe #1 dei
 * conflitti cross-PR: due PR aggiungono import distinti allo stesso file).
 * Osservato #2057: stuck CONFLICTING finché risolto a mano. resolveImportConflictsInText
 * risolve per UNIONE solo se OGNI hunk è import-only-additivo; qualunque altro
 * conflitto → null (il chiamante aborta → stale-review → recycle). Guard
 * anti-collisione: stesso binding da path diversi → null (non sicuro).
 */
import { describe, it, expect } from 'vitest';
import { resolveImportConflictsInText } from '../scripts/ci/pr-autorebase.mjs';

const conflict = (ours: string, theirs: string, pre = '', post = '') =>
  `${pre}<<<<<<< HEAD\n${ours}\n=======\n${theirs}\n>>>>>>> origin/main${post}`;

describe('resolveImportConflictsInText', () => {
  it('risolve il conflitto import-union di #2057 tenendo entrambi gli import', () => {
    const t = conflict(
      "import { FX_HREF, HEALTH_HREF, FUEL_HREF } from './comparatorHref';",
      "import { cantonGrossSalaryBand } from './cantonSalaryIndex';",
      "import { CALC_HREF } from './calcHref';\n",
      '\n\nexport const x = 1;',
    );
    const r = resolveImportConflictsInText(t);
    expect(r).not.toBeNull();
    expect(r).not.toContain('<<<<<<<');
    expect(r).toContain('comparatorHref');
    expect(r).toContain('cantonSalaryIndex');
    expect(r).toContain('CALC_HREF'); // contesto preservato
  });

  it('ritorna null su un conflitto di CODICE (non auto-risolvibile → abort)', () => {
    expect(resolveImportConflictsInText(conflict('const x = 1;', 'const x = 2;'))).toBeNull();
  });

  it('ritorna null se lo STESSO binding arriva da path diversi (collisione)', () => {
    expect(resolveImportConflictsInText(conflict("import { FOO } from './a';", "import { FOO } from './b';"))).toBeNull();
  });

  it('dedupa un import identico su entrambi i lati', () => {
    const r = resolveImportConflictsInText(conflict("import { B } from './b';", "import { B } from './b';"));
    expect(r).not.toBeNull();
    expect((r!.match(/import { B }/g) || []).length).toBe(1);
  });

  it('lascia invariato un testo senza conflitti', () => {
    const t = "import x from 'y';\nexport const z = 1;";
    expect(resolveImportConflictsInText(t)).toBe(t);
  });

  it('ritorna null se un hunk mischia import e codice (non puro import-only)', () => {
    const t = conflict("import { A } from './a';\nconst k = 1;", "import { B } from './b';");
    expect(resolveImportConflictsInText(t)).toBeNull();
  });
});
