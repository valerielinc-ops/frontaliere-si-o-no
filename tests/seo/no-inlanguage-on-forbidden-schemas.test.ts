/**
 * Static-source guard: ensures no `inLanguage` property is assigned to a
 * Schema.org type that does NOT support it (BreadcrumbList, ItemList,
 * Place, Organization, SoftwareApplication, WebApplication).
 *
 * Complements `inlanguage-whitelist.test.ts`, which only covers the
 * runtime `services/seoService.ts` injection path. This test scans every
 * build-plugin source file directly so static-HTML regressions are
 * caught at PR time — no full Vite build required.
 *
 * Root cause for issue: Semrush flagged ~8k `inLanguage` errors on
 * BreadcrumbList / ItemList because schema.org rejects the property on
 * those types (it lives on `CreativeWork` and subtypes only).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const FORBIDDEN = new Set([
  'BreadcrumbList',
  'ItemList',
  'Place',
  'Organization',
  'SoftwareApplication',
  'WebApplication',
]);

const ROOTS = ['build-plugins', 'services/seo', 'services/seoService.ts'];

interface Offender {
  readonly file: string;
  readonly line: number;
  readonly schemaType: string;
}

function* walk(dir: string): Iterable<string> {
  if (!fs.existsSync(dir)) return;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    yield dir;
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(entry.name)) yield p;
  }
}

function scanFile(file: string): readonly Offender[] {
  const src = fs.readFileSync(file, 'utf8');
  const offenders: Offender[] = [];
  const stack: { type: string | null }[] = [];

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') stack.push({ type: null });
    else if (c === '}') stack.pop();

    if (stack.length === 0) continue;
    const top = stack[stack.length - 1];

    if (!top.type) {
      const m = /^['"]@type['"]\s*:\s*['"]([A-Za-z]+)['"]/.exec(src.slice(i));
      if (m) {
        top.type = m[1];
        i += m[0].length - 1;
        continue;
      }
    }

    const m2 = /^inLanguage\s*:/.exec(src.slice(i));
    const prevChar = i === 0 ? '' : src[i - 1];
    if (m2 && /[\s,{]/.test(prevChar) && top.type && FORBIDDEN.has(top.type)) {
      const line = src.slice(0, i).split('\n').length;
      offenders.push({ file, line, schemaType: top.type });
      i += m2[0].length - 1;
    }
  }

  return offenders;
}

describe('static guard — no inLanguage on forbidden schema types', () => {
  it('scans all build-plugin and seo source files for offenders', () => {
    const all: Offender[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        all.push(...scanFile(file));
      }
    }
    expect(
      all.map((o) => `${o.file}:${o.line} (${o.schemaType})`),
    ).toEqual([]);
  });
});
