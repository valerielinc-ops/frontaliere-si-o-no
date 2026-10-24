import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transform } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { importMetaGlobOrEmpty } from '@/services/i18n';

// Regression for run 40130476488: build plugins import services/i18n from
// vite.config.ts, which Vite loads through esbuild WITHOUT the import.meta.glob
// transform. A bare `import.meta.glob(...)` at module scope threw
// "(intermediate value).glob is not a function" and killed every deploy leg
// while the config was still loading.
describe('services/i18n on-demand namespaces outside the Vite transform', () => {
 it('evaluates to an empty loader map when import.meta.glob is not defined (config load)', async () => {
  // Same shape as services/i18n.ts, compiled the way the config loader does
  // (esbuild, no Vite plugins) and evaluated in plain Node.
  // Concatenated so this test file's own Vite transform does not rewrite it.
  const globCall = ['import', 'meta', 'glob'].join('.');
  const source = `
   ${importMetaGlobOrEmpty.toString()}
   export const modules = importMetaGlobOrEmpty(() => ${globCall}('./locales/*-ns-*.ts'));
  `;
  const { code } = await transform(source, { loader: 'ts', format: 'esm', platform: 'node' });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  expect(mod.modules).toEqual({});
 });

 it('returns the Vite loader map unchanged and does not hide unrelated failures', () => {
  const loaders = { './locales/it-ns-faq.ts': () => Promise.resolve({ default: {} }) };
  expect(importMetaGlobOrEmpty(() => loaders)).toBe(loaders);
  expect(() => importMetaGlobOrEmpty(() => { throw new RangeError('boom'); })).toThrow(RangeError);
 });

 it('keeps the namespace glob a literal call inside the guard, so Vite still rewrites it', () => {
  const i18n = readFileSync(resolve(process.cwd(), 'services/i18n.ts'), 'utf8');
  const code = i18n.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  const calls = code.match(/import\.meta\.glob\s*[<(]/g) ?? [];
  expect(calls).toHaveLength(1);
  expect(i18n).toMatch(/importMetaGlobOrEmpty\(\s*\(\) => import\.meta\.glob<\{ default: Translations \}>\('\.\/locales\/\*-ns-\*\.ts'\),?\s*\)/);
  expect(code).not.toMatch(/typeof import\.meta\.glob/);
 });
});
