/**
 * Guard for the shared recruiter-contact PII sanitizer.
 *
 * Scraped vacancy bodies sometimes name an individual recruiter + their direct
 * phone line, and embed the agent's name in the agency-designation address line.
 * Re-publishing that is personal data we have no basis to mirror (erasure
 * request, 2026-06-05). stripContactPII removes the name + phone while preserving
 * the rest of the description, and must NOT touch ordinary numbers (postal codes,
 * salaries, years), French typographic spacing, or city/region designations.
 *
 * Fixtures use SYNTHETIC names/phones on purpose — the regex behavior is
 * identical for any name, and the test must not itself re-commit real PII.
 */
import { describe, it, expect } from 'vitest';
import { stripContactPII } from '../scripts/lib/strip-contact-pii.mjs';

describe('stripContactPII', () => {
  it('removes "contattare <Name> (tel. …)" name + phone, keeps the sentence', () => {
    const out = stripContactPII(
      'Per qualsiasi chiarimento puoi contattare Luca Bianchi (tel. 058 123 45 67) quando vuoi.',
    );
    expect(out).not.toMatch(/Luca Bianchi/);
    expect(out).not.toMatch(/058 123 45 67/);
    expect(out).toMatch(/Per qualsiasi chiarimento puoi contattare l'agenzia quando vuoi\./);
  });

  it('removes the recruiter name from the address block too', () => {
    // Real-shape insurer body (fixture uses a fictional company name): the agent's name fills its own address line.
    const out = stripContactPII(
      'contattare Mario Rossi (tel. 058 123 45 67) quando vuoi.Assicura Helvetica\nAgenzia generale Mario Rossi\nPiazza del Sole\n6500 Bellinzona',
    );
    expect(out).not.toMatch(/Mario Rossi/);
    expect(out).not.toMatch(/058 123 45 67/);
    // Agency designation survives without the personal name; address intact.
    expect(out).toMatch(/Agenzia generale\nPiazza del Sole\n6500 Bellinzona/);
  });

  it('strips the person name from the address block even when not the phone contact', () => {
    // Phone contact is one person, but the address block names the agent.
    const out = stripContactPII(
      'contattare Luca Bianchi (tel. 058 123 45 08) quando vuoi.Assicura Helvetica\nAgenzia generale Mario Rossi\nPiazza del Sole\n6500 Bellinzona',
    );
    expect(out).not.toMatch(/Luca Bianchi/);
    expect(out).not.toMatch(/Mario Rossi/);
    expect(out).toMatch(/Agenzia generale\nPiazza del Sole/);
  });

  it('strips the person name in the single-line (locale-collapsed) address variant', () => {
    // descriptionByLocale.it collapses newlines to spaces: the name is then
    // followed by an Italian street prefix ("Piazza") rather than a newline.
    const out = stripContactPII(
      "puoi contattare l'agenzia quando vuoi. Assicura Helvetica Agenzia generale Mario Rossi Piazza del Sole 6500 Bellinzona",
    );
    expect(out).not.toMatch(/Mario Rossi/);
    expect(out).toMatch(/Agenzia generale Piazza del Sole 6500 Bellinzona/);
  });

  it('strips the person name from the translated agency designations (EN/DE/FR)', () => {
    const cases = [
      'when you want. Assicura Helvetica General Agency Mario Rossi Piazza del Sole 6500',
      'wenn Sie möchten. Assicura Helvetica Allgemeine Agentur Mario Rossi Piazza del Sole 6500',
      'vous le souhaitez. Assicura Helvetica Agence générale Mario Rossi Piazza del Sole 6500',
    ];
    for (const c of cases) {
      const out = stripContactPII(c);
      expect(out).not.toMatch(/Mario Rossi/);
      expect(out).toMatch(/Piazza del Sole 6500/);
    }
  });

  it('preserves a single-word city designation followed by a street prefix', () => {
    const text =
      'contattare Tizio Caio (tel. 091 000 00 00). Agenzia generale Bellinzona Piazza del Sole 6500';
    expect(stripContactPII(text)).toMatch(/Agenzia generale Bellinzona Piazza del Sole/);
  });

  it('preserves single-word city/region agency designations', () => {
    for (const place of ['Bellinzona', 'Sopraceneri', 'Lugano', 'Coira']) {
      const text = `contattare Tizio Caio (tel. 091 000 00 00).\nAgenzia generale ${place}\nPiazza del Sole`;
      expect(stripContactPII(text)).toMatch(
        new RegExp(`Agenzia generale ${place}\\nPiazza del Sole`),
      );
    }
  });

  it('does NOT treat a lowercase phrase before "(tel. …)" as a name (precision guard)', () => {
    // Without the case-insensitive `i` flag, NAME must start uppercase, so a
    // generic lowercase phrase is left in place — only the phone is stripped.
    const out = stripContactPII('Per info contattare il nostro team (tel. 058 123 45 67).');
    expect(out).toMatch(/contattare il nostro team/);
    expect(out).not.toMatch(/058 123 45 67/);
  });

  it('still matches a sentence-initial capitalized verb "Contattare"', () => {
    const out = stripContactPII('Contattare Mario Rossi (tel. 058 123 45 67) per info.');
    expect(out).not.toMatch(/Mario Rossi/);
    expect(out).not.toMatch(/058 123 45 67/);
    expect(out).toMatch(/Contattare l'agenzia per info\./);
  });

  it('strips a phone inside a "(Name, phone)" list but keeps the name', () => {
    const out = stripContactPII('Setzen Sie sich mit (Anna Verdi, 056 100 20 30) in Kontakt.');
    expect(out).toMatch(/\(Anna Verdi\)/);
    expect(out).not.toMatch(/056 100 20 30/);
  });

  it('strips +41 mobile numbers', () => {
    const out = stripContactPII('Cellulare M +41 76 123 45 67 per info.');
    expect(out).not.toMatch(/123 45 67/);
  });

  it('keeps postal codes, salaries and years (no false phone match)', () => {
    const text =
      'Sede 6500 Bellinzona, stipendio fino a 7500 CHF nel 2026 — 4 settimane di ferie.';
    expect(stripContactPII(text)).toBe(text);
  });

  it('does not strip ordinary capitalized word pairs without a phone anchor', () => {
    const text = 'Assicura Helvetica è leader nel settore. Agenzia generale Sopraceneri, Ticino.';
    expect(stripContactPII(text)).toBe(text);
  });

  it('preserves the French typographic space before ":" / ";"', () => {
    // The space-before-colon must survive even when a removal happened elsewhere.
    const out = stripContactPII("contattare Tizio Caio (tel. 091 000 00 00). Numéro : 2025-1 ; fin.");
    expect(out).toMatch(/Numéro : 2025-1 ; fin\./);
  });

  it('is idempotent', () => {
    const once = stripContactPII(
      'contatti Luca Bianchi (tel. 058 123 45 08). Indirizzo 6500 Bellinzona.',
    );
    expect(stripContactPII(once)).toBe(once);
  });

  it('passes through empty / non-string input unchanged', () => {
    expect(stripContactPII('')).toBe('');
    expect(stripContactPII(undefined)).toBe(undefined);
  });
});
