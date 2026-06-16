import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs helper, no type declarations
import { applyGlossaryCorrections } from '../scripts/lib/translation-glossary.mjs';

describe('translation glossary — protected-term corrections', () => {
  it('fixes Nachtwache → IT timepiece mistranslation', () => {
    expect(applyGlossaryCorrections({
      sourceText: 'Nachtwache',
      translatedText: 'Orologio notturno',
      targetLang: 'it',
    })).toBe('Guardia notturna');
  });

  it('fixes Nachtwache → FR wristwatch mistranslation (singular + plural)', () => {
    expect(applyGlossaryCorrections({
      sourceText: 'Dipl. Pflegefachperson HF für die Nachtwache',
      translatedText: 'Dipl. Spécialiste des soins HF pour les montres de nuit',
      targetLang: 'fr',
    })).toBe('Dipl. Spécialiste des soins HF pour la garde de nuit');
    expect(applyGlossaryCorrections({
      sourceText: 'Nachtwache',
      translatedText: 'Montre de nuit',
      targetLang: 'fr',
    })).toBe('Garde de nuit');
  });

  it('corrects the term embedded mid-title and preserves the rest', () => {
    expect(applyGlossaryCorrections({
      sourceText: 'Dipl. Pflegefachfrau für Nachtwache 60-80 %',
      translatedText: "Dipl. infermiere per l'orologio notturno 60-80 %",
      targetLang: 'it',
    })).toBe('Dipl. infermiere per la guardia notturna 60-80 %');
  });

  it('fixes Taktmontage → clock mistranslation across locales', () => {
    expect(applyGlossaryCorrections({
      sourceText: 'Mechaniker Taktmontage',
      translatedText: 'Montaggio meccanico orologio',
      targetLang: 'it',
    })).toBe('Meccanico montaggio a ciclo');
    expect(applyGlossaryCorrections({
      sourceText: 'Mechaniker Taktmontage',
      translatedText: 'Mechanical clock assembly',
      targetLang: 'en',
    })).toBe('Cycle assembly mechanic');
  });

  it('fixes Dauerwachstation → IT timepiece mistranslation', () => {
    expect(applyGlossaryCorrections({
      sourceText: 'Dipl. Pflegefachmann/-frau als Dauernachtwache-Station',
      translatedText: 'Specialista come stazione di orologio permanente',
      targetLang: 'it',
    })).toBe('Specialista come stazione di sorveglianza permanente');
  });

  it('does NOT touch legitimate watch-industry titles (no trigger in source)', () => {
    // Richemont — "montre mécanique" is a real mechanical watch.
    const fr = "Stage R&I - Compréhension de l'organe moteur d'une montre mécanique";
    expect(applyGlossaryCorrections({ sourceText: fr, translatedText: fr, targetLang: 'fr' })).toBe(fr);
    // OMEGA watch technician — source has no Nachtwache trigger.
    const it = 'OMEGA Luxury Timepieces - Keyholder/Tecnico Orologio';
    expect(applyGlossaryCorrections({
      sourceText: 'OMEGA Luxury Timepieces - Keyholder/Watch Technician',
      translatedText: it,
      targetLang: 'it',
    })).toBe(it);
  });

  it('is a no-op for empty / missing inputs', () => {
    expect(applyGlossaryCorrections({ sourceText: '', translatedText: 'x', targetLang: 'it' })).toBe('x');
    expect(applyGlossaryCorrections({ sourceText: 'Nachtwache', translatedText: '', targetLang: 'it' })).toBe('');
  });
});
