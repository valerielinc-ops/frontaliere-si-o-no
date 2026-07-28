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

  it('fixes Levatrice → EN/DE/FR midwife mistranslation (singular + plural)', () => {
    expect(applyGlossaryCorrections({
      sourceText: 'Levatrice/ostetrica',
      translatedText: 'Leverage / midwife',
      targetLang: 'en',
    })).toBe('Midwife / midwife');
    expect(applyGlossaryCorrections({
      sourceText: 'Levatrice/ostetrica',
      translatedText: 'Hebelwirkung/Hebamme',
      targetLang: 'de',
    })).toBe('Hebamme/Hebamme');
    expect(applyGlossaryCorrections({
      sourceText: 'Levatrice/ostetrica',
      translatedText: 'Serveur / sage-femme',
      targetLang: 'fr',
    })).toBe('Sage-femme / sage-femme');
    // Plural source ("Levatrici") must trigger the same fix.
    expect(applyGlossaryCorrections({
      sourceText: 'Levatrici ricercate',
      translatedText: 'Leverage sought',
      targetLang: 'en',
    })).toBe('Midwife sought');
  });

  it('does NOT fire Levatrice trigger on an unrelated longer token (word boundary)', () => {
    const en = 'Senior Leverage Finance Analyst';
    expect(applyGlossaryCorrections({
      sourceText: 'Analista Finanziario Levereggio', // no "levatrice"/"levatrici" substring
      translatedText: en,
      targetLang: 'en',
    })).toBe(en);
  });

  it('is a no-op for empty / missing inputs', () => {
    expect(applyGlossaryCorrections({ sourceText: '', translatedText: 'x', targetLang: 'it' })).toBe('x');
    expect(applyGlossaryCorrections({ sourceText: 'Nachtwache', translatedText: '', targetLang: 'it' })).toBe('');
  });

  // ── #2330 item 3: article-aware regex covers contracted prepositions ──────────
  it('absorbs contracted prepositions before the IT timepiece term (no dangling apostrophe)', () => {
    for (const [contracted, translated] of [
      ["dell'", "Responsabile dell'orologio notturno"],
      ["nell'", "Turni nell'orologio notturno"],
      ["all'", "Assegnato all'orologio notturno"],
      ["sull'", "Report sull'orologio notturno"],
    ] as const) {
      const out = applyGlossaryCorrections({
        sourceText: 'Pflegefachperson Nachtwache',
        translatedText: translated,
        targetLang: 'it',
      });
      // The corrected term is the canonical "la guardia notturna"; crucially no
      // broken "dell'guardia" / "nell'guardia" is produced.
      expect(out).toContain('la guardia notturna');
      expect(out).not.toContain(`${contracted}guardia`);
      expect(out).not.toMatch(/orolog/i);
    }
  });

  it('absorbs FR contracted prepositions before "montre de nuit"', () => {
    expect(applyGlossaryCorrections({
      sourceText: 'Pflegefachperson Nachtwache',
      translatedText: 'Responsable du montre de nuit',
      targetLang: 'fr',
    })).toBe('Responsable la garde de nuit');
  });

  // ── #2330 item 2: glossary scoped to titles; description bodies preserved ─────
  it('applies broad single-word fallback to TITLES (default fieldType)', () => {
    expect(applyGlossaryCorrections({
      sourceText: 'Mechaniker Taktmontage',
      translatedText: 'Montaggio orologio',
      targetLang: 'it',
    })).toBe('Montaggio a ciclo');
  });

  it('does NOT apply broad single-word fallback to DESCRIPTION bodies', () => {
    // A legit "nel nostro orologio" in a long description must survive even when
    // the SOURCE contains the Taktmontage trigger (the bare /\borologio\b/ rule
    // is title-only).
    const body = 'Lavorerai nel nostro orologio aziendale e nella catena di montaggio.';
    expect(applyGlossaryCorrections({
      sourceText: 'Mechaniker Taktmontage in der Fabrik',
      translatedText: body,
      targetLang: 'it',
      fieldType: 'description',
    })).toBe(body);
    // EN clock fallback is likewise title-only on bodies.
    const enBody = 'You will work near the factory clock during your shift.';
    expect(applyGlossaryCorrections({
      sourceText: 'Mechaniker Taktmontage',
      translatedText: enBody,
      targetLang: 'en',
      fieldType: 'description',
    })).toBe(enBody);
  });

  it('STILL corrects the narrow compound mistranslation in DESCRIPTION bodies', () => {
    // The narrow "orologio notturno" compound can only mean the mistranslation,
    // so it is corrected in bodies too (body-safe rule, not title-only).
    expect(applyGlossaryCorrections({
      sourceText: 'Wir suchen für die Nachtwache eine Pflegefachperson.',
      translatedText: "Cerchiamo una persona per l'orologio notturno nel reparto.",
      targetLang: 'it',
      fieldType: 'description',
    })).toBe('Cerchiamo una persona per la guardia notturna nel reparto.');
  });
});
