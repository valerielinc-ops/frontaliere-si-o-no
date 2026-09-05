import { describe, it, expect, beforeEach, vi } from 'vitest';
// @ts-expect-error — plain .mjs helper, no type declarations
import { applyGlossaryCorrections, getGlossaryVetoStats, resetGlossaryVetoStats } from '../scripts/lib/translation-glossary.mjs';

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
