import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderCorrectionsEditorial } from '../build-plugins/shared/correctionsEditorial';
import { buildCorrezioniSeo } from '../services/seo/seo-correzioni';
import { CORRECTIONS_PATHS } from '../services/editorialCorrections';

describe('static corrections policy locale contract', () => {
  it.each([
    ['it', 'Come segnalare un errore'], ['en', 'How to report an error'],
    ['de', 'Einen Fehler melden'], ['fr', 'Signaler une erreur'],
  ] as const)('ships real policy content and metadata in %s without unsupported deadlines', (locale, heading) => {
    const html = renderCorrectionsEditorial(locale).join('');
    expect(html).toContain(heading);
    expect(html).toContain('mailto:redazione@frontaliereticino.ch');
    expect(html.replace(/<[^>]*>/g, ' ').split(/\s+/).length).toBeGreaterThan(50);
    expect(html).not.toMatch(/SLA|48 ore|48.hour|48 Stunden|48 heures|non riceviamo compensi|buona notizia/);
    const metadata = buildCorrezioniSeo(locale);
    expect(metadata.canonical).toBe(`https://frontaliereticino.ch${CORRECTIONS_PATHS[locale]}`);
    expect(metadata.jsonLd).toMatchObject({ inLanguage: locale, url: metadata.canonical });
    expect(metadata.jsonLd).not.toHaveProperty('lastReviewed');
    expect(metadata.description).not.toMatch(/SLA|48/);
  });
  it('renders populated log types in each locale and escapes source descriptions', () => {
    const date = new Date(Date.now() - 86400000).toISOString();
    const log = { policy: { contactEmail: 'redazione@frontaliereticino.ch' }, entries: [
      { date, articleId: 'example', type: 'factual', description: '<script>unsafe</script>' },
      { date, articleId: 'example-two', type: '<unknown>', description: 'Source wording' },
    ] };
    for (const [locale, label] of [['it', 'Errore fattuale'], ['en', 'Factual error'], ['de', 'Sachlicher Fehler'], ['fr', 'Erreur factuelle']] as const) {
      const html = renderCorrectionsEditorial(locale, log).join('');
      const entries = html.slice(html.indexOf('<ol>'));
      expect(entries).toContain(label);
      expect(entries).toContain('&lt;unknown&gt;');
      expect(entries).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
      expect(entries).not.toContain('<script>');
    }
  });
  it('routes all locales through the dedicated policy before the generic section fallback', () => {
    const source = readFileSync(new URL('../build-plugins/staticPagesPlugin.ts', import.meta.url), 'utf8');
    expect(source.indexOf('editorialBlocks.push(...renderCorrectionsEditorial')).toBeLessThan(source.indexOf('editorialBlocks.push(...SECTION_EDITORIAL'));
    expect(source).not.toContain("} else if (canonicalPath === '/correzioni'");
  });
});
