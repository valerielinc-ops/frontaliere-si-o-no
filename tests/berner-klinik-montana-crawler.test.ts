/**
 * Berner Klinik Montana — offer-page body.
 *
 * Fixture: live offer page "Infirmier/ère 100%" (2026-09-29), minimized to the
 * site search form and the article; the contact person is a placeholder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractBernerKlinikDetailText } from '../scripts/lib/berner-klinik-montana-job-parser.mjs';

const DETAIL = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'berner-klinik-montana', 'detail-infirmier.html'),
  'utf8',
);

describe('extractBernerKlinikDetailText', () => {
  it('opens on the offer lead, not on the site search form', () => {
    const text = extractBernerKlinikDetailText(DETAIL);
    expect(text.startsWith('Notre clinique réadaptation située à Crans-Montana')).toBe(true);
    expect(text).not.toMatch(/Recherche pour|Merci de saisir un mot-clé/);
  });

  it('keeps every section heading on its own line with its list', () => {
    const text = extractBernerKlinikDetailText(DETAIL);
    expect(text).toContain('Vos activités\n• Identifier, planifier, exécuter et évaluer');
    expect(text).toContain('Votre profil\n• Diplôme en soins infirmiers ES ou HES');
    expect(text).toContain('Nous offrons\n• Une expérience unique de travail interdisciplinaire');
  });

  it('reads the application paragraph to the end, without the download button', () => {
    const text = extractBernerKlinikDetailText(DETAIL);
    expect(text).toContain('rh@bernerklinik.ch');
    expect(text.endsWith('La clinique se réserve le droit de ne pas répondre aux dossiers incomplets.')).toBe(true);
    expect(text).not.toContain('Télécharger');
  });

  it('returns an empty string without an entry-content block', () => {
    expect(extractBernerKlinikDetailText('<main><p>Recherche pour : Recherche</p></main>')).toBe('');
  });
});
