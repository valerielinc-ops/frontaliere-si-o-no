import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  composeFederalJobDescription,
  federalApiDescription,
  federalRichTextToMarkdown,
  parseFederalJobDetailExtras,
} from '../scripts/lib/federal-job-detail.mjs';
import { preferEnrichedDescription } from '../scripts/lib/enriched-description-fallback.mjs';

// Minimized from the live jobs.admin.ch page of "Verantwortliche/-r
// Ausbildungsanlagen" (2026-09-29, contact anonymized). The page renders the
// summary, facts and contact blocks twice (screen + print/mobile copies).
const html = readFileSync(new URL('./fixtures/jobs-admin-ch-detail-vtg.html', import.meta.url), 'utf8');

describe('federal job detail sections (jobs.admin.ch)', () => {
  it('reads the page-only role sections once, in the page language', () => {
    const extras = parseFederalJobDetailExtras(html);
    expect(extras.summaryHeading).toBe('Auf den Punkt gebracht');
    expect(extras.summary).toMatch(/^Sind Sie eine offene Persönlichkeit mit ausgeprägtem Organisationstalent/);
    expect(extras.facts).toEqual([
      { label: 'Eintrittsdatum', value: 'sofort' },
      { label: 'Anstellungsart', value: 'unbefristet' },
      { label: 'Referenz-Nr.', value: 'JRQ$540-20472' },
      { label: 'Arbeitsort', value: "Places d'armes, 1436 Chamblon" },
    ]);
    expect(extras.additionalHeading).toBe('Zusätzliche Informationen');
    expect(extras.additional).toContain('armee.ch/vorteile');
    expect(extras.notes).toEqual([
      'Frauen sind in unserer Verwaltungseinheit noch untervertreten. Ihre Bewerbungen sind daher besonders willkommen.',
    ]);
    // The JSON-LD blocks keep the page's own headings.
    expect(extras.roleText).toMatch(/^## Diesen Beitrag können Sie leisten\n\n- Als Ansprechpartner\/-in vor Ort/);
    expect(extras.roleText).toContain('## Das macht Sie einzigartig');
    expect(extras.roleText).toContain('## Das bieten wir\n\n- Arbeiten für die Schweiz: Wir setzen uns');
    expect(extras.roleText).toContain('## Ihr Einsatz für Sicherheit und Freiheit');
  });

  it('puts summary and facts before the role text, adds the rest after, and is idempotent', () => {
    const extras = parseFederalJobDetailExtras(html);
    const composed = composeFederalJobDescription(extras.roleText, extras);
    const markers = [
      '## Auf den Punkt gebracht',
      '- Arbeitsort: Places d\'armes, 1436 Chamblon',
      '## Diesen Beitrag können Sie leisten',
      '## Das bieten wir',
      '## Zusätzliche Informationen',
      'Frauen sind in unserer Verwaltungseinheit noch untervertreten.',
    ];
    let cursor = -1;
    for (const marker of markers) {
      const at = composed.indexOf(marker);
      expect(at, marker).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(composeFederalJobDescription(composed, extras)).toBe(composed);
    // Contact form, similar jobs and the print copies stay out.
    expect(composed.split('Auf den Punkt gebracht')).toHaveLength(2);
    for (const chrome of ['Fragen zur Stelle', 'Erika Muster', 'Ähnliche Stellen', 'Nachricht senden']) {
      expect(composed).not.toContain(chrome);
    }
  });

  it('builds the API fallback from tasks, requirements, benefits and profile without navigation links', () => {
    const text = federalApiDescription({
      sza_tasks: '<ul><li>Planen und Begleiten von Forschungsaufträgen</li></ul>',
      sza_requirements: '<ul><li>Hochschulabschluss</li></ul>',
      sza_benefits: '<ul><li><b>Gelebte Vielfalt</b> Dank Chancengleichheit entfalten wir unsere Kompetenzen.</li></ul><br/><a href="https://www.stelle.admin.ch/">Alle Benefits</a>',
      sza_company_profil: 'Das Bundesamt für Wohnungswesen (BWO) ist das Kompetenzzentrum des Bundes.',
    });
    expect(text).toBe([
      '- Planen und Begleiten von Forschungsaufträgen',
      '- Hochschulabschluss',
      '- Gelebte Vielfalt: Dank Chancengleichheit entfalten wir unsere Kompetenzen.',
      'Das Bundesamt für Wohnungswesen (BWO) ist das Kompetenzzentrum des Bundes.',
    ].join('\n\n'));
    expect(federalRichTextToMarkdown('<p><div>Das bieten wir</div><br><ul><li>A</li><li>B</li></ul></p>'))
      .toBe('## Das bieten wir\n\n- A\n- B');
  });

  it('keeps an enriched text when a run could only read the API fields', () => {
    const extras = parseFederalJobDetailExtras(html);
    const api = federalApiDescription({
      sza_tasks: '<ul><li>Anlagen und Gebäude instand halten sowie Reparaturen durchführen</li></ul>',
    });
    const enriched = composeFederalJobDescription(extras.roleText, extras);
    expect(preferEnrichedDescription(enriched, api)).toBe(enriched);
    // A changed feed text wins over the stored one.
    expect(preferEnrichedDescription(enriched, '- Ein neuer Auftrag')).toBe('- Ein neuer Auftrag');
    expect(preferEnrichedDescription('', api)).toBe(api);
  });
});
