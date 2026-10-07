import { describe, it, expect, beforeEach, vi } from 'vitest';
// @ts-expect-error — plain .mjs helper, no type declarations
import {
  applyGlossaryCorrections,
  finalizeTranslatedText,
  getGlossaryVetoStats,
  normalizeGermanGenderForms,
  restoreProtectedTokens,
  resetGlossaryVetoStats,
  stripPlaceholderTokens,
} from '../scripts/lib/translation-glossary.mjs';

describe('translation glossary — German gender compounds', () => {
  it('collapses standalone and compound frau:mann forms before MT', () => {
    expect(normalizeGermanGenderForms('Frau:mann gesucht')).toBe('mann gesucht');
    expect(normalizeGermanGenderForms('Fachfrau:mann EFZ')).toBe('Fachmann EFZ');
    expect(normalizeGermanGenderForms('Fachfrau:mann / Fachmann')).toBe('Fachmann / Fachmann');
  });
});

describe('translation glossary — protected-term corrections', () => {
  it('does not scrub ordinary ZQ percentage prose when a protected token is present', () => {
    const tokens = [{ hasThird: true, thirdMarker: 'd', upper: false, bracketed: true }];
    expect(restoreProtectedTokens('ZQ 100%', tokens, 'it', { fieldType: 'description' })).toBe('ZQ 100%');
    expect(restoreProtectedTokens('ZQ ①000%', tokens, 'it', { fieldType: 'description' })).toBe('');
  });

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

  // ── Word-level substitution producing nonsense (live 900-page sample) ───────
  //
  // Four new families, all observed as RENDERED Italian job titles. Each broad
  // single-word rule is TITLE_ONLY because the target word is legitimate
  // Italian/English/French prose; the negative cases below are the proof.

  it('fixes Monteur → IT "Mostro" (monster) mistranslation in a title', () => {
    expect(applyGlossaryCorrections({
      sourceText: 'Monteur Elektro-Service',
      translatedText: 'Mostro di servizio elettrico',
      targetLang: 'it',
    })).toBe('Montatore di servizio elettrico');
    expect(applyGlossaryCorrections({
      sourceText: 'Monteure gesucht',
      translatedText: 'Mostro cercato',
      targetLang: 'it',
    })).toBe('Montatore cercato');
    expect(applyGlossaryCorrections({
      sourceText: 'Monteur Elektro-Service',
      translatedText: 'Monster electrical service',
      targetLang: 'en',
    })).toBe('Fitter electrical service');
  });

  it('does NOT rewrite "mostro" = "I show" in a DESCRIPTION body', () => {
    // "mostro" is also the 1st-person present of `mostrare`. The bare-word rule
    // is title-only precisely so this sentence survives.
    const body = 'Durante il tour vi mostro il reparto e presento la squadra.';
    expect(applyGlossaryCorrections({
      sourceText: 'Monteur Elektro-Service in der Werkstatt',
      translatedText: body,
      targetLang: 'it',
      fieldType: 'description',
    })).toBe(body);
  });

  it('fixes Magazin (warehouse) → IT "rivista" (periodical) in a title', () => {
    expect(applyGlossaryCorrections({
      sourceText: 'Magaziner 80-100%',
      translatedText: 'Specialista di rivista 80-100%',
      targetLang: 'it',
    })).toBe('Specialista di magazzino 80-100%');
    expect(applyGlossaryCorrections({
      sourceText: 'Magazinmitarbeiter Lager',
      translatedText: 'Collaboratore riviste',
      targetLang: 'it',
    })).toBe('Collaboratore magazzino');
    expect(applyGlossaryCorrections({
      sourceText: 'Lagermagazin Ersatzteile',
      translatedText: 'Magazine assistant',
      targetLang: 'en',
    })).toBe('Warehouse assistant');
    expect(applyGlossaryCorrections({
      sourceText: 'Magaziner Werkstatt',
      translatedText: 'Collaborateur magazine',
      targetLang: 'fr',
    })).toBe('Collaborateur magasin');
  });

  it('does NOT fire on an editorial "Magazin" (a German periodical is not a warehouse)', () => {
    // The trigger deliberately skips a bare "Magazin" with no logistics
    // co-word: "Redaktor Magazin" really is a magazine editor, and rewriting
    // "rivista"→"magazzino" there would invert a CORRECT translation.
    const it = 'Redattore di rivista culturale';
    expect(applyGlossaryCorrections({
      sourceText: 'Redaktor Magazin Kultur',
      translatedText: it,
      targetLang: 'it',
    })).toBe(it);
    // English-source "magazine" must not trip the trigger either.
    const en = 'Magazine Editor';
    expect(applyGlossaryCorrections({
      sourceText: 'Magazine Editor',
      translatedText: en,
      targetLang: 'en',
    })).toBe(en);
  });

  it('does NOT rewrite "rivista" in a DESCRIPTION body', () => {
    const body = 'Pubblichiamo ogni mese la nostra rivista aziendale interna per i collaboratori.';
    expect(applyGlossaryCorrections({
      sourceText: 'Magaziner Lager Logistik',
      translatedText: body,
      targetLang: 'it',
      fieldType: 'description',
    })).toBe(body);
  });

  it('fixes Fachfrau → IT "moglie" (wife) mistranslation in a title', () => {
    expect(applyGlossaryCorrections({
      sourceText: 'Fachmann/Fachfrau Betriebsunterhalt',
      translatedText: 'Operazioni professionali/moglie',
      targetLang: 'it',
    })).toBe('Operazioni professionali/specialista');
    expect(applyGlossaryCorrections({
      sourceText: 'Fachfrau Betreuung',
      translatedText: 'Care wife',
      targetLang: 'en',
    })).toBe('Care specialist');
    expect(applyGlossaryCorrections({
      sourceText: 'Fachfrau Betreuung',
      translatedText: 'Épouse de soins',
      targetLang: 'fr',
    })).toBe('Spécialiste de soins');
  });

  it('NEVER touches French "femme" — "Femme de chambre" is a real job title', () => {
    for (const fr of ['Femme de chambre', 'Femme de ménage 60%', 'Femme de chambre / Gouvernante']) {
      expect(applyGlossaryCorrections({
        sourceText: 'Fachfrau Hauswirtschaft',
        translatedText: fr,
        targetLang: 'fr',
      })).toBe(fr);
    }
  });

  it('does NOT rewrite "moglie"/"wife" in a DESCRIPTION body', () => {
    const body = 'Il congedo parentale vale anche per la moglie o il partner del dipendente.';
    expect(applyGlossaryCorrections({
      sourceText: 'Fachfrau Betreuung gesucht',
      translatedText: body,
      targetLang: 'it',
      fieldType: 'description',
    })).toBe(body);
  });

  it('restores the proper noun "Apfelbaum" translated as a botanical term', () => {
    expect(applyGlossaryCorrections({
      sourceText: 'Fachfrau Betreuung, Schule Apfelbaum',
      translatedText: 'Cura professionale, scuola mela albero',
      targetLang: 'it',
    })).toBe('Cura professionale, scuola Apfelbaum');
    expect(applyGlossaryCorrections({
      sourceText: 'Betreuung Schule Apfelbaum',
      translatedText: 'Assistenza scuola albero di mele',
      targetLang: 'it',
    })).toBe('Assistenza scuola Apfelbaum');
    expect(applyGlossaryCorrections({
      sourceText: 'Betreuung Schule Apfelbaum',
      translatedText: 'Childcare Apple Tree school',
      targetLang: 'en',
    })).toBe('Childcare Apfelbaum school');
    expect(applyGlossaryCorrections({
      sourceText: 'Betreuung Schule Apfelbaum',
      translatedText: 'Encadrement école pommier',
      targetLang: 'fr',
    })).toBe('Encadrement école Apfelbaum');
  });

  it('does NOT rewrite the single-word "melo"/"pommier" in a DESCRIPTION body', () => {
    // The multi-word renderings are body-safe; the single-word ones are not,
    // because "melo"/"pommier" are ordinary words.
    const body = 'Il giardino della scuola ospita un melo e un ciliegio.';
    expect(applyGlossaryCorrections({
      sourceText: 'Betreuung Schule Apfelbaum im Garten',
      translatedText: body,
      targetLang: 'it',
      fieldType: 'description',
    })).toBe(body);
  });

  it('does NOT fire any of the new rules when the source lacks the trigger', () => {
    // Source-gating is what keeps this glossary surgical.
    for (const [translated, lang] of [
      ['Il mostro di Loch Ness — mascotte aziendale', 'it'],
      ['Redattore di rivista', 'it'],
      ['Assistente per moglie e figli', 'it'],
      ['Monster Energy Brand Ambassador', 'en'],
      ['Vendeur de magazines', 'fr'],
    ] as const) {
      expect(applyGlossaryCorrections({
        sourceText: 'Mitarbeiter Verkauf Innendienst',
        translatedText: translated,
        targetLang: lang,
      })).toBe(translated);
    }
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

  it('fixes "frontalieri" → EN "border guards" false-friend mistranslation', () => {
    expect(applyGlossaryCorrections({
      sourceText: 'I frontalieri lavorano in Svizzera e rientrano in Italia ogni sera.',
      translatedText: 'The border guards work in Switzerland and return to Italy every evening.',
      targetLang: 'en',
      fieldType: 'description',
    })).toBe('The cross-border commuters work in Switzerland and return to Italy every evening.');
    expect(applyGlossaryCorrections({
      sourceText: 'Il frontaliere',
      translatedText: 'The frontier guard',
      targetLang: 'en',
    })).toBe('The cross-border commuters');
  });

  it('fixes "frontalieri" → DE/FR border-guard false-friend mistranslation', () => {
    expect(applyGlossaryCorrections({
      sourceText: 'I frontalieri lavorano in Svizzera.',
      translatedText: 'Die Grenzwächter arbeiten in der Schweiz.',
      targetLang: 'de',
      fieldType: 'description',
    })).toBe('Die Grenzgänger arbeiten in der Schweiz.');
    expect(applyGlossaryCorrections({
      sourceText: 'I frontalieri lavorano in Svizzera.',
      translatedText: 'Les gardes-frontières travaillent en Suisse.',
      targetLang: 'fr',
      fieldType: 'description',
    })).toBe('Les travailleurs frontaliers travaillent en Suisse.');
  });

  it('does NOT fire the frontalieri fix when the source lacks the trigger', () => {
    const translated = 'The border guards inspected every vehicle at the crossing.';
    expect(applyGlossaryCorrections({
      sourceText: 'Guardia di finanza al posto di confine.',
      translatedText: translated,
      targetLang: 'en',
      fieldType: 'description',
    })).toBe(translated);
  });
});

describe('translation glossary — customs-role veto on the frontalieri rule', () => {
  beforeEach(() => resetGlossaryVetoStats());

  // The trigger fires on nearly every record on this site, and the replacement
  // ("cross-border commuters") is a WRONG rendering when the source really is
  // advertising a border-guard / customs job. Corpus co-occurrence was zero on
  // the 2026-09-05 snapshot, but crawlers add records daily, so the veto — not
  // the snapshot — is what keeps a future customs ad from being corrupted.
  const CUSTOMS_SOURCES: Array<[string, string, string, string]> = [
    // [label, sourceText, targetLang, translatedText that the rule would rewrite]
    ['IT guardia di confine', 'Cercasi guardia di confine, frontalieri benvenuti.', 'en', 'Looking for a border guard, cross-border commuters welcome.'],
    ['IT agente doganale', 'Agente doganale a Chiasso; i frontalieri sono i benvenuti.', 'en', 'Customs agent in Chiasso; the border guards are welcome.'],
    ['DE Grenzwächter', 'Grenzwächter gesucht — auch für Grenzgänger und frontalieri.', 'de', 'Die Grenzwächter arbeiten an der Grenze.'],
    ['DE Zollbeamter', 'Zollbeamter gesucht, frontalieri willkommen.', 'de', 'Wir suchen einen Grenzbeamten.'],
    ['FR douanier', 'Douanier recherché, frontaliers bienvenus.', 'fr', 'Les gardes-frontières travaillent à la douane.'],
    ['FR garde-frontière', 'Poste de garde-frontière ouvert aux frontaliers.', 'fr', 'Les gardes-frontières patrouillent.'],
  ];

  it.each(CUSTOMS_SOURCES)('keeps the machine rendering when the source is a real customs role (%s)', (_label, sourceText, targetLang, translated) => {
    expect(applyGlossaryCorrections({
      sourceText,
      translatedText: translated,
      targetLang,
      fieldType: 'description',
    })).toBe(translated);
  });

  it('reports the collision so the co-occurrence is measured continuously, not once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const args = {
        sourceText: 'Cercasi guardia di confine, frontalieri benvenuti.',
        translatedText: 'Looking for a border guard.',
        targetLang: 'en',
        fieldType: 'description',
      };
      applyGlossaryCorrections(args);
      applyGlossaryCorrections(args);

      // Annotated once (a crawler run hits the same ambiguity repeatedly)...
      const annotations = warn.mock.calls.filter(([msg]) => String(msg).startsWith('::warning::[glossary]'));
      expect(annotations).toHaveLength(1);
      expect(String(annotations[0][0])).toContain('frontalier-border-guard');

      // ...but every occurrence is still counted.
      expect(getGlossaryVetoStats()).toEqual([
        expect.objectContaining({ id: 'frontalier-border-guard', targetLang: 'en', count: 2 }),
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('shares the article gates\' anchor, breadth included (plain "dogana" vetoes)', () => {
    // The anchor is ITALIAN_BORDER_GUARD_ANCHOR extended to DE/FR/EN, and it is
    // deliberately broad — a bare "dogana" suppresses the rewrite even when it
    // is only a landmark. That is the documented trade of the shared anchor: a
    // suppressed correction is annotated and countable, a corrupted customs ad
    // is silent. On the corpus this costs nothing (0 of the 94 triggering
    // records match the anchor), and any future cost shows up as a warning.
    const translated = 'Cross-border commuters: the border guards office is 5 minutes away.';
    expect(applyGlossaryCorrections({
      sourceText: 'Frontalieri: ufficio a 5 minuti dalla dogana di Chiasso.',
      translatedText: translated,
      targetLang: 'en',
      fieldType: 'description',
    })).toBe(translated);
    expect(getGlossaryVetoStats()).toEqual([
      expect.objectContaining({ id: 'frontalier-border-guard', count: 1 }),
    ]);
  });

  it('leaves the ordinary frontalieri correction untouched (no veto vocabulary)', () => {
    expect(applyGlossaryCorrections({
      sourceText: 'I frontalieri lavorano in Svizzera e rientrano ogni sera.',
      translatedText: 'The border guards work in Switzerland and return every evening.',
      targetLang: 'en',
      fieldType: 'description',
    })).toBe('The cross-border commuters work in Switzerland and return every evening.');
    expect(getGlossaryVetoStats()).toEqual([]);
  });

  it('does not veto on German "Finanzierung": financing is not customs vocabulary', () => {
    // The anchor is composed FROM the Italian one, so its `finanziere` branch is
    // read against DE/FR/EN sources too, where the same letters mean "financing".
    // Measured on `data/jobs/by-crawler` + `expired` (58 427 records, 2026-09-05):
    // 172 records trigger the rule, 54 matched the anchor, and ALL 54 matched only
    // via that branch — every one of them a banking ad saying `Finanzierung`, zero
    // real customs roles. A veto here would silently keep "Grenzwächter" as the
    // rendering of "frontalieri" in an ad that has nothing to do with the border.
    expect(applyGlossaryCorrections({
      sourceText: 'Interesse an sozialer Sicherheit, persönlicher Finanzierung und Kundenkontakt; frontalieri willkommen.',
      translatedText: 'Die Grenzwächter pendeln täglich.',
      targetLang: 'de',
      fieldType: 'description',
    })).toBe('Die Grenzgänger pendeln täglich.');
    expect(getGlossaryVetoStats()).toEqual([]);
  });

  it('still vetoes on the real Guardia di Finanza noun (the branch is narrowed, not dropped)', () => {
    const translated = 'The border guards of the Guardia di Finanza patrol the area.';
    expect(applyGlossaryCorrections({
      sourceText: 'Il finanziere di stanza al valico; frontalieri benvenuti.',
      translatedText: translated,
      targetLang: 'en',
      fieldType: 'description',
    })).toBe(translated);
    expect(getGlossaryVetoStats()).toEqual([
      expect.objectContaining({ id: 'frontalier-border-guard', count: 1 }),
    ]);
  });

  it('does not leak regex lastIndex between records (the rule regexes carry /g)', () => {
    // The veto path probes the rule pattern; probing must not consume it, or
    // the NEXT record would be silently skipped.
    applyGlossaryCorrections({
      sourceText: 'Cercasi guardia di confine, frontalieri benvenuti.',
      translatedText: 'The border guards are here.',
      targetLang: 'en',
      fieldType: 'description',
    });
    expect(applyGlossaryCorrections({
      sourceText: 'I frontalieri lavorano in Svizzera.',
      translatedText: 'The border guards work in Switzerland.',
      targetLang: 'en',
      fieldType: 'description',
    })).toBe('The cross-border commuters work in Switzerland.');
  });
});

/**
 * A pair of percent-encoded bytes reads exactly like a `%TOKEN%` placeholder.
 * The strip rewrote the URL of every translated text that cited one
 * (`Perch%C3%A9` → `Perch A9`): 13 body fields on the article corpus, all
 * source links, all dead after translation.
 */
describe('translation glossary — placeholder strip leaves links alone', () => {
  const RSI = 'https://www.rsi.ch/info/dialogo/Perch%C3%A9-sviluppare-nuovi-farmaci-costa-sempre-di-pi%C3%B9--4071262.html';

  const OPAQUE_SPAN_CASES = [
    {
      name: 'Markdown destination with a double-quoted title',
      input: 'Prima [città](/wiki/Perch%C3%A9 "titolo") dopo %COMPANY% e basta.',
      expected: 'Prima [città](/wiki/Perch%C3%A9 "titolo") dopo e basta.',
    },
    {
      name: 'Markdown destination with a single-quoted title',
      input: "Prima [città](/wiki/Perch%C3%A9 'titolo') dopo %COMPANY% e basta.",
      expected: "Prima [città](/wiki/Perch%C3%A9 'titolo') dopo e basta.",
    },
    {
      name: 'Markdown destination with a parenthesized title',
      input: 'Prima [città](/wiki/Perch%C3%A9 (titolo)) dopo %COMPANY% e basta.',
      expected: 'Prima [città](/wiki/Perch%C3%A9 (titolo)) dopo e basta.',
    },
    {
      name: 'angle-bracket Markdown destination with a title',
      input: 'Prima [città](</wiki/Perch%C3%A9> "titolo") dopo %COMPANY% e basta.',
      expected: 'Prima [città](</wiki/Perch%C3%A9> "titolo") dopo e basta.',
    },
    {
      name: 'Markdown image destination',
      input: 'Prima immagine:![mappa](/img/Perch%C3%A9.png "titolo") dopo %COMPANY% e basta.',
      expected: 'Prima immagine:![mappa](/img/Perch%C3%A9.png "titolo") dopo e basta.',
    },
    {
      name: 'reference definition with a title',
      input: 'Prima\n[id]: /wiki/Perch%C3%A9 "titolo" %COMPANY%\nDopo.',
      expected: 'Prima\n[id]: /wiki/Perch%C3%A9 "titolo"\nDopo.',
    },
    {
      name: 'protocol-relative naked URL',
      input: 'Prima //host/Perch%C3%A9 dopo %COMPANY% e basta.',
      expected: 'Prima //host/Perch%C3%A9 dopo e basta.',
    },
    {
      name: 'absolute naked URL',
      input: 'Prima https://example.test/Perch%C3%A9 dopo %COMPANY% e basta.',
      expected: 'Prima https://example.test/Perch%C3%A9 dopo e basta.',
    },
    {
      name: 'www naked URL',
      input: 'Prima www.example.test/Perch%C3%A9 dopo %COMPANY% e basta.',
      expected: 'Prima www.example.test/Perch%C3%A9 dopo e basta.',
    },
    {
      name: 'relative naked path with an encoded byte',
      input: 'Prima /wiki/Perch%C3%A9 dopo %COMPANY% e basta.',
      expected: 'Prima /wiki/Perch%C3%A9 dopo e basta.',
    },
    {
      name: 'double-quoted href attribute',
      input: 'Prima <a href="/wiki/Perch%C3%A9">link</a> dopo %COMPANY% e basta.',
      expected: 'Prima <a href="/wiki/Perch%C3%A9">link</a> dopo e basta.',
    },
    {
      name: 'single-quoted src attribute',
      input: "Prima <img src='/img/Perch%C3%A9.png'> dopo %COMPANY% e basta.",
      expected: "Prima <img src='/img/Perch%C3%A9.png'> dopo e basta.",
    },
    {
      name: 'unquoted src attribute',
      input: 'Prima <img src=/img/Perch%C3%A9.png> dopo %COMPANY% e basta.',
      expected: 'Prima <img src=/img/Perch%C3%A9.png> dopo e basta.',
    },
    {
      name: 'schema autolink',
      input: 'Prima <https://example.test/Perch%C3%A9> dopo %COMPANY% e basta.',
      expected: 'Prima <https://example.test/Perch%C3%A9> dopo e basta.',
    },
    {
      name: 'more than one balanced parenthesis level',
      input: 'Prima [x](https://example.test/a(b(c))/Perch%C3%A9) dopo %COMPANY% e basta.',
      expected: 'Prima [x](https://example.test/a(b(c))/Perch%C3%A9) dopo e basta.',
    },
    // `{ID}` rides in every URL below: the percent-encoded bytes alone would be
    // spared by the placeholder pattern even where the scanner missed the URL.
    {
      name: 'reference destination with a backslash-escaped ")"',
      input: 'Prima\n[id]: https://example.test/a\\)b/{ID}/Perch%C3%A9 %COMPANY%\nDopo.',
      expected: 'Prima\n[id]: https://example.test/a\\)b/{ID}/Perch%C3%A9\nDopo.',
    },
    {
      name: 'reference destination with a stray ")"',
      input: 'Prima\n[id]: https://example.test/a)b/{ID}/Perch%C3%A9 %COMPANY%\nDopo.',
      expected: 'Prima\n[id]: https://example.test/a)b/{ID}/Perch%C3%A9\nDopo.',
    },
    {
      name: 'reference definition after a lone carriage return',
      input: 'Prima\r[id]: docs/{ID}/Perch%C3%A9.html %COMPANY%\rDopo.',
      expected: 'Prima\r[id]: docs/{ID}/Perch%C3%A9.html\rDopo.',
    },
    {
      name: 'URL inside the label of a reference definition',
      input: '[vedi https://example.test/{ID}/x]: /dest %COMPANY%',
      expected: '[vedi https://example.test/{ID}/x]: /dest',
    },
    {
      name: 'URL inside a title attribute, next to text that is stripped',
      input: 'Prima <a href="/x" title="Vedi https://example.test/{ID}/Perch%C3%A9 di {COMPANY}">link</a> dopo.',
      expected: 'Prima <a href="/x" title="Vedi https://example.test/{ID}/Perch%C3%A9 di ">link</a> dopo.',
    },
    {
      name: 'relative URL with an encoded byte inside a data attribute',
      input: 'Prima <div data-url="/wiki/{ID}/Perch%C3%A9">x</div> dopo %COMPANY% e basta.',
      expected: 'Prima <div data-url="/wiki/{ID}/Perch%C3%A9">x</div> dopo e basta.',
    },
    {
      name: 'absolute URL glued to a relative path without encoded bytes',
      input: 'Vai su /go?u=https://example.test/{ID}/x oggi %COMPANY% e basta.',
      expected: 'Vai su /go?u=https://example.test/{ID}/x oggi e basta.',
    },
    {
      name: 'www URL after a comma inside a relative token',
      input: 'Vai su /redirect,www.example.test/a{ID} oggi %COMPANY% e basta.',
      expected: 'Vai su /redirect,www.example.test/a{ID} oggi e basta.',
    },
    {
      name: 'unclosed link whose URL runs past a balanced ")"',
      input: 'Vedi [x](https://example.test/a_(b)/{ID}/c dopo %COMPANY% e basta.',
      expected: 'Vedi [x](https://example.test/a_(b)/{ID}/c dopo e basta.',
    },
    {
      name: 'unclosed link with a URL in the middle of its destination',
      input: 'Vedi [x](u=https://example.test/a_(b)/{ID}/c dopo %COMPANY% e basta.',
      expected: 'Vedi [x](u=https://example.test/a_(b)/{ID}/c dopo e basta.',
    },
    {
      name: 'a backslash does not carry a destination across a blank',
      input: 'Vedi [x](a\\ https://example.test/a_(b)/{ID}/c dopo %COMPANY% e basta.',
      expected: 'Vedi [x](a\\ https://example.test/a_(b)/{ID}/c dopo e basta.',
    },
    {
      name: 'a link nested in the destination of one whose title never closes',
      input: 'Vedi x](a](/rel/{ID}/y) (titolo %COMPANY% e basta.',
      expected: 'Vedi x](a](/rel/{ID}/y) (titolo e basta.',
    },
  ] as const;

  it.each(OPAQUE_SPAN_CASES)('preserves the opaque destination: $name', ({ input, expected }) => {
    expect(stripPlaceholderTokens(input)).toBe(expected);
  });

  it('keeps an escaped close parenthesis inside a reference destination', () => {
    const input = '[id]: https://example.test/a\\)b/Perch%C3%A9';
    expect(stripPlaceholderTokens(input)).toBe(input);
  });

  // The scanner protects the URL syntax it recognises; the pattern itself must
  // not read percent-encoded bytes as a token where no syntax can be recognised.
  const ENCODED_OUTSIDE_URL_CASES = [
    ['a path of prose without a leading slash', 'Scarica docs/Perch%C3%A9.html oggi'],
    ['a three-byte character in a file name', 'Tema: l%E2%80%99UE e la Svizzera'],
    ['a four-byte character', 'File a%F0%9F%98%80b.png allegato'],
    ['a lower-case second byte', 'File Perch%C3%a9.pdf allegato'],
    ['the tail of a bare URL cut short by a stray ")"', 'Vedi https://example.test/a)b/Perch%C3%A9 oggi'],
  ] as const;

  it.each(ENCODED_OUTSIDE_URL_CASES)('never reads percent-encoded bytes as a placeholder: %s', (_name, text) => {
    expect(stripPlaceholderTokens(text)).toBe(text);
    expect(stripPlaceholderTokens(`${text} %COMPANY%`)).toBe(text);
  });

  it('still strips a percent token that is not URL encoding', () => {
    expect(stripPlaceholderTokens('Lavora per %COMPANY% oggi')).toBe('Lavora per oggi');
    // A two-letter name is a token unless another encoded byte follows it.
    expect(stripPlaceholderTokens('Codice %AB% valido')).toBe('Codice valido');
    expect(stripPlaceholderTokens('Da %NOME%da domani')).toBe('Da da domani');
    expect(stripPlaceholderTokens('Sigla %AB%CD intatta')).toBe('Sigla %AB%CD intatta');
  });

  it('keeps percent-encoded bytes inside a Markdown link target', () => {
    const text = `*Fonte: [rsi.ch](${RSI})*`;
    expect(stripPlaceholderTokens(text)).toBe(text);
  });

  it('keeps percent-encoded bytes inside a bare URL and a relative link', () => {
    for (const text of [
      'Vedi https://www.rsi.ch/info/svizzera/Frontalieri-disoccupati-l%E2%80%99UE-approva e basta.',
      '[guida](/it/guida%C3%A8/) e [calcolatore](nav:calculator)',
    ]) {
      expect(stripPlaceholderTokens(text)).toBe(text);
    }
  });

  it('keeps the whole destination when the URL carries balanced parentheses', () => {
    // Closing the span at the first `)` left the rest of the URL exposed:
    // `…/a(b)/Perch%C3%A9` came back as `…/a(b)/Perch A9`.
    for (const text of [
      '[RSI](https://example.test/a(b)/Perch%C3%A9)',
      '[Lugano](https://it.wikipedia.org/wiki/Lugano_(citt%C3%A0))',
      'Fonte: https://example.test/a(b)/Perch%C3%A9 e basta.',
      'Fonte: https://it.wikipedia.org/wiki/Lugano_(citt%C3%A0)/Perch%C3%A9 e basta.',
      // A lone `(` is still part of the URL, as before.
      '[x](https://example.test/a(b/Perch%C3%A9) e https://example.test/a(b/Perch%C3%A9 poi',
    ]) {
      expect(stripPlaceholderTokens(text), text).toBe(text);
    }
  });

  it('a bare URL quoted inside a parenthesis of prose ends before the closing one', () => {
    // The placeholder after the parenthesis is prose and is still stripped;
    // the URL before it is returned byte for byte.
    expect(stripPlaceholderTokens('(vedi https://example.test/Perch%C3%A9) per %COMPANY% a Lugano'))
      .toBe('(vedi https://example.test/Perch%C3%A9) per a Lugano');
    expect(stripPlaceholderTokens('(vedi https://example.test/a(b)/Perch%C3%A9) per %COMPANY% a Lugano'))
      .toBe('(vedi https://example.test/a(b)/Perch%C3%A9) per a Lugano');
  });

  it('still strips a real placeholder next to a link, and leaves the link intact', () => {
    expect(stripPlaceholderTokens(`Lavora con {COMPANY} — fonte ${RSI}`)).toBe(`Lavora con — fonte ${RSI}`);
    expect(stripPlaceholderTokens('Offerta di %COMPANY% a Lugano')).toBe('Offerta di a Lugano');
    const linked = stripPlaceholderTokens(`[{{title}}](${RSI})`);
    expect(linked).not.toContain('{{title}}');
    expect(linked).toContain(`](${RSI})`);
  });

  it('the exit transform returns the link of a translated source line unchanged', () => {
    const source = `*Fonte: [rsi.ch](${RSI})*`;
    expect(
      finalizeTranslatedText({
        sourceText: source,
        translatedText: `*Quelle: [rsi.ch](${RSI})*`,
        targetLang: 'de',
        fieldType: 'description',
      }),
    ).toBe(`*Quelle: [rsi.ch](${RSI})*`);
  });

  it('preserves ordinary slash prose and keeps the placeholder vocabulary case-sensitive', () => {
    expect(stripPlaceholderTokens('e/o km/h 24/7 (AZIENDA) (azienda) %COMPANY%')).toBe('e/o km/h 24/7 (azienda)');
  });

  const NUL = '\u0000';
  const EXISTING_SLOT_SHAPED_NUL = `${NUL}7${NUL}`;
  const NUL_CASES = [
    {
      name: 'NUL without a link or placeholder',
      input: `prima${EXISTING_SLOT_SHAPED_NUL}dopo`,
      expected: `prima${EXISTING_SLOT_SHAPED_NUL}dopo`,
    },
    {
      name: 'NUL with a placeholder but no link',
      input: `prima${EXISTING_SLOT_SHAPED_NUL} %COMPANY% dopo`,
      expected: `prima${EXISTING_SLOT_SHAPED_NUL} dopo`,
    },
    {
      name: 'NUL with a link but no placeholder',
      input: `prima${EXISTING_SLOT_SHAPED_NUL} [link](/wiki/Perch%C3%A9) dopo`,
      expected: `prima${EXISTING_SLOT_SHAPED_NUL} [link](/wiki/Perch%C3%A9) dopo`,
    },
    {
      name: 'NUL with a link and a placeholder',
      input: `prima${EXISTING_SLOT_SHAPED_NUL} [link](/wiki/Perch%C3%A9) %COMPANY% dopo`,
      expected: `prima${EXISTING_SLOT_SHAPED_NUL} [link](/wiki/Perch%C3%A9) dopo`,
    },
  ] as const;

  it.each(NUL_CASES)('restores only its own slots: $name', ({ input, expected }) => {
    const output = stripPlaceholderTokens(input);
    expect(output).toBe(expected);
    expect(output).not.toContain('undefined');
  });

  it('scans 200 KB of unclosed parentheses and quotes within the linearity budget', () => {
    const pathological = `[x](${`(`.repeat(100_000)}\n<a href="${'x'.repeat(100_000)} %COMPANY%`;
    const startedAt = performance.now();
    const output = stripPlaceholderTokens(pathological);
    const elapsedMs = performance.now() - startedAt;

    expect(output).not.toContain('%COMPANY%');
    expect(output).not.toContain('undefined');
    expect(elapsedMs).toBeLessThan(1000);
  });

  // A scan that fails must not make the scanner skip text: the first version
  // of the scanner resumed at the end of the text (or at the next `>`) after
  // an unterminated title or a `<` of prose, and every URL after that point
  // lost its protection — `/wiki/Perch A9` again, a regression against the
  // regular expression it replaced.
  const RELATIVE = '/wiki/Perch%C3%A9';
  const ABSOLUTE = 'https://it.wikipedia.org/wiki/Citt%C3%A0_(Svizzera)';
  const AFTER_MALFORMED_CASES = [
    {
      name: 'a link title whose quote never closes, links two lines below',
      input: `Vedi [a](/x "titolo non chiuso\n\nSegnaposto %COMPANY% qui.\n\nPoi [città](${RELATIVE}) e ${ABSOLUTE} fine.`,
    },
    {
      name: 'a "<" of prose with no ">" on its line, links two lines below',
      input: `Soglia <CHF 3.000 al mese %COMPANY%.\n\nPoi [città](${RELATIVE}) e ${ABSOLUTE} fine.`,
    },
    {
      name: 'a "<" of prose with a ">" further on the same line',
      input: `Se x <y allora [città](${RELATIVE}) e z> w %COMPANY% fine.`,
    },
    {
      name: 'an angle destination that never closes, link below',
      input: `Vedi [a](</x non chiusa %COMPANY%\n\nPoi [città](${RELATIVE}) fine.`,
    },
    {
      name: 'a valid link on the same line, after the malformed one',
      input: `Vedi [a](/x "non chiuso e poi [città](${RELATIVE}) %COMPANY% fine.`,
    },
    {
      name: 'the destination of a malformed link is itself a bare URL',
      input: `Vedi [a](${ABSOLUTE} "titolo" extra) %COMPANY% fine.`,
    },
    {
      name: 'an unquoted attribute soup that is not a tag',
      input: `Prezzo <b [non un tag] %COMPANY% e poi ${ABSOLUTE} > fine.`,
    },
  ];

  it.each(AFTER_MALFORMED_CASES)('keeps protecting what follows $name', ({ input }) => {
    const output = stripPlaceholderTokens(input);
    expect(output).not.toContain('%COMPANY%');
    for (const url of [RELATIVE, ABSOLUTE]) {
      if (input.includes(url)) expect(output).toContain(url);
    }
  });

  // The property behind the cases above, checked on generated text instead of
  // on the shapes someone thought of: whatever precedes or follows it, a URL
  // delimited by blanks comes back byte for byte. Each URL carries a placeholder
  // shape other than encoded bytes, which the pattern would spare even where
  // the scanner missed the URL. Deterministic: the generator is seeded.
  // Measured on 400,000 texts when this was written: 160,271 URLs lost by the
  // regular expression this scanner replaced, 1,292 by its first version.
  it('returns a blank-delimited URL intact after any generated text', () => {
    const FRAGMENTS = [
      '](', '(', ')', '"', "'", '<', '>', '<a ', '</a>', 'x=', 'href=', 'title=', '[', ']', ']:', '[id]: ',
      '/', './', '//', 'http://', 'https://h.test/p', 'www.', ' ', '\t', '\\', '%C3%', '%NOME%', '{ID}', 'a', 'b/c',
      ',', '.', '=', '!', '`',
    ];
    const URLS = [
      'https://example.test/{ID}/x__AB__',
      'https://example.test/Perch%C3%A9_(x)/%COMPANY%',
      '/wiki/Perch%C3%A9/{ID}',
      'www.example.test/%COMPANY%/a',
      '//cdn.example.test/[[slot]]/a',
    ];
    let seed = 0x9e3779b9;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (list: readonly string[]) => list[Math.floor(random() * list.length)];
    const generated = () => {
      let text = '';
      const length = Math.floor(random() * 26);
      for (let index = 0; index < length; index += 1) text += random() < 0.06 ? '\n' : pick(FRAGMENTS);
      return text;
    };

    const lost: string[] = [];
    for (let iteration = 0; iteration < 20_000; iteration += 1) {
      const url = pick(URLS);
      const before = pick([' ', '\n', '\t', '\r\n']);
      const after = pick([' ', '\n', '\t', '\r\n', '']);
      const text = `${generated()}${before}${url}${after}${after ? generated() : ''}`;
      if (!stripPlaceholderTokens(text).includes(url)) lost.push(JSON.stringify(text));
    }
    expect(lost.slice(0, 3)).toEqual([]);
  });

  it('still reads a real HTML tag: href/src values are opaque, other attributes stay text', () => {
    const input = `<a class="(AZIENDA)" href="/x/(AZIENDA)/y" title=ok>link</a> <img src='/i/(AZIENDA).png'/> %COMPANY%`;
    const output = stripPlaceholderTokens(input);
    expect(output).toContain('href="/x/(AZIENDA)/y"');
    expect(output).toContain("src='/i/(AZIENDA).png'");
    expect(output).not.toContain('class="(AZIENDA)"');
    expect(output).not.toContain('%COMPANY%');
  });

  it('protects a destination longer than the scan cap as a bare URL', () => {
    const absolute = `https://example.org/${'a'.repeat(700)}/Perch%C3%A9?x=${'b'.repeat(300)}`;
    const relative = `/wiki/${'a'.repeat(700)}/Perch%C3%A9`;
    const output = stripPlaceholderTokens(`Vedi [qui](${absolute}) e [qua](${relative}) %COMPANY% fine.`);
    expect(output).toContain(absolute);
    expect(output).toContain(relative);
    expect(output).not.toContain('%COMPANY%');
  });

  // Linearity without skipping: each shape below made a naive "retry from the
  // next character" scanner quadratic, and made the regular expression it
  // replaced take tens of seconds.
  const PATHOLOGICAL_SHAPES = [
    ['unbalanced openers after "]("', `[x](${'('.repeat(200_000)}`],
    ['"](" repeated with no closer at all', '](a'.repeat(66_000)],
    ['"](" repeated, one closer at the very end', `${']('.repeat(100_000)})`],
    // The worst shape: closers everywhere, never one that balances. No
    // per-line memory can answer it in advance; the length cap bounds it.
    ['closers that never balance from any start', `${']('.repeat(499)}))`.repeat(200)],
    ['"<a " repeated with no ">"', '<a '.repeat(66_000)],
    ['a title quote that never closes, repeated', '](a "b '.repeat(28_000)],
    ['a parenthesized title that never balances', `${'](a (('.repeat(33_000)})`],
    ['an attribute value whose quote never closes', '<a href="x '.repeat(18_000)],
    // Review of 12095: 22.8 s on 195 KB before the tag scan had a cap.
    ['unquoted attributes that never reach a ">"', '<a x='.repeat(40_000)],
    ['unquoted attributes ending in an unclosed quote and a ">"', `${'<a x='.repeat(40_000)}<a y="aperta >`],
    ['relative paths nested in one token', `/${'./'.repeat(100_000)}`],
    ['a title opener after the last ")" of the line', `${'](a'.repeat(30_000)}) (${'x'.repeat(100_000)}`],
    // Not the scanner: the spacing tidy-up after the strip, quadratic on main.
    ['emptied brackets side by side', '[] '.repeat(66_000)],
    // The label repair after the strip: 10 to 27 s on these before it was
    // bounded to a short window in front of each destination.
    ['placeholder labels on tens of thousands of links', '[COMPANY](a) '.repeat(40_000)],
    ['emptied labels on tens of thousands of links', '[{COMPANY}](a) '.repeat(40_000)],
    ['placeholder alternative text on tens of thousands of images', '![COMPANY](a) '.repeat(40_000)],
    ['labels that lost their closing bracket, repeated', '[x [COMPANY]](a) '.repeat(30_000)],
    ['doubled closing brackets in front of every destination', ']](a) '.repeat(40_000)],
  ] as const;

  it.each(PATHOLOGICAL_SHAPES)('stays within the linearity budget on %s', (_name, shape) => {
    const input = `${shape} %COMPANY% ${ABSOLUTE}`;
    const startedAt = performance.now();
    const output = stripPlaceholderTokens(input);
    const elapsedMs = performance.now() - startedAt;
    expect(output).not.toContain('%COMPANY%');
    expect(output).toContain(ABSOLUTE);
    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe('translation glossary — a placeholder used as link text', () => {
  // Review of the corpus transport 2418: the opaque span of a Markdown link
  // started at `](`, so the closing bracket of the label was hidden and
  // `[COMPANY](…)` kept its placeholder as publishable link text. An emptied
  // label stays an empty label, as a template placeholder always left it.
  const LABEL_CASES = [
    {
      name: 'the label is a vocabulary placeholder',
      input: 'Lavora con [COMPANY](https://example.ch/jobs) a Lugano',
      expected: 'Lavora con [](https://example.ch/jobs) a Lugano',
    },
    {
      name: 'the label is a template placeholder',
      input: 'Lavora con [{COMPANY}](https://example.ch/jobs) a Lugano',
      expected: 'Lavora con [](https://example.ch/jobs) a Lugano',
    },
    {
      name: 'the label is a double-bracket placeholder',
      input: 'Lavora con [[COMPANY]](https://example.ch/jobs) a Lugano',
      expected: 'Lavora con [](https://example.ch/jobs) a Lugano',
    },
    {
      name: 'the link is the whole text',
      input: '[COMPANY](https://example.ch/jobs)',
      expected: '[](https://example.ch/jobs)',
    },
    {
      name: 'a placeholder at the end of a label that keeps its text',
      input: 'Vedi [offerta {COMPANY}](https://example.ch/{ID}/x) ora',
      expected: 'Vedi [offerta](https://example.ch/{ID}/x) ora',
    },
    {
      name: 'a placeholder at the start of a label that keeps its text',
      input: 'Vedi [{COMPANY} offerta](https://example.ch/x) ora',
      expected: 'Vedi [offerta](https://example.ch/x) ora',
    },
    {
      name: 'a placeholder that takes the closing bracket of the label with it',
      input: '[x [COMPANY]](https://example.ch/a)',
      expected: '[x](https://example.ch/a)',
    },
    {
      name: 'a nested bracket in a label that keeps its text',
      input: '[a [b] {COMPANY}](https://e.ch/n)',
      expected: '[a [b]](https://e.ch/n)',
    },
    {
      name: 'an image whose alternative text is a placeholder',
      input: 'Logo ![COMPANY](https://cdn.example/logo.png) qui',
      expected: 'Logo ![](https://cdn.example/logo.png) qui',
    },
    {
      name: 'an image whose alternative text is emptied',
      input: 'Logo ![{COMPANY}](https://cdn.example/logo.png) qui',
      expected: 'Logo ![](https://cdn.example/logo.png) qui',
    },
    {
      name: 'an image that keeps part of its alternative text',
      input: 'Logo ![foto {COMPANY}](https://cdn.example/logo.png) qui',
      expected: 'Logo ![foto](https://cdn.example/logo.png) qui',
    },
    {
      name: 'an untouched link next to a placeholder in prose',
      input: 'Lavora con [Acme SA](https://example.ch/jobs) a Lugano {COMPANY}',
      expected: 'Lavora con [Acme SA](https://example.ch/jobs) a Lugano',
    },
    {
      name: 'a bracketed note in front of a link whose label loses a placeholder',
      input: 'vedi [1] [nota {COMPANY}](https://e.ch/n) e [COMPANY]',
      expected: 'vedi [1] [nota](https://e.ch/n) e',
    },
    {
      name: 'an image opener keeps the blank in front of it',
      input: 'Guarda ![img](https://cdn.example/a.png) {COMPANY}',
      expected: 'Guarda ![img](https://cdn.example/a.png)',
    },
  ] as const;

  it.each(LABEL_CASES)('$name', ({ input, expected }) => {
    expect(stripPlaceholderTokens(input)).toBe(expected);
  });

  it('never drops a destination, whatever happens to its label', () => {
    for (const { input } of LABEL_CASES) {
      const destinations = [...input.matchAll(/\]\((https?:[^)\s]+)\)/g)].map((match) => match[1]);
      const output = stripPlaceholderTokens(input);
      for (const destination of destinations) expect(output).toContain(`(${destination})`);
      expect(output).not.toMatch(/COMPANY/);
    }
  });

  it('leaves the tail of an unclosed link alone (second finding of the same review, not reproduced)', () => {
    for (const input of ['Vedi [x](https://h/a_(b)/tail%COMPANY% fine', 'Vedi [x](https://h/a_(b)/tail%COMPANY%']) {
      expect(stripPlaceholderTokens(input)).toBe(input);
    }
  });

  it('repairs a label behind a long paragraph and a second link on the same line', () => {
    const prose = 'parola '.repeat(400);
    const input = `${prose}[offerta {COMPANY}](https://e.ch/x) ${prose}[COMPANY](https://e.ch/y)`;
    expect(stripPlaceholderTokens(input)).toBe(`${prose}[offerta](https://e.ch/x) ${prose}[](https://e.ch/y)`);
  });
});
