/**
 * Tests for the locale side of the factuality gates:
 * scripts/lib/article-locale-lexicon.mjs plus the checks in
 * article-factuality-gates.mjs that read a translation.
 *
 * WHY THESE EXIST. The gates ran on the Italian body only, because that is
 * where generation happens. en/de/fr are translations of it, so the whole
 * translation step was ungated — and on 2026-07-28 "frontalieri" was found, by
 * hand, shipped as "border guards" in 7 English titles/excerpts and as
 * "gardes-frontières" in a French one. A border guard is a different
 * profession, on a site whose entire audience is cross-border commuters.
 *
 * Every describe below pairs a POSITIVE case (defective translation, must
 * fire) with a NEGATIVE one (correct translation, must stay silent). The
 * negatives are not padding: these checks block publication, so a false
 * positive stalls the content pipeline exactly as badly as a miss, and the
 * negatives here are the shapes that actually produced false positives when
 * the checks were first measured over the 3.5k-article corpus.
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalNumeric,
  extractNumericFacts,
  lexiconFor,
  LOCALE_LEXICON,
} from '../scripts/lib/article-locale-lexicon.mjs';
import {
  checkInlineArithmetic,
  checkTaxPlausibility,
  checkTranslationNumericConsistency,
  checkTranslationFalseFriends,
  runFactualityGates,
} from '../scripts/lib/article-factuality-gates.mjs';

const codes = (issues: any[]) => issues.map((i) => i.code);

describe('canonicalNumeric', () => {
  // The corpus mixes conventions INSIDE a locale — translations routinely keep
  // the Italian punctuation — so the separator role is read from the shape of
  // the token, never from the file it came from.
  it('reads the same amount written in any of the four conventions', () => {
    for (const written of ['60.000', '60,000', "60'000", '60 000']) {
      expect(canonicalNumeric(written), written).toBe(60000);
    }
  });

  it('reads a decimal written with either separator', () => {
    expect(canonicalNumeric('0,25')).toBe(0.25);
    expect(canonicalNumeric('0.25')).toBe(0.25);
    expect(canonicalNumeric('4,65')).toBe(4.65);
  });

  it('reads grouped-and-fractional numbers in both directions', () => {
    // The exact pair the brief calls out: English 60,000.50 vs Italian 60.000,50.
    expect(canonicalNumeric('60,000.50')).toBe(60000.5);
    expect(canonicalNumeric('60.000,50')).toBe(60000.5);
    expect(canonicalNumeric('1.234,56')).toBeCloseTo(1234.56);
    expect(canonicalNumeric('1,234.56')).toBeCloseTo(1234.56);
  });

  it('tolerates the mangled Swiss apostrophe the German bodies carry', () => {
    // 113 German bodies contain "CHF 80 '000" / "CHF 120' 000" — the translation
    // step inserted a space next to the separator. Read strictly, those become
    // the number 80 and every one of them looks like a 1000x error.
    expect(canonicalNumeric("80 '000")).toBe(80000);
    expect(canonicalNumeric("120' 000")).toBe(120000);
  });

  it('refuses tokens that are not numbers', () => {
    expect(canonicalNumeric('abc')).toBeNaN();
    expect(canonicalNumeric('')).toBeNaN();
    expect(canonicalNumeric(null as any)).toBeNaN();
    // "2023, 20" is a year followed by a list item, not one number.
    expect(canonicalNumeric('2023, 20')).toBeNaN();
  });
});

describe('lexicon shape', () => {
  // A missing key silently disables a fence (thresholdCue, nonTaxCue) and the
  // gate starts reporting prices as taxes, in one locale only.
  it('every locale defines every cue the pairing logic reads', () => {
    const required = [
      'months', 'currency', 'incomeCue', 'incomeCueTrailing', 'taxCue',
      'thresholdCue', 'nonTaxCue', 'approximation', 'periods',
    ];
    for (const locale of ['it', 'en', 'de', 'fr']) {
      for (const key of required) {
        expect(LOCALE_LEXICON[locale][key], `${locale}.${key}`).toBeTruthy();
      }
    }
  });

  it('falls back to Italian for an unknown locale instead of throwing', () => {
    expect(lexiconFor('xx')).toBe(LOCALE_LEXICON.it);
  });
});

describe('checkInlineArithmetic across locales', () => {
  // The incident expression, retyped in each locale's own number convention.
  // The multiplication holds; the FACTOR contradicts the stated rate by 10x.
  it('flags the factor/percentage contradiction in English', () => {
    const issues = checkInlineArithmetic(
      'a pension tax of 4.5% (0.45 x 60,000 = 27,000 Swiss francs)',
      { locale: 'en' },
    );
    expect(codes(issues)).toContain('percent-factor-mismatch');
  });

  it('flags it in German and in French too', () => {
    expect(codes(checkInlineArithmetic(
      'eine Steuer von 4,5 % (0,45 x 60.000 = 27.000 Franken)', { locale: 'de' },
    ))).toContain('percent-factor-mismatch');
    expect(codes(checkInlineArithmetic(
      "un impôt de 4,5 % (0,45 x 60 000 = 27 000 francs)", { locale: 'fr' },
    ))).toContain('percent-factor-mismatch');
  });

  it('accepts the correct sibling expression in each locale', () => {
    expect(checkInlineArithmetic(
      'a flat rate of 3.2% (0.032 x 60,000 = 1,920 Swiss francs)', { locale: 'en' },
    )).toEqual([]);
    expect(checkInlineArithmetic(
      'ein fester Satz von 3,2 % (0,032 x 60.000 = 1.920 Franken)', { locale: 'de' },
    )).toEqual([]);
    expect(checkInlineArithmetic(
      "un taux fixe de 3,2 % (0,032 x 60 000 = 1 920 francs)", { locale: 'fr' },
    )).toEqual([]);
  });

  it('flags a product that does not hold, in English number format', () => {
    expect(codes(checkInlineArithmetic('0.10 x 50,000 = 9,000', { locale: 'en' })))
      .toContain('arithmetic-error');
  });

  it('does not read an English decimal as an Italian thousands group', () => {
    // "1.5 x 4 = 6" is right in English. Parsed with Italian rules 1.5 stays
    // 1.5, but the reverse case matters: 0.45 must be 0.45, not 45.
    expect(checkInlineArithmetic('1.5 x 4 = 6', { locale: 'en' })).toEqual([]);
    expect(checkInlineArithmetic('0.032 x 60,000 = 1,920', { locale: 'en' })).toEqual([]);
  });

  it('leaves the Italian behaviour exactly where it was', () => {
    expect(codes(checkInlineArithmetic(
      "dovrà pagare un'imposta sulla rendita del 4,5% (0,45 x 60.000 = 27.000 franchi svizzeri)",
    ))).toContain('percent-factor-mismatch');
    expect(checkInlineArithmetic(
      "un'aliquota fissa del 3,2% (0,032 x 60.000 = 1.920 franchi svizzeri)",
    )).toEqual([]);
  });
});

describe('checkTaxPlausibility across locales', () => {
  it('flags a tax above gross income in English', () => {
    const issues = checkTaxPlausibility(
      'A worker with an income of 60,000 Swiss francs per year will pay a tax of 72,000 Swiss francs per year.',
      { locale: 'en' },
    );
    expect(codes(issues)).toContain('tax-exceeds-income');
  });

  it('flags it in German, reading the Swiss apostrophe', () => {
    const issues = checkTaxPlausibility(
      "Ein Arbeitnehmer mit einem Einkommen von 60'000 Franken pro Jahr zahlt eine Steuer von 72'000 Franken pro Jahr.",
      { locale: 'de' },
    );
    expect(codes(issues)).toContain('tax-exceeds-income');
  });

  it('flags it in French, reading the space-grouped amounts', () => {
    const issues = checkTaxPlausibility(
      "Un travailleur avec un revenu de 60 000 francs par an paiera un impôt de 72 000 francs par an.",
      { locale: 'fr' },
    );
    expect(codes(issues)).toContain('tax-exceeds-income');
  });

  it('accepts a realistic withholding rate in every locale', () => {
    expect(checkTaxPlausibility(
      'With an income of 60,000 Swiss francs, the withholding tax amounts to 6,000 Swiss francs.',
      { locale: 'en' },
    )).toEqual([]);
    expect(checkTaxPlausibility(
      "Bei einem Einkommen von 60'000 Franken beträgt die Quellensteuer 6'000 Franken.",
      { locale: 'de' },
    )).toEqual([]);
    expect(checkTaxPlausibility(
      "Avec un revenu de 60 000 francs, l'impôt à la source s'élève à 6 000 francs.",
      { locale: 'fr' },
    )).toEqual([]);
  });

  it('does not pair a monthly income with an annual tax', () => {
    expect(checkTaxPlausibility(
      'A worker earning a salary of 4,000 CHF per month will pay 7,000 CHF per year in taxes.',
      { locale: 'en' },
    )).toEqual([]);
    expect(checkTaxPlausibility(
      'Ein Arbeiter mit einem Lohn von 4.000 CHF pro Monat zahlt 7.000 CHF pro Jahr an Steuern.',
      { locale: 'de' },
    )).toEqual([]);
  });

  it('reads a threshold as a bracket, not as a sum handed over', () => {
    // The Italian fence, in English: "income of over 80,000" names where a rule
    // starts applying. Repeating the bracket is not a 100% tax.
    expect(checkTaxPlausibility(
      'Workers with an income of over 80,000 Swiss francs must pay tax on the part above 80,000 Swiss francs.',
      { locale: 'en' },
    )).toEqual([]);
  });

  it('does not read a price as a tax', () => {
    expect(checkTaxPlausibility(
      'A commuter with a salary of 5,000 Swiss francs pays a season ticket costing 6,000 Swiss francs.',
      { locale: 'en' },
    )).toEqual([]);
  });

  it('does not treat a second income in the same sentence as a tax', () => {
    expect(checkTaxPlausibility(
      'A patient with an income of 50,000 francs pays 10%, while a patient with an income of 100,000 francs pays 20%.',
      { locale: 'en' },
    )).toEqual([]);
  });
});

describe('checkTranslationNumericConsistency', () => {
  const IT = 'Il lavoratore con un reddito di 60.000 CHF paga il 25% di imposta sostitutiva, '
    + "invece dell'80% previsto in precedenza, e risiede entro 20 km dal confine. "
    + "L'accordo è in vigore dal 1 gennaio 2024 e prevede una franchigia di 10.000 euro.";

  it('stays silent when the translation says the same thing in its own format', () => {
    // Every number preserved; only the punctuation and the words change.
    const en = 'A worker with an income of CHF 60,000 pays the 25% substitute tax, '
      + 'instead of the 80% previously applied, and lives within 20 km of the border. '
      + 'The agreement is in force from 1 January 2024 and provides an allowance of 10,000 euros.';
    expect(checkTranslationNumericConsistency(IT, en, 'en')).toEqual([]);
  });

  it('stays silent for German and French written their own way', () => {
    const de = "Ein Arbeitnehmer mit einem Einkommen von 60'000 CHF zahlt die Ersatzsteuer von 25 % "
      + 'statt der früheren 80 % und wohnt innerhalb von 20 km von der Grenze. '
      + 'Das Abkommen gilt ab dem 1. Januar 2024 und sieht einen Freibetrag von 10.000 Euro vor.';
    expect(checkTranslationNumericConsistency(IT, de, 'de')).toEqual([]);

    const fr = "Un travailleur avec un revenu de 60 000 CHF paie l'impôt substitutif de 25 %, "
      + "au lieu des 80 % appliqués auparavant, et réside à moins de 20 km de la frontière. "
      + "L'accord est en vigueur depuis le 1 janvier 2024 et prévoit une franchise de 10 000 euros.";
    expect(checkTranslationNumericConsistency(IT, fr, 'fr')).toEqual([]);
  });

  it('flags a translation that dropped the rates', () => {
    const en = 'A worker with an income of CHF 60,000 pays a substitute tax and lives within 20 km '
      + 'of the border. The agreement is in force from 1 January 2024 and provides an allowance '
      + 'of 10,000 euros.';
    const issues = checkTranslationNumericConsistency(IT, en, 'en');
    expect(codes(issues)).toContain('translation-number-dropped');
    expect(issues[0].message).toContain('[en]');
  });

  it('flags a translation that invented figures the Italian never states', () => {
    const en = 'A worker with an income of CHF 60,000 pays the 25% substitute tax, instead of the '
      + '80% previously applied, and lives within 20 km of the border. Rates of 12% and 47% and 63% '
      + 'also apply. The agreement is in force from 1 January 2024 and provides an allowance of '
      + '10,000 euros.';
    expect(codes(checkTranslationNumericConsistency(IT, en, 'en')))
      .toContain('translation-number-added');
  });

  it('does not report a single divergent figure', () => {
    // Ranges name only one endpoint next to the currency ("da 60.000 a 100.000
    // franchi" yields 100000, "from CHF 60,000 to 100,000" yields 60000), so one
    // value apart is an artefact of how the two languages place the currency.
    const it = 'Lo stipendio va da 60.000 a 100.000 franchi, con una franchigia di 10.000 euro '
      + 'e una seconda soglia di 20.000 euro e una terza di 30.000 euro.';
    const en = 'The salary ranges from CHF 60,000 to 100,000, with an allowance of 10,000 euros '
      + 'and a second threshold of 20,000 euros and a third of 30,000 euros.';
    expect(codes(checkTranslationNumericConsistency(it, en, 'en')))
      .not.toContain('translation-number-dropped');
  });

  it('ignores the Italian-only tools block appended after translation', () => {
    // create-article appends "## Tool utili per il tuo caso" with (nav:) links
    // to 581 Italian bodies AFTER they are translated. It mentions 20 km, and
    // counting it reported a dropped distance in ~650 articles.
    const it = 'Il lavoratore paga il 25% di imposta.\n\n'
      + '## Tool utili per il tuo caso\nPer il tuo scenario entro/oltre 20 km usa il '
      + '[calcolatore stipendio netto](nav:calculator).';
    const en = 'The worker pays the 25% substitute tax.';
    expect(checkTranslationNumericConsistency(it, en, 'en')).toEqual([]);
  });

  describe('magnitude twin', () => {
    it('blocks the same digits at a different order of magnitude', () => {
      // The live case: `franco-svizzero-minimi-euro` writes "465 franchi
      // svizzeri" in Italian and "CHF 4.65" in English — a 100x error produced
      // purely by re-punctuating the number.
      const it = 'Il salario aumenta di circa 465 franchi svizzeri al mese, '
        + 'con un totale di 4.650 franchi svizzeri e una base di 5.000 franchi svizzeri.';
      const en = 'The salary rises by about CHF 4.65 per month, '
        + 'for a total of CHF 4,650 and a base of CHF 5,000.';
      const issues = checkTranslationNumericConsistency(it, en, 'en');
      expect(codes(issues)).toContain('translation-number-magnitude');
      const flagged = issues.find((i: any) => i.code === 'translation-number-magnitude');
      expect(flagged.message).toContain('465');
    });

    it('does not claim a separator error when the digits differ', () => {
      // 6.000 vs 60.000 is a retyped number, not a re-punctuated one. Pairing
      // by ratio alone reported 12 of these as separator conversions, and
      // paired an Italian nursery fee with a German rent gap on top.
      const it = 'Lo stipendio minimo è di 6.000 franchi al mese, su una base di 5.000 franchi.';
      const en = 'The minimum salary is CHF 60,000 per year, on a base of CHF 5,000.';
      expect(codes(checkTranslationNumericConsistency(it, en, 'en')))
        .not.toContain('translation-number-magnitude');
    });

    it('does not pair two unrelated figures that happen to sit 10x apart', () => {
      const it = 'Gli asili nido in Ticino costano tra 70 e 120 CHF al giorno, '
        + 'con un contributo di 300 CHF e una quota di 450 CHF.';
      const de = 'Der Mietunterschied beträgt 1.200 EUR pro Monat, '
        + 'mit einem Beitrag von 300 EUR und einem Anteil von 450 EUR.';
      expect(codes(checkTranslationNumericConsistency(it, de, 'de')))
        .not.toContain('translation-number-magnitude');
    });
  });

  it('returns nothing when either side is empty', () => {
    expect(checkTranslationNumericConsistency('', 'anything', 'en')).toEqual([]);
    expect(checkTranslationNumericConsistency('qualcosa', '', 'en')).toEqual([]);
    expect(checkTranslationNumericConsistency(null as any, 'x', 'en')).toEqual([]);
  });
});

describe('extractNumericFacts', () => {
  it('reads an amount whichever side the currency sits on', () => {
    // Italian prose writes "60.000 CHF"; English and the Swiss house style
    // write "CHF 60,000". Matching one order only made every article using the
    // other look like it had lost all of its amounts.
    expect([...extractNumericFacts('un reddito di 60.000 CHF', 'it').amt]).toContain(60000);
    expect([...extractNumericFacts('an income of CHF 60,000', 'en').amt]).toContain(60000);
    expect([...extractNumericFacts('a wage of 6,000 Swiss francs', 'en').amt]).toContain(6000);
  });

  it('folds scale words so a budget survives translation', () => {
    expect([...extractNumericFacts('un debito di 140 milioni di franchi', 'it').amt]).toContain(140e6);
    expect([...extractNumericFacts('a debt of CHF 140 million', 'en').amt]).toContain(140e6);
  });

  it('reads a date in each locale and keys it on the ISO value', () => {
    expect([...extractNumericFacts('il 31 dicembre 2018', 'it').date]).toContain('2018-12-31');
    expect([...extractNumericFacts('on 31 December 2018', 'en').date]).toContain('2018-12-31');
    expect([...extractNumericFacts('on December 31, 2018', 'en').date]).toContain('2018-12-31');
    expect([...extractNumericFacts('am 31. Dezember 2018', 'de').date]).toContain('2018-12-31');
    expect([...extractNumericFacts('le 31 décembre 2018', 'fr').date]).toContain('2018-12-31');
  });
});

describe('checkTranslationFalseFriends', () => {
  // The 2026-07-28 defect: "frontalieri" translated as the profession that
  // guards the border rather than the people who commute across it.
  const IT_COMMUTERS = 'I frontalieri che lavorano in Ticino devono presentare i documenti '
    + 'richiesti per ottenere il permesso G presso l\'ufficio cantonale competente.';

  it('flags "border guards" used for cross-border commuters', () => {
    const en = 'Border guards working in Ticino must present the required documents to obtain '
      + 'the G permit at the competent cantonal office.';
    const issues = checkTranslationFalseFriends(IT_COMMUTERS, en, 'en');
    expect(codes(issues)).toContain('translation-false-friend');
    expect(issues[0].fix).toContain('cross-border');
  });

  it('flags the French and German equivalents', () => {
    expect(codes(checkTranslationFalseFriends(
      IT_COMMUTERS,
      'Les gardes-frontières travaillant au Tessin doivent présenter les documents requis.',
      'fr',
    ))).toContain('translation-false-friend');
    expect(codes(checkTranslationFalseFriends(
      IT_COMMUTERS,
      'Die Grenzwächter, die im Tessin arbeiten, müssen die erforderlichen Unterlagen vorlegen.',
      'de',
    ))).toContain('translation-false-friend');
  });

  it('accepts a correct translation', () => {
    expect(checkTranslationFalseFriends(
      IT_COMMUTERS,
      'Cross-border commuters working in Ticino must present the required documents.',
      'en',
    )).toEqual([]);
  });

  // THE LIMIT, stated rather than hidden. This check does not read the
  // sentence, so it cannot itself tell a mistranslated commuter from a real
  // customs officer. It defers to the Italian: if the Italian names a guard,
  // a customs officer or the dogana ANYWHERE in the body, the check goes
  // silent for that whole article. Precision is bought with recall.
  it('stays silent when the Italian really is about border guards', () => {
    const it = 'Le guardie di confine svizzere hanno intensificato i controlli doganali '
      + 'al valico di Chiasso durante il fine settimana.';
    const en = 'Swiss border guards have stepped up customs checks at the Chiasso crossing '
      + 'over the weekend.';
    expect(checkTranslationFalseFriends(it, en, 'en')).toEqual([]);
  });

  it('is silenced by any customs mention in the Italian, even a passing one', () => {
    // Documented consequence of the rule above: an article covering BOTH real
    // guards and frontalieri is not checked at all. Asserted so the trade-off
    // cannot be lost in a later refactor without a test going red.
    const it = 'I frontalieri devono presentare i documenti. La dogana di Brogeda resta aperta.';
    const en = 'Border guards must present the documents. The Brogeda customs post stays open.';
    expect(checkTranslationFalseFriends(it, en, 'en')).toEqual([]);
  });

  it('has nothing to say about Italian, and does not crash on bad input', () => {
    expect(checkTranslationFalseFriends(IT_COMMUTERS, 'qualsiasi testo', 'it')).toEqual([]);
    expect(checkTranslationFalseFriends(null as any, 'x', 'en')).toEqual([]);
  });
});

describe('runFactualityGates on a translation', () => {
  const italianSections = {
    body1: 'I frontalieri con un reddito di 60.000 CHF pagano il 25% di imposta sostitutiva.',
  };

  it('runs the cross-locale checks and reports the locale in the label', () => {
    const result = runFactualityGates({
      sections: { body1: 'Border guards with an income of CHF 60,000 pay the 25% substitute tax.' },
      locale: 'en',
      italianSections,
    });
    expect(result.passed).toBe(false);
    expect(codes(result.blocking)).toContain('translation-false-friend');
  });

  it('passes a faithful translation', () => {
    const result = runFactualityGates({
      sections: {
        body1: 'Cross-border commuters with an income of CHF 60,000 pay the 25% substitute tax.',
      },
      locale: 'en',
      italianSections,
    });
    expect(result.issues).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('skips the Italian-only gates on a translation', () => {
    // The institution allowlist, the norm-date predicates and the future-tense
    // markers are Italian vocabulary. Running them on English would report
    // every real body as defective.
    const result = runFactualityGates({
      sections: {
        body1: 'According to the Federal Tax Office (UFI), the rule applies from 1 January 2024.',
      },
      locale: 'en',
      italianSections,
    });
    expect(codes(result.issues)).not.toContain('fabricated-institution');
  });

  it('omits the cross-locale checks when no Italian original is supplied', () => {
    const result = runFactualityGates({
      sections: { body1: 'Border guards with an income of CHF 60,000 pay the 25% substitute tax.' },
      locale: 'en',
    });
    expect(codes(result.issues)).not.toContain('translation-false-friend');
  });

  // A translation restates what the Italian says; it does not decide whether a
  // tax exceeds an income. Every one of the 14 surviving `tax-exceeds-income`
  // reports on en/de/fr had no Italian counterpart, and the five read by hand
  // were misreadings of word order — so a content claim the Italian does not
  // make is reported but does not block.
  it('demotes a content claim the Italian original does not make', () => {
    const result = runFactualityGates({
      sections: {
        body1: '500,000 francs income: 80,000 francs in tax in Freienbach, 180,000 in Trey.',
      },
      locale: 'en',
      italianSections: {
        body1: 'Un reddito di 500.000 franchi paga 80.000 franchi di imposte a Freienbach.',
      },
    });
    const flagged = result.issues.find((i: any) => i.code === 'tax-exceeds-income');
    if (flagged) {
      expect(flagged.severity).toBe('major');
      expect(flagged.message).toContain('non bloccante');
      expect(codes(result.blocking)).not.toContain('tax-exceeds-income');
    }
  });

  it('keeps blocking when the Italian makes the same claim', () => {
    const italianSections = {
      body1: 'Un lavoratore con un reddito di 60.000 franchi svizzeri pagherà '
        + "un'imposta di 72.000 franchi svizzeri.",
    };
    const result = runFactualityGates({
      sections: {
        body1: 'A worker with an income of 60,000 Swiss francs will pay a tax of 72,000 Swiss francs.',
      },
      locale: 'en',
      italianSections,
    });
    expect(codes(result.blocking)).toContain('tax-exceeds-income');
  });

  it('never demotes a defect that belongs to the translation itself', () => {
    // An unclosed bold marker is the German body's own damage, not a claim
    // about the world, so the Italian has no say in it.
    const result = runFactualityGates({
      sections: { body1: 'Hier die **Betriebscheckliste' },
      locale: 'de',
      italianSections: { body1: 'Ecco la **checklist operativa**.' },
    });
    expect(codes(result.blocking)).toContain('truncated-bold');
  });

  it('leaves the Italian path untouched by the new parameters', () => {
    const result = runFactualityGates({
      sections: {
        body1: 'Un lavoratore che ha guadagnato 60.000 franchi svizzeri dovrà pagare '
          + "un'imposta sulla rendita del 4,5% (0,45 x 60.000 = 27.000 franchi svizzeri).",
      },
      publishedAt: '2026-07-28T00:00:00Z',
    });
    expect(codes(result.blocking)).toContain('percent-factor-mismatch');
  });
});
