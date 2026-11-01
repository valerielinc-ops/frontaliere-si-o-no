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

  it('keeps the curated locale seed and only a summary of its URLs', async () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.publicDir, 'en'), { recursive: true });
    fs.writeFileSync(path.join(f.publicDir, 'en/llms.txt'), '# Seed\n\n## Key Facts — Citation-Ready\n');
    await generateLlmsTxtFamily(f);
    const locale = fs.readFileSync(path.join(f.distDir, 'en/llms.txt'), 'utf8');
    expect(locale).toContain('## Key Facts — Citation-Ready');
    expect(locale).toContain('Pages in this language');
    expect(locale).toContain('/llms-index.txt');
    expect(locale).not.toMatch(/^- \[.*\]\(https:\/\/frontaliereticino\.ch\/en\//m);
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

describe('llms family derived from the sitemaps', () => {
  const urls = (...paths: string[]) => `<urlset>${paths.map((p) => `<url><loc>https://frontaliereticino.ch${p}</loc><lastmod>2026-10-20</lastmod></url>`).join('')}</urlset>`;

  function seeded() {
    const f = fixture();
    fs.writeFileSync(path.join(f.distDir, 'llms.txt'), '# Reference\n- **3000+ Blog Articles** — hub\n');
    fs.writeFileSync(path.join(f.distDir, 'llms-full.txt'), '# Reference\nWe publish **3,000+ in-depth articles**.\n');
    fs.writeFileSync(path.join(f.publicDir, 'sitemap-pages.xml'), '<urlset></urlset>');
    fs.writeFileSync(path.join(f.publicDir, 'sitemap-blog.xml'), urls('/articoli-frontaliere/a/', '/articoli-frontaliere/b/'));
    // The dist copy is the final one, and it has more URLs than the seed.
    fs.writeFileSync(path.join(f.distDir, 'sitemap-blog.xml'), urls('/articoli-frontaliere/a/', '/articoli-frontaliere/b/', '/en/cross-border-articles/a/'));
    return f;
  }

  it('states one article count everywhere and the real total of URLs', async () => {
    const f = seeded();
    await generateLlmsTxtFamily(f);
    const llms = fs.readFileSync(path.join(f.distDir, 'llms.txt'), 'utf8');
    const full = fs.readFileSync(path.join(f.distDir, 'llms-full.txt'), 'utf8');
    expect(llms).toContain('**2 Blog Articles**');
    expect(llms).toContain('- **Blog Articles**: 2 pages');
    expect(llms).toContain('3 URLs in the sitemaps across all languages');
    expect(full).toContain('**2 in-depth articles**');
    expect(`${llms}${full}`).not.toContain('3,000+');
  });

  it('derives English Blog Articles counts from the English sitemap alternates', async () => {
    const f = seeded();
    const rows = [
      ['/articoli-frontaliere/a/', '/en/cross-border-articles/a/'],
      ['/articoli-frontaliere/b/', '/en/cross-border-articles/b/'],
    ].map(([it, en]) => `<url><loc>https://frontaliereticino.ch${it}</loc><xhtml:link hreflang="en" href="https://frontaliereticino.ch${en}" /></url>`).join('');
    const sitemap = `<urlset>${rows}</urlset>`;
    fs.writeFileSync(path.join(f.publicDir, 'sitemap-blog.xml'), sitemap);
    fs.writeFileSync(path.join(f.distDir, 'sitemap-blog.xml'), sitemap);
    fs.mkdirSync(path.join(f.publicDir, 'en'), { recursive: true });
    fs.mkdirSync(path.join(f.distDir, 'en'), { recursive: true });
    const englishSeed = '# English reference\n- **Blog Articles** — In-depth articles.\n';
    fs.writeFileSync(path.join(f.publicDir, 'en/llms.txt'), englishSeed);
    fs.writeFileSync(path.join(f.distDir, 'en/llms-full.txt'), englishSeed);

    await generateLlmsTxtFamily(f);

    expect(fs.readFileSync(path.join(f.distDir, 'en/llms.txt'), 'utf8')).toContain('- **2 Blog Articles**');
    expect(fs.readFileSync(path.join(f.distDir, 'en/llms-full.txt'), 'utf8')).toContain('- **2 Blog Articles**');
  });

  it('counts a translation declared only as an hreflang alternate, once', async () => {
    const f = seeded();
    const alternate = (lang: string, p: string) => `<xhtml:link rel="alternate" hreflang="${lang}" href="https://frontaliereticino.ch${p}" />`;
    const block = `<url><loc>https://frontaliereticino.ch/guida/</loc>${alternate('it', '/guida/')}${alternate('en', '/en/guide/')}${alternate('de', '/de/ratgeber/')}${alternate('fr', '/fr/guide/')}${alternate('x-default', '/guida/')}</url>`;
    fs.writeFileSync(path.join(f.distDir, 'sitemap-blog.xml'), `<urlset>${block}</urlset>`);
    const { summarizeSitemaps } = await import('../scripts/lib/llms-txt-generator.mjs');
    expect(summarizeSitemaps(f.publicDir, fs, f.distDir, ['sitemap-blog.xml']).totalUrls).toBe(4);
  });

  it('keeps the per-URL index out of the reference, with its own derived date', async () => {
    const f = seeded();
    await generateLlmsTxtFamily(f);
    const full = fs.readFileSync(path.join(f.distDir, 'llms-full.txt'), 'utf8');
    const index = fs.readFileSync(path.join(f.distDir, 'llms-index.txt'), 'utf8');
    expect(full).not.toContain('/articoli-frontaliere/a/');
    expect(full).toContain('/llms-index.txt');
    expect(index).toContain('/articoli-frontaliere/a/');
    expect(index).toContain('Newest indexed change: 2026-10-20');
  });

  it('is idempotent: a second run on its own output replaces the pointer', async () => {
    const f = seeded();
    await generateLlmsTxtFamily(f);
    const once = fs.readFileSync(path.join(f.distDir, 'llms-full.txt'), 'utf8');
    await generateLlmsTxtFamily(f);
    expect(fs.readFileSync(path.join(f.distDir, 'llms-full.txt'), 'utf8')).toBe(once);
  });

  it.each(['public/llms.txt', 'public/llms-full.txt', 'public/en/llms.txt', 'public/en/llms-full.txt'])(
    '%s makes no competitive superlative about the site', (file) => {
      const text = fs.readFileSync(path.resolve(file), 'utf8');
      expect(text).not.toMatch(/Frontaliere Ticino[^\n]{0,80}most comprehensive/);
    },
  );

  it.each(['public/llms-full.txt', 'public/en/llms-full.txt'])(
    '%s compares 13 tools against three competitors with unverified cells left open', (file) => {
      const text = fs.readFileSync(path.resolve(file), 'utf8');
      const section = text.split('### Tool comparison (public evidence checked 2026-10-31)')[1]?.split('\n\n## ')[0] ?? '';
      const rows = section.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('|---') && !line.includes('Feature |'));
      expect(rows).toHaveLength(13);
      expect(section).toContain('[frontaliere.tax]');
      expect(section).toContain('[Fronti.app]');
      expect(section).toContain('[TasseSvizzera.it]');
      expect(section).toContain('? Verify');
      expect(section).toContain('does not indicate that a feature is absent');
    },
  );
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
