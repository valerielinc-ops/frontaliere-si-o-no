import { describe, expect, it } from 'vitest';
import { parseArtisaCareerPage } from '../scripts/lib/artisa-job-parser.mjs';

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
