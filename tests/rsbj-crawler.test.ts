/**
 * RSBJ (Réseau Santé Balcon du Jura Vaudois) — offer-page body.
 *
 * Fixture: live Jalios offer page "Des médecins porteurs du titre fédéral
 * postgradué de Médecine Interne Générale (FMH)" (2026-09-29), minimized to
 * the header menu, one side-column `wysiwyg` block and the offer; contact
 * persons are placeholders.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractRsbjDetailText } from '../scripts/lib/rsbj-job-parser.mjs';

const DETAIL = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'rsbj', 'detail-medecins-fmh.html'),
  'utf8',
);

describe('extractRsbjDetailText', () => {
  it('starts with the offer facts, not the header menu or the side column', () => {
    const text = extractRsbjDetailText(DETAIL);
    expect(text.startsWith('Type de Contrat : CDI\nTaux : 100 %\nDate d\'entrée : de suite ou à convenir')).toBe(true);
    expect(text).not.toMatch(/Horaires|Accès sécurisé|Référence/);
  });

  it('reads the whole ad, including the sections the 25-fragment cap used to cut', () => {
    const text = extractRsbjDetailText(DETAIL);
    expect(text).toContain('Vous…\n• Êtes au bénéfice d\'un doctorat en médecine');
    expect(text).toContain('Nous offrons…\n• L\'opportunité pour un médecin indépendant');
    expect(text).toContain('• Un travail en partenariat au sein d\'un collège médical régional');
    expect(text).toContain('Votre candidature avec curriculum vitae et documents usuels');
  });

  it('drops the apply button and stray punctuation-only paragraphs', () => {
    const text = extractRsbjDetailText(DETAIL);
    expect(text).not.toContain('Postuler');
    expect(text).not.toMatch(/^\s*\.\s*$/m);
  });

  it('returns an empty string for a page without an offer body', () => {
    expect(extractRsbjDetailText('<ul><li>Horaires</li></ul><div class="wysiwyg classic"><p>Menu</p></div>')).toBe('');
  });
});
