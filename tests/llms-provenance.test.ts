import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The generator consumes the discovered filenames, not sitemap reconciliation.
vi.mock('../build-plugins/sitemapAliasPlugin.ts', () => ({ discoverSitemapFiles: async () => [] }));
import { generateLlmsTxtFamily } from '../scripts/lib/llms-txt-generator.mjs';

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llms-provenance-'));
  temporaryDirectories.push(rootDir);
  const publicDir = path.join(rootDir, 'public');
  const distDir = path.join(rootDir, 'dist');
  fs.mkdirSync(publicDir);
  fs.mkdirSync(distDir);
  const sourceDate = new Date(Date.now() - 400 * 86400000);
  const date = sourceDate.toISOString().slice(0, 10);
  const month = sourceDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const fullDate = sourceDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const source = `# Reference\n- **Last Updated**: ${date}\n(Source: Official report, ${month})\nSources verified as of ${month}.\nDocument last updated on ${fullDate}.\n`;
  for (const file of ['llms.txt', 'llms-full.txt']) fs.writeFileSync(path.join(distDir, file), source);
  const html = `<meta name="citation_date" content="${date}"><meta name="ai-content-declaration" content="Updated ${month}.">`;
  fs.writeFileSync(path.join(distDir, 'index.html'), html);
  fs.writeFileSync(path.join(publicDir, 'sitemap-pages.xml'), '<urlset><url><loc>https://frontaliereticino.ch/guide/</loc><xhtml:link hreflang="en" href="https://frontaliereticino.ch/en/guide/" /></url></urlset>');
  return { rootDir, publicDir, distDir, source, html };
}

describe('AI reference source provenance', () => {
  it('preserves editorial and citation dates while generating the real page index', async () => {
    const f = fixture();
    await generateLlmsTxtFamily(f);
    for (const file of ['llms.txt', 'llms-full.txt']) {
      const output = fs.readFileSync(path.join(f.distDir, file), 'utf8');
      expect(output).toContain(f.source.trim());
      expect(output).toContain('Page Index');
    }
    expect(fs.readFileSync(path.join(f.distDir, 'index.html'), 'utf8')).toBe(f.html);
    expect(fs.readFileSync(path.join(f.distDir, '.well-known/llms.txt'), 'utf8')).toBe(fs.readFileSync(path.join(f.distDir, 'llms.txt'), 'utf8'));
    const locale = fs.readFileSync(path.join(f.distDir, 'en/llms.txt'), 'utf8');
    expect(locale).toContain('**Index Generated**:');
    expect(locale).not.toContain('**Last Updated**:');
  });

  it('does not renew verification dates when the same content is built in a later month', async () => {
    const f = fixture();
    await generateLlmsTxtFamily(f);
    const before = fs.readFileSync(path.join(f.distDir, 'llms-full.txt'), 'utf8');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 70 * 86400000);
    await generateLlmsTxtFamily(f);
    expect(fs.readFileSync(path.join(f.distDir, 'llms-full.txt'), 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(f.distDir, 'index.html'), 'utf8')).toBe(f.html);
  });
});

describe('AI fiscal reference consistency', () => {
  it.each(['public/llms.txt', 'public/llms-full.txt', 'public/en/llms.txt', 'public/en/llms-full.txt'])(
    '%s distinguishes the treaty history from present employer and residence', (file) => {
      const text = fs.readFileSync(path.resolve(file), 'utf8');
      expect(text).toContain('December 31, 2018 and July 17, 2023');
      expect(text).toContain('change of employer does not automatically end Article 9');
      expect(text).toContain('Living beyond 20 km does **not** itself');
      expect(text).not.toMatch(/until[^\n]*(?:changes employer|job change)|Only new regime applies|100 Expert Q&A/);
      expect(text).not.toMatch(/CHF 4,400–5,100\/month net|at current exchange rates|2–3x more/);
      expect(text).toContain('3–6% of net salary');
      expect(text).toContain('€30 minimum and €200 maximum per month worked');
      expect(text).toMatch(/€28,001 – €50,000 \| 33%/);
    },
  );

  it.each([
    ['de', '31. Dezember 2018 und 17. Juli 2023', '3–6% des Nettolohns'],
    ['fr', '31 décembre 2018 et le 17 juillet 2023', '3–6% du salaire net'],
  ])('keeps the %s seed aligned with the source-backed fiscal and health summaries', (locale, period, contribution) => {
    const text = fs.readFileSync(path.resolve(`public/${locale}/llms.txt`), 'utf8');
    expect(text).toContain(period);
    expect(text).toContain(contribution);
    expect(text).not.toMatch(/ODER wohnhaft über 20 km|OU résidant au-delà de 20 km/);
  });
});
