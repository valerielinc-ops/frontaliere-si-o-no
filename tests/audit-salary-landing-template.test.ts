import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { createAuditor } from '../scripts/audit-salary-landing-template.mjs';

const ROOT = process.cwd();

async function collectSingle(html: string) {
  const auditor = createAuditor({ limit: 10 });
  auditor.collect(
    path.join(ROOT, 'dist/fr/calculer-salaire/salaire-net-60000-chf/index.html'),
    html,
  );
  return await auditor.report();
}

describe('audit-salary-landing-template', () => {
  it('accepts minified unquoted seo-static-content class attributes', async () => {
    const report = await collectSingle(`<!doctype html>
      <html><head><link rel=canonical href=https://frontaliereticino.ch/fr/calculer-salaire/salaire-net-60000-chf/></head>
      <body><main class=seo-static-content><h1 style="font-size:clamp(2rem,4vw,4rem)">Salaire net</h1></main></body></html>`);

    expect(report.passed).toBe(true);
    expect(report.offendersTotal).toBe(0);
  });

  it('still rejects the thin fallback template', async () => {
    const report = await collectSingle(`<!doctype html>
      <html><head><link rel=canonical href=https://frontaliereticino.ch/fr/calculer-salaire/salaire-net-60000-chf/></head>
      <body><main><h1 style="font-size:1.25rem;font-weight:700;margin-bottom:.5rem">Fallback</h1><div style="display:block;height:38rem;margin-top:1.5rem"></div></main></body></html>`);

    expect(report.passed).toBe(false);
    expect(report.offendersTotal).toBe(1);
    expect(report.offenders[0].reasons).toContain('missing <main class="seo-static-content">');
    expect(report.offenders[0].reasons).toContain('thin default H1 (font-size:1.25rem)');
    expect(report.offenders[0].reasons).toContain('empty calculator placeholder (height:38rem)');
  });

  it('excludes an explicit noindex redirect bridge even when it has no canonical', async () => {
    const report = await collectSingle(`<!doctype html>
      <html><head><!--REDIRECT_STUB--><meta name="robots" content="noindex,follow">
      <meta http-equiv="refresh" content="0;url=https://frontaliereticino.ch/fr/calculer-salaire/"></head>
      <body><h1>Pagina spostata</h1></body></html>`);

    expect(report.passed).toBe(true);
    expect(report.extra.scanned).toBe(0);
    expect(report.offendersTotal).toBe(0);
  });

  it('keeps the zero-tolerance template check for marked pages that remain indexable', async () => {
    const report = await collectSingle(`<!doctype html>
      <html><head><!--REDIRECT_STUB--><meta name="robots" content="index,follow"></head>
      <body><h1>Pagina stipendio</h1></body></html>`);

    expect(report.passed).toBe(false);
    expect(report.extra.scanned).toBe(1);
    expect(report.offendersTotal).toBe(1);
  });
});

describe('static salary landing title overrides', () => {
  it('keeps hard-coded locale title overrides within the title-length gate', () => {
    const source = readFileSync(path.join(ROOT, 'build-plugins/staticPagesPlugin.ts'), 'utf8');
    const block = source.match(/const SALARY_LANDING_LOCALE_OVERRIDES:[\s\S]*?\n \};/)?.[0] ?? '';
    const titles = [...block.matchAll(/title: '([^']+)'/g)].map((match) => match[1]);

    expect(titles.length).toBeGreaterThan(0);
    expect(titles.filter((title) => title.length > 66)).toEqual([]);
  });
});
