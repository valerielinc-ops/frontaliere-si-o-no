import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderCorrectionsEditorial } from '../build-plugins/shared/correctionsEditorial';
import { buildCorrezioniSeo } from '../services/seo/seo-correzioni';
import { DISCLOSURE_ROUTE_CONTRACT } from '../packages/articles/engine/shared/aiDisclosure';
import correctionsLog from '../data/corrections-log.json';

describe('static corrections policy locale contract', () => {
  it.each([
    ['it', 'Come segnalare un errore', 'Politica di rettifica e registro pubblico'],
    ['en', 'How to report an error', 'Corrections policy and public log'],
    ['de', 'Einen Fehler melden', 'Korrekturrichtlinie und öffentliches Register'],
    ['fr', 'Signaler une erreur', 'Politique de rectification et registre public'],
  ] as const)('ships real policy content and metadata in %s without unsupported deadlines', (locale, heading, policyName) => {
    const html = renderCorrectionsEditorial(locale).join('');
    expect(html).toContain(heading);
    expect(html).toContain('mailto:redazione@frontaliereticino.ch');
    expect(html.replace(/<[^>]*>/g, ' ').split(/\s+/).length).toBeGreaterThan(50);
    expect(html).not.toMatch(/SLA|48 ore|48.hour|48 Stunden|48 heures|non riceviamo compensi|buona notizia/);
    const metadata = buildCorrezioniSeo(locale);
    expect(metadata.canonical).toBe(`https://frontaliereticino.ch${DISCLOSURE_ROUTE_CONTRACT[locale].corrections}`);
    expect(metadata.jsonLd).toMatchObject({ inLanguage: locale, url: metadata.canonical });
    expect(metadata.jsonLd.about).toMatchObject({ name: policyName, inLanguage: locale });
    expect(metadata.jsonLd).toHaveProperty('lastReviewed', '2026-10-31');
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

  it('publishes the actual 31 October corrections with affected URLs and source references', () => {
    expect(correctionsLog.entries).toHaveLength(7);
    expect(correctionsLog.entries.map((entry) => entry.date)).toContain('2026-10-31T08:16:20Z');
    expect(correctionsLog.entries.map((entry) => entry.date)).toContain('2026-10-31T12:26:24Z');
    for (const entry of correctionsLog.entries) {
      expect(entry.articleId).toMatch(/^https:\/\/frontaliereticino\.ch\/.+\/$/);
      expect(entry.description).toContain('Prima:');
      expect(entry.description).toContain('Corretto:');
      expect(entry.description).toContain('Riferiment');
    }

    const html = renderCorrectionsEditorial('it').join('');
    expect(html).toContain('2026-10-31');
    expect(html).toContain('Accordo CH-IT art. 3 par. 1');
    expect(html).toContain('L. 83/2023 ha 15 articoli');
    expect(html).not.toContain('Nessuna correzione registrata finora');
  });
});
