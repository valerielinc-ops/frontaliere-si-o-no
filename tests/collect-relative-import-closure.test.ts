import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectRelativeImportClosure } from './helpers/collectRelativeImportClosure';

describe('#6805 — collectRelativeImportClosure diagnostic hardening', () => {
  let tmp = '';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-relative-import-closure-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function write(relPath: string, contents: string) {
    const abs = path.join(tmp, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }

  it('still walks plain static import/export as before', () => {
    write('a.mjs', "import { x } from './b.mjs';\nexport * from './c.mjs';\n");
    write('b.mjs', '');
    write('c.mjs', '');
    expect(collectRelativeImportClosure(tmp, 'a.mjs')).toEqual(['a.mjs', 'b.mjs', 'c.mjs']);
  });

  it('walks a dynamic import() with a literal relative specifier instead of silently dropping it', () => {
    write('a.mjs', "export const load = () => import(`./dynamic.mjs`, { with: { type: 'json' } });\n");
    write('dynamic.mjs', '');
    expect(collectRelativeImportClosure(tmp, 'a.mjs')).toEqual(['a.mjs', 'dynamic.mjs']);
  });

  it('throws diagnostically on a dynamic import() whose specifier is not a string literal, instead of under-reporting the closure', () => {
    write('a.mjs', "const which = pick();\nexport const load = () => import(`./${which}.mjs`);\n");
    expect(() => collectRelativeImportClosure(tmp, 'a.mjs')).toThrow(/dynamic import\(\).*non-literal specifier/);
  });
});
