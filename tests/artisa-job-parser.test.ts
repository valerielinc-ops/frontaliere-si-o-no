import { describe, expect, it } from 'vitest';
import { parseArtisaCareerPage, parseSmartsheetFormPage, buildArtisaLocalizedContent, assertCompleteArtisaSnapshot } from '../scripts/lib/artisa-job-parser.mjs';

const SAMPLE_HTML = `
  <div>
    <h2>Marketing Operations &amp; Media Relations Manager</h2>
    <h4>Lugano</h4>
    <a href="https://app.smartsheet.com/b/form/019c9e2001bc712ca18afeebb0ca9b4d">Scopri di più</a>
    <h2>Real Estate Sales Manager</h2>
    <h4>Lugano - Zurigo</h4>
    <a href="https://app.smartsheet.com/b/form/019c76ab1ef870d9b787c937cd545c69">Scopri di più</a>
    <h2>Segretaria / Assistente progetto</h2>
    <h4>Lugano</h4>
    <h2>Manager en Aquisition et Transaction</h2>
    <h4>Losanna</h4>
    <a href="https://app.smartsheet.com/b/form/019c76a94da9791abbb0493d81640ef9">Scopri di più</a>
    <h2>Architetto qualificato</h2>
    <h4>Lugano</h4>
    <a href="https://app.smartsheet.com/b/form/019c46ebd5137236a9d1b0d500840bf4">Scopri di più</a>
  </div>
`;

describe('parseArtisaCareerPage', () => {
  it('extracts Ticino vacancies and ignores non-target locations', () => {
    const rows = parseArtisaCareerPage(SAMPLE_HTML);
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.title)).toEqual([
      'Marketing Operations & Media Relations Manager',
      'Real Estate Sales Manager',
      'Segretaria / Assistente progetto',
      'Architetto qualificato',
    ]);
  });
});

describe('parseSmartsheetFormPage', () => {
  function buildFormHtml(formDef: Record<string, unknown>): string {
    const b64 = Buffer.from(JSON.stringify(formDef)).toString('base64');
    return `<html><head><script>window.formDefinition = "${b64}";</script></head><body></body></html>`;
  }

  it('extracts title and description from base64-encoded formDefinition', () => {
    const html = buildFormHtml({
      name: 'Architetto qualificato 100% (m/w)',
      description: 'Siamo un gruppo immobiliare svizzero con filiali a Zurigo, Lugano e Losanna. Le tue principali responsabilità: Progettazione strategica. Il tuo profilo: Oltre 5 anni di esperienza.',
    });
    const result = parseSmartsheetFormPage(html);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Architetto qualificato 100% (m/w)');
    expect(result!.description).toContain('gruppo immobiliare svizzero');
    // Should add markdown headings for known sections
    expect(result!.description).toContain('## Le tue principali responsabilità');
    expect(result!.description).toContain('## Il tuo profilo');
  });

  it('returns null when no formDefinition is present', () => {
    expect(parseSmartsheetFormPage('<html><body>no form here</body></html>')).toBeNull();
  });

  it('returns null for invalid base64', () => {
    const html = '<script>window.formDefinition = "not-valid-base64!!!";</script>';
    expect(parseSmartsheetFormPage(html)).toBeNull();
  });

  it('handles form with title but no description', () => {
    const html = buildFormHtml({ name: 'Test Role', description: '' });
    const result = parseSmartsheetFormPage(html);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Test Role');
    expect(result!.description).toBe('');
  });

  it('handles form with short description (< 30 chars)', () => {
    const html = buildFormHtml({ name: 'Test Role', description: 'Short text.' });
    const result = parseSmartsheetFormPage(html);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Test Role');
    expect(result!.description).toBe('');
  });
});

describe('buildArtisaLocalizedContent', () => {
  it('uses detailDescription when available', () => {
    const result = buildArtisaLocalizedContent({
      title: 'Architetto qualificato',
      location: 'Lugano',
      detailDescription: '## Posizione\nDescrizione ricca dal form Smartsheet con tutti i dettagli del ruolo.',
    });
    expect(result.descriptionByLocale.it).toContain('Descrizione ricca dal form Smartsheet');
    // Other locales should be empty (to be filled by AI translation)
    expect(result.descriptionByLocale.en).toBe('');
    expect(result.descriptionByLocale.de).toBe('');
    expect(result.descriptionByLocale.fr).toBe('');
  });

  it('falls back to generic description when no detailDescription', () => {
    const result = buildArtisaLocalizedContent({
      title: 'Architetto qualificato',
      location: 'Lugano',
    });
    expect(result.descriptionByLocale.it).toContain('Posizione aperta');
    expect(result.descriptionByLocale.en).toContain('Open position');
    expect(result.descriptionByLocale.de).toContain('Offene Stelle');
    expect(result.descriptionByLocale.fr).toContain('Poste ouvert');
  });
});

describe('assertCompleteArtisaSnapshot', () => {
  const LANDMARKS_ONLY_HTML = `
    <div>
      <h2>Carriera</h2>
      <h2>Le nostre sedi</h2>
      <h4>Lugano</h4>
    </div>
  `;

  it('proves the empty snapshot when the careers page rendered both landmarks', () => {
    const rows = parseArtisaCareerPage(LANDMARKS_ONLY_HTML);
    expect(rows).toHaveLength(0);
    expect(assertCompleteArtisaSnapshot(rows)).toBe(true);
  });

  it('rejects a zero produced by a page that never rendered the landmarks', () => {
    const rows = parseArtisaCareerPage('<html><body><h2>Access denied</h2></body></html>');
    expect(rows).toHaveLength(0);
    expect(() => assertCompleteArtisaSnapshot(rows)).toThrow(/not a proven authoritative empty state/);
  });

  it('rejects a non-empty snapshot: only the zero case is authoritative', () => {
    const rows = parseArtisaCareerPage(SAMPLE_HTML);
    expect(rows.length).toBeGreaterThan(0);
    expect(() => assertCompleteArtisaSnapshot(rows)).toThrow(/not a proven authoritative empty state/);
  });

  // Both drifts below render the page in full (landmarks present) and yield zero
  // rows. Qualifying the zero post-filter would call them authoritative and
  // delist every live Artisa job; the proof is pre-filter precisely so they throw.
  it('rejects a zero produced by the location moving out of the h4 selector', () => {
    const rows = parseArtisaCareerPage(`
      <div>
        <h2>Carriera</h2>
        <h2>Architetto qualificato</h2>
        <div>Lugano</div>
        <a href="https://app.smartsheet.com/b/form/019c46ebd5137236a9d1b0d500840bf4">Scopri di piu</a>
        <h2>Le nostre sedi</h2>
      </div>
    `);
    expect(rows).toHaveLength(0);
    expect(() => assertCompleteArtisaSnapshot(rows)).toThrow(/not a proven authoritative empty state/);
  });

  it('rejects a zero produced by every vacancy falling outside the target filter', () => {
    const rows = parseArtisaCareerPage(`
      <div>
        <h2>Carriera</h2>
        <h2>Architetto qualificato</h2>
        <h4>Losanna</h4>
        <a href="https://app.smartsheet.com/b/form/019c46ebd5137236a9d1b0d500840bf4">Scopri di piu</a>
        <h2>Le nostre sedi</h2>
      </div>
    `);
    expect(rows).toHaveLength(0);
    expect(() => assertCompleteArtisaSnapshot(rows)).toThrow(/not a proven authoritative empty state/);
  });

  // Issue #7425 item 3. The two failures below are indistinguishable from the
  // crawler's floor error alone, yet demand opposite responses: a re-worded
  // landmark is a parser fix and stays red forever, a real opening is the
  // system working and clears itself on the next run. The message has to say
  // which one happened, and quote the h2 headings that decided it.
  it('names a re-worded landmark, and quotes the headings the page rendered', () => {
    const rows = parseArtisaCareerPage(`
      <div>
        <h2>Carriera</h2>
        <h2>Le nostre Sedi in Ticino</h2>
      </div>
    `);
    expect(rows).toHaveLength(0);
    expect(() => assertCompleteArtisaSnapshot(rows)).toThrow(/landmark h2 not found: le nostre sedi/);
    expect(() => assertCompleteArtisaSnapshot(rows)).toThrow(/Le nostre Sedi in Ticino/);
  });

  it('names a counted vacancy instead of blaming the landmarks that are present', () => {
    const rows = parseArtisaCareerPage(`
      <div>
        <h2>Carriera</h2>
        <h2>Architetto qualificato</h2>
        <h2>Le nostre sedi</h2>
      </div>
    `);
    expect(rows).toHaveLength(0);
    expect(() => assertCompleteArtisaSnapshot(rows)).toThrow(/1 candidate vacancy h2 present/);
  });
});
