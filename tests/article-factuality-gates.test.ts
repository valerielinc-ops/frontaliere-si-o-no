/**
 * Tests for scripts/lib/article-factuality-gates.mjs — the deterministic
 * factuality gates added after the 2026-07-28 incident on the article
 * `frontalieri-altre-tasse-2026` (run 30350429920).
 *
 * The article was generated from ilgiorno.it/sondrio/cronaca/caso-frontalieri-altre-tasse,
 * a source that says Ticino now taxes opt-in-Omnibus frontalieri at 100% OF THE
 * WITHHOLDING TABLES (A/B/C/H) rather than the reduced 80%, on top of the Italian
 * 25% substitute tax. The shipped article read "100%" as "100% of gross salary".
 *
 * Each `describe` below pins one real defect from that article, plus the
 * negative case that must NOT fire — these gates block publication, so a false
 * positive stalls the content pipeline just as badly as a miss.
 *
 * Fixtures use the real strings that shipped, not paraphrases.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseItalianNumber,
  detectTruncation,
  detectLeakedScaffolding,
  checkInlineArithmetic,
  checkTaxPlausibility,
  checkCrossSectionNumericConflicts,
  checkFabricatedInstitutionAcronyms,
  checkFabricatedNormAcronyms,
  FABRICATED_NORM_ACRONYMS,
  checkContradictoryNormDates,
  checkSourceFreshness,
  extractSourceAnchors,
  renderAnchorForPrompt,
  anchorEvidence,
  matchedAnchors,
  checkSourceFidelity,
  runFactualityGates,
  formatRemediation,
  formatItalianNumber,
  FACT_CHECK_CATEGORIES,
} from '../scripts/lib/article-factuality-gates.mjs';

const codes = (issues: any[]) => issues.map((i) => i.code);

describe('parseItalianNumber', () => {
  it('reads thousands separators and decimal commas', () => {
    expect(parseItalianNumber('60.000')).toBe(60000);
    expect(parseItalianNumber('28.920')).toBe(28920);
    expect(parseItalianNumber('0,45')).toBe(0.45);
    expect(parseItalianNumber('0,032')).toBe(0.032);
    expect(parseItalianNumber('4,5')).toBe(4.5);
    expect(parseItalianNumber('1.234,56')).toBeCloseTo(1234.56);
  });

  it('treats a dot not followed by three digits as a decimal point', () => {
    expect(parseItalianNumber('0.45')).toBe(0.45);
  });

  it('returns NaN for non-numbers', () => {
    expect(parseItalianNumber('abc')).toBeNaN();
    expect(parseItalianNumber('')).toBeNaN();
    expect(parseItalianNumber(null as any)).toBeNaN();
  });
});

describe('checkInlineArithmetic', () => {
  // SHIPPED: "un'imposta sulla rendita del 4,5% (0,45 x 60.000 = 27.000 franchi
  // svizzeri)". The product is right; the factor is 10x the stated percentage.
  it('flags a multiplier that contradicts the stated percentage', () => {
    const issues = checkInlineArithmetic(
      "dovrà pagare un'imposta sulla rendita del 4,5% (0,45 x 60.000 = 27.000 franchi svizzeri)",
    );
    expect(codes(issues)).toContain('percent-factor-mismatch');
    expect(issues[0].message).toContain('4,5');
  });

  it('accepts the correct sibling expression from the same article', () => {
    // "un'aliquota fissa del 3,2% (0,032 x 60.000 = 1.920 franchi svizzeri)"
    const issues = checkInlineArithmetic(
      "un'aliquota fissa del 3,2% (0,032 x 60.000 = 1.920 franchi svizzeri)",
    );
    expect(issues).toEqual([]);
  });

  it('flags a product that simply does not hold', () => {
    const issues = checkInlineArithmetic('0,10 x 50.000 = 9.000');
    expect(codes(issues)).toContain('arithmetic-error');
  });

  it('ignores prose without an explicit calculation', () => {
    expect(checkInlineArithmetic('Il 25% dell\'imposta pagata in Svizzera.')).toEqual([]);
  });

  // SHIPPED and blocked for nothing: `stipendio-saldatore-frontaliere-ticino`
  // writes the rate on the RIGHT. Assuming the factor was always the left
  // operand reported "400000× il valore corretto" on arithmetic that is exact.
  it('accepts the rate on either side of the multiplication', () => {
    expect(checkInlineArithmetic(
      "Secondo la Convenzione di doppia imposizione, l'imposta alla fonte in Svizzera sarebbe del 20% "
      + '(80.000 x 0,20 = 16.000 franchi svizzeri).',
    )).toEqual([]);
    expect(checkInlineArithmetic("un'aliquota del 3,2% (60.000 x 0,032 = 1.920 franchi)")).toEqual([]);
  });

  it('still flags a factor that matches neither operand', () => {
    const issues = checkInlineArithmetic("un'imposta del 4,5% (60.000 x 0,45 = 27.000 franchi)");
    expect(codes(issues)).toContain('percent-factor-mismatch');
    // The rate is the smaller operand — the other side is a salary.
    expect(issues[0].message).toContain('0,45');
  });
});

describe('checkTaxPlausibility', () => {
  // SHIPPED: income 60.000 CHF, "la quota di imposta sarebbe aumentata al 100%,
  // ovvero 60.000 franchi svizzeri" — the core misreading of "100%".
  it('flags a tax equal to gross income', () => {
    const issues = checkTaxPlausibility(
      'Supponiamo che un lavoratore abbia un reddito di 60.000 franchi svizzeri all\'anno. '
      + 'Se optasse per il Decreto Omnibus, la quota di imposta sarebbe aumentata al 100%, ovvero 60.000 franchi svizzeri.',
    );
    expect(codes(issues)).toContain('tax-exceeds-income');
  });

  it('flags an implausibly high but sub-100% tax', () => {
    const issues = checkTaxPlausibility(
      'Con un reddito di 60.000 franchi svizzeri, dovrebbe pagare un\'imposta di 54.000 franchi svizzeri.',
    );
    expect(codes(issues)).toContain('tax-implausible');
  });

  it('accepts a realistic withholding rate', () => {
    const issues = checkTaxPlausibility(
      'Con un reddito di 60.000 franchi svizzeri, l\'imposta alla fonte ammonta a 6.000 franchi svizzeri.',
    );
    expect(issues).toEqual([]);
  });

  it('does not pair amounts that are not presented as a tax', () => {
    const issues = checkTaxPlausibility(
      'Il reddito di 60.000 franchi svizzeri è superiore alla media di 75.000 franchi svizzeri del settore.',
    );
    expect(issues).toEqual([]);
  });
});

/**
 * The corpus audit that followed the gates' first release: 59 blocking findings
 * over 48 articles, most of them correct prose. Every fixture below is the
 * verbatim line that was blocked — paraphrasing would drop the exact construct
 * that broke the gate, which is the only thing these cases are pinning.
 *
 * Precision is not cosmetic here. Blocking issues are fed back into the
 * regeneration prompt, and the writer's cheapest answer to an "impossible tax"
 * it cannot see in its own text is to delete the passage — the same silent
 * shedding of real facts that produced the incident article in the first place.
 */
describe('tax plausibility — false positives from the corpus audit', () => {
  const silent = (text: string) => expect(codes(checkTaxPlausibility(text))).toEqual([]);

  // `tasse-frontalieri-scambio-dati-stipendi-italia`: one income BRACKET, stated
  // twice. Both 80.000 are the same threshold, neither is a sum handed over.
  it('reads "oltre 80.000 franchi" as a threshold, not as a tax', () => {
    silent(
      'La normativa prevede anche che i frontalieri che lavorano in Svizzera e che hanno un reddito di '
      + "oltre 80.000 franchi svizzeri all'anno saranno tenuti a pagare le tasse in Svizzera. Questo significa "
      + 'che i frontalieri che lavorano in Svizzera e che hanno un reddito di oltre 80.000 franchi svizzeri '
      + "all'anno saranno tenuti a pagare le tasse in Svizzera, anche se non risiedono in Svizzera.",
    );
  });

  // `funivia-monte-lema-stagione-2026`: no tax anywhere in the pairing. A
  // 41-franc IRPEF refund was matched against the 290-franc price of a season
  // pass eight sentences later, on a paragraph that is one physical line.
  it('does not pair a refund with the price of a ski pass eight sentences later', () => {
    silent(
      'Chi lavora in Ticino e risiede in Lombardia può detrarre l’abbonamento stagionale nel modulo «Altri '
      + 'costi professionali» della dichiarazione redditi 2026, fino a un massimo di 3 000 franchi. Il rimborso '
      + 'IRPEF corrispondente, calcolato al 23% per un reddito tra 65 000 e 85 000 franchi, è di 41 franchi; se '
      + 'il reddito supera i 120 000 franchi la detrazione sale a 55 franchi. Il pagamento avviene tramite '
      + 'fattura mensile con 30 giorni dilazione. L’abbonamento cumulativo «Ticino Monte» lanciato nel 2025 '
      + 'include anche Monte Generoso e Monte Tamaro: costa 290 franchi, offre 10% di sconto nelle malghe '
      + 'affiliate e si può acquistare online su montelema.ch.',
    );
  });

  // `lpp-minimo-secondo-pilastro-2026`, two distinct defects on one article.
  // Four bulleted scenarios share a line: the 4.000 CHF salary of the first was
  // paired with the 6.000 CHF salary of the fourth.
  it('does not pair salaries across bulleted scenarios on the same line', () => {
    silent(
      '- Scenario 1: Un operaio che guadagna 4.000 CHF al mese dovrà pagare 50 CHF di tasse per la previdenza '
      + 'sociale per il 2026, indipendentemente dal fatto che lavori in Svizzera o in Italia. - Scenario 2: Un '
      + 'commerciante che guadagna 5.000 CHF al mese dovrà pagare 62,50 CHF di tasse per la previdenza sociale '
      + 'per il 2026, indipendentemente dal fatto che lavori in Svizzera o in Italia. - Scenario 4: Un ingegnere '
      + 'che guadagna 6.000 CHF al mese dovrà pagare 75 CHF di tasse per la previdenza sociale per il 2026, '
      + 'indipendentemente dal fatto che lavori in Svizzera o in Italia.',
    );
  });

  it('treats a raised salary as a new base, not as a tax on the previous one', () => {
    silent(
      'Ad esempio, un ingegnere che guadagna 6.000 CHF al mese dovrà pagare 75 CHF di tasse per la previdenza '
      + 'sociale, indipendentemente dal fatto che lavori in Svizzera o in Italia. Tuttavia, se il suo stipendio '
      + 'aumenta a 7.000 CHF, potrebbe essere in grado di ridurre le tasse per la previdenza sociale a 87,50 CHF.',
    );
  });

  // `costo-vita-lugano-confronto-milano-frontalieri`: two bullets, one line. The
  // 200.000 income of the second was read as a tax on the 60.000 of the first.
  it('does not reach into the next bullet for a tax figure', () => {
    silent(
      "* Un impiegato con un reddito di 60.000 franchi svizzeri all'anno a Lugano può pagare intorno ai 10.000 "
      + 'franchi svizzeri di tasse in Svizzera, mentre a Milano potrebbe pagare intorno ai 20.000 euro di tasse '
      + "(circa 24.000 franchi svizzeri). * Un imprenditore con un reddito di 200.000 franchi svizzeri all'anno "
      + 'a Lugano può pagare intorno ai 30.000 franchi svizzeri di tasse in Svizzera, mentre a Milano potrebbe '
      + 'pagare intorno ai 50.000 euro di tasse (circa 60.000 franchi svizzeri).',
    );
  });

  // `frontaliere-ticino-panettiere-guadagno` and
  // `quanto-guadagna-un-polimeccanico-frontaliere-in-ticino`: the apostrophe is
  // the Swiss thousands separator. Truncating "4'500 CHF" to 500 invented an
  // impossible ratio out of correct arithmetic.
  it('reads the Swiss apostrophe as a thousands separator', () => {
    silent(
      "* Un panettiere frontaliere in Lugano guadagna 4'500 CHF al mese e paga 1'200 CHF di imposte sul reddito "
      + "in Svizzera. Il credito d'imposta sarebbe di 600 CHF (50% delle imposte pagate).",
    );
    silent(
      "* Un polimeccanico frontaliere che lavora a Lugano, in Ticino, ha un reddito lordo di 80'000 CHF all'anno. "
      + "Se è già presente in Svizzera prima del 17 luglio 2023, l'esenzione dalle imposte gli permetterebbe di "
      + "conservare 7'500 CHF, lasciandogli un reddito netto di 72'500 CHF all'anno.",
    );
  });

  // `franco-forte-stipendio-frontalieri`: "tasso" is the exchange RATE. Merely
  // converting a salary to euro was enough to be blocked as a 109% tax.
  it('does not read "tasso di cambio" as a tax cue', () => {
    silent(
      'Un frontaliere che guadagna 5.000 CHF netti al mese, convertendo a un tasso di 0,92, porta a casa circa '
      + '5.435 EUR — ben 430 EUR in più rispetto a cinque anni fa a parità di stipendio in franchi.',
    );
  });

  // `momoride-carpooling-frontalieri-benefici`: "pag\w*" matched the middle of
  // "equiPAGGi", so a charity donation became a tax on a carpooling bonus.
  it('does not find a tax cue inside an unrelated word', () => {
    silent(
      'I partecipanti possono guadagnare fino a 500 franchi al mese tracciando i loro spostamenti pendolari con '
      + "l'app Mobalt. Inoltre, unendo le forze per raggiungere l'obiettivo di 40.000 punti in un mese, gli "
      + 'equipaggi possono donare 1.000 franchi alla Fondazione Provvida Madre di Balerna.',
    );
  });

  // `costi-cure-domocilio-ticino-2026` and `tassa-salute-frontalieri-vantaggio-ticino`:
  // a second income is a second scenario, never the first one's tax.
  it('does not treat a second income in the same sentence as a tax', () => {
    silent(
      'Per esempio, un paziente con un reddito annuo di 50.000 franchi pagherà il 10%, mentre un paziente con '
      + 'un reddito di 100.000 franchi pagherà il 20%.',
    );
    silent(
      'Secondo le prime stime, un lavoratore singolo con un reddito annuo di 50.000 CHF potrebbe pagare circa '
      + '200 CHF al mese, mentre per una famiglia di quattro persone con un reddito di 80.000 CHF l\'importo '
      + 'potrebbe salire fino a 450 CHF mensili.',
    );
  });

  // `terzo-pilastro-3a-vantaggi-canton-ginevra`: two defects in one sentence.
  // "(80.000 CHF - 10.000 CHF)" is a working, and the tax cue that qualified
  // the 72.500 alternative sat upstream of the income it was compared against.
  it('ignores a parenthesised working and a tax cue upstream of the income', () => {
    silent(
      'Ciò significherebbe che il frontaliero dovrebbe pagare le imposte solo sul reddito residuo di 70.000 CHF '
      + '(80.000 CHF - 10.000 CHF) o 72.500 CHF (80.000 CHF - 7.500 CHF), rispettivamente.',
    );
  });

  // `frontalieri-calano-ticino`: "(circa 31.200 franchi svizzeri)" is the income
  // one word earlier in another currency, not a 104% tax on it.
  it('ignores a currency conversion in parentheses', () => {
    silent(
      'Se in Italia viene tassato al 20% su un reddito di 30.000 euro (circa 31.200 franchi svizzeri), la tassa '
      + 'italiana sarà di 6.240 euro (circa 6.456 franchi svizzeri).',
    );
  });

  // `divario-salari-ticino-frontalieri-2026`: an income word opens the clause
  // ("stipendio lordo") but the word next to the figure is "paga", so 900 is
  // the tax; and net pay is not a tax at all.
  it('yields to the cue nearest the figure and never reads net pay as a tax', () => {
    silent(
      'Un residente con lo stesso stipendio lordo paga circa 900 franchi di tasse in Svizzera, rimanendo con '
      + 'un netto di 3.900 franchi.',
    );
  });
});

/**
 * The other half of the same audit. These three articles are genuinely broken
 * and every precision fix above had to leave them blocked — a gate tuned until
 * it says nothing is not a gate.
 */
describe('tax plausibility — defects that must keep firing', () => {
  // `proposta-choc-ticino-frontalieri`: the income is stated in one sentence and
  // the impossible total in the next, which is why the income carries over one
  // statement instead of being confined to its own.
  it('flags a total that exceeds the salary it is levied on, across a sentence break', () => {
    const issues = checkTaxPlausibility(
      'Ad esempio, se un frontaliero ha lavorato nel Canton Ticino per 10 anni e ha un stipendio di 60.000 '
      + "franchi all'anno, dovrà pagare le tasse di un nuovo frontaliero, che ammontano a 12.000 franchi "
      + "all'anno. Ciò significa che il frontaliero dovrà pagare un totale di 72.000 franchi all'anno, di cui "
      + '12.000 franchi sono tasse.',
    );
    expect(codes(issues)).toContain('tax-exceeds-income');
    expect(issues[0].message).toContain('72.000');
    expect(issues[0].message).toContain('60.000');
  });

  // `bossi-commemorazione-bagarrata`: 450% of income, and the base is named
  // AFTER the figure ("per ogni 1.000 franchi svizzeri di reddito"). Without a
  // trailing income cue the gate still fired, but reported the right verdict
  // against the wrong pair of numbers.
  it('flags a per-unit rate above 100% and names the correct base', () => {
    const issues = checkTaxPlausibility(
      "Secondo i dati dell'UFS, nel 2022 il Ticino ha pagato 4.500 franchi svizzeri di tasse per ogni 1.000 "
      + 'franchi svizzeri di reddito, che è il più alto della Svizzera.',
    );
    expect(codes(issues)).toContain('tax-exceeds-income');
    expect(issues[0].message).toContain('Imposta 4.500 franchi svizzeri');
    expect(issues[0].message).toContain('reddito lordo 1.000 franchi svizzeri');
  });
});

/**
 * Second audit round: the 15 surviving `tax-implausible` findings were read by
 * hand against the article source. One true positive, thirteen false, and every
 * false one stated its real, plausible tax on the same line (12.480/62.400 =
 * 20%, 10.000/60.000 = 17%). The gate was never picking the wrong article, only
 * the wrong amount on it.
 *
 * The three causes below each get the lines that must go quiet AND a line that
 * must keep firing, because the fix is positional — the cue nearest the figure
 * decides — and a positional rule is only worth having if it can still say yes.
 */
describe('tax plausibility — the cue nearest the figure decides', () => {
  const silent = (text: string) => expect(codes(checkTaxPlausibility(text))).toEqual([]);

  describe('cause 1: take-home pay read as the tax', () => {
    // `aumenti-stipendi-svizzera-2026`. "netto" was already a non-tax cue and
    // never bit: "tasse" sat in the same 40-character window, and the old rule
    // let any tax word veto the veto. Here "tasse" is real — 12.480 on 62.400
    // is 20% — it is just further away than "netto".
    it('prefers "netto" over a real tax word further upstream', () => {
      silent(
        '- Scenario 1: Un frontaliere residente a Como con uno stipendio di 60.000 CHF potrebbe vedere un '
        + 'aumento del 4% nel 2026, portando il suo stipendio a 62.400 CHF. Con un\'aliquota fiscale alla fonte '
        + 'del 20%, pagherà circa 12.480 CHF di tasse, lasciando un netto di 50.920 CHF.',
      );
    });

    // `frontaliere-ottico-optometrista-ticino-stipendio-requisiti`: here the tax
    // word is not merely further away, it is governed by "dopo" — the clause
    // describes what is left, not what is owed.
    it('reads "netto dopo l\'applicazione dell\'Imposta" as what is left', () => {
      silent(
        'Esempio 1: Un ottico optometrista frontaliero italiano che lavora in Ticino guadagna 60.000 CHF '
        + "all'anno. Il suo stipendio netto dopo l'applicazione dell'Imposta federale diretta del 5,3% e "
        + "dell'IVA del 7,7% è di 56.100 CHF.",
      );
    });

    // `dumping-salariale-iniziativa-mps` and `licenziamento-postino-ticino`:
    // "dopo le tasse … porta a casa" and "dopo le imposte … il netto".
    it('reads "dopo le tasse … porta a casa" and "dopo le imposte … il netto" as net pay', () => {
      silent(
        'Ad esempio, un lavoratore che guadagna 5.000 CHF al mese, dopo le tasse, potrebbe portare a casa '
        + 'circa 3.800 CHF, mentre un collega italiano con lo stesso stipendio lordo in Italia potrebbe '
        + 'ricevere un netto di circa 3.000 EUR.',
      );
      silent(
        'Ad esempio, considerando un reddito lordo mensile di 4.500 CHF, dopo le imposte svizzere e italiane '
        + '(a seconda della convenzione fiscale applicabile) e le assicurazioni sociali, il netto potrebbe '
        + 'attestarsi tra i 2.800 e i 3.200 CHF, a seconda della situazione specifica.',
      );
    });

    // THE TRUE POSITIVE of this audit round, and the reason the rule is
    // positional rather than a blanket mute on "tasse": `frontalieri-ristorni-da-record`
    // really does claim an 80% tax, with the tax cue sitting next to the figure.
    it('still flags a tax at 80% of income when the tax cue is the nearest one', () => {
      const issues = checkTaxPlausibility(
        "- Un frontaliero che guadagna 50.000 franchi svizzeri all'anno in Lugano deve pagare 40.000 franchi "
        + "svizzeri di tasse (80% del suo reddito). - Un frontaliero che guadagna 100.000 franchi svizzeri all'anno "
        + 'in Mendrisio deve pagare 80.000 franchi svizzeri di tasse (80% del suo reddito).',
      );
      expect(codes(issues)).toEqual(['tax-implausible', 'tax-implausible']);
      expect(issues[0].message).toContain('80% del reddito 50.000 franchi svizzeri');
    });
  });

  describe('cause 2: the base the tax is computed on, read as the tax', () => {
    // `tassazione-frontalieri-2026-nuovo-accordo`: "tassato SU 45.000" names
    // what is taxed, not what is paid.
    it('reads "tassato solo su X" as the taxable base', () => {
      silent(
        'Ad esempio, se prima veniva tassato su un reddito di 50.000 CHF, con la nuova franchigia potrebbe '
        + 'essere tassato solo su 45.000 CHF, risparmiando così sulle imposte italiane.',
      );
    });

    // `assicurazione-rc-auto-svizzera-differenze-italia-frontalieri`: a credito
    // d'imposta is a credit. The word "imposta" inside it is not a cue of its own.
    it('does not take the "imposta" inside "credito d\'imposta" as a cue', () => {
      silent(
        "* Un lavoratore frontaliere che guadagna 80.000 CHF all'anno (circa 76.000 €) in Italia potrà "
        + "beneficiare di un credito d'imposta di 1.500 €, per un totale di 78.500 € da cui detrarre le tasse.",
      );
    });

    // `frontalieri-busta-paga-svizzera-2026`: once under "dopo", once under a
    // negation. Both describe the residue, not the levy.
    it('discounts a tax word that is negated or governed by "dopo"', () => {
      silent(
        '> Esempio 1: Supponiamo che un frontaliero italiano con un reddito da lavoro di 60.000 euro lordi '
        + "lavori in Svizzera. In Svizzera, dopo aver pagato l'imposta sul reddito da lavoro (IRL) e "
        + "l'assicurazione sanitaria obbligatoria (ASO), la parte del reddito da lavoro che non è stata "
        + 'trattenuta è di 45.000 euro.',
      );
      silent(
        '> - Un frontaliero italiano con un reddito da lavoro lordo netto di 60.000 euro potrebbe ricevere un '
        + 'reddito da lavoro lordo dopo le tasse di circa 45.000 euro.',
      );
    });

    // The contrast: `bossi-commemorazione-bagarrata` names its base too ("per
    // ogni 1.000 franchi DI REDDITO") and still asserts a tax, because the cue
    // next to the 4.500 is "pagato".
    it('still flags a rate stated against an explicit base', () => {
      const issues = checkTaxPlausibility(
        '* Nel 2022 il canton Ticino ha pagato 4.500 franchi svizzeri di tasse per ogni 1.000 franchi '
        + 'svizzeri di reddito.',
      );
      expect(codes(issues)).toContain('tax-exceeds-income');
    });
  });

  describe('cause 3: two examples on one line, cross-paired', () => {
    // `salario-minimo-ticino-2027-2029`: an hourly wage paired with the hourly
    // floor it must clear. Neither is a tax, and an income tax is never quoted
    // per hour — periodOf() simply could not see "l’ora" with a curly apostrophe.
    it('does not read an hourly wage as a tax on an hourly floor', () => {
      silent(
        '- Scenario B: Un’azienda di Locarno che paga 21 franchi l’ora può mantenere il CCL attuale fino al '
        + '2029, ma dovrà adeguarsi se il salario minimo legale supera i 21,50 franchi.',
      );
    });

    // `stipendio-veterinario-frontaliere-ticino`: a chain of additions in which
    // only the first item is a tax. The 72'000 is labelled "la pensione".
    it('does not pair an income with a pension listed further down the same chain', () => {
      silent(
        "La sua retribuzione annuale sarebbe di 80'000 franchi, meno l'imposta alla fonte di 24'000 franchi, "
        + "più il contributo all'AVS di 1'920 franchi, più il contributo al LPP di 24'000 franchi, più la "
        + "pensione di 72'000 franchi al mese, cioè 864'000 franchi all'anno.",
      );
    });

    // The contrast: `proposta-choc-ticino-frontalieri` also spreads its two
    // figures over two sentences on one line, and must still be paired.
    it('still pairs an income with an impossible total in the next sentence', () => {
      const issues = checkTaxPlausibility(
        'Ad esempio, se un frontaliero ha lavorato nel Canton Ticino per 10 anni e ha un stipendio di 60.000 '
        + "franchi all'anno, dovrà pagare le tasse di un nuovo frontaliero, che ammontano a 12.000 franchi "
        + "all'anno. Ciò significa che il frontaliero dovrà pagare un totale di 72.000 franchi all'anno, di cui "
        + '12.000 franchi sono tasse.',
      );
      expect(codes(issues)).toContain('tax-exceeds-income');
    });
  });
});

describe('checkCrossSectionNumericConflicts', () => {
  // SHIPPED: the same 60.000 CHF scenario was answered 28.920 (body1),
  // 60.000 (body2) and "+6.000" (body3).
  it('flags incompatible answers to the same scenario across sections', () => {
    const issues = checkCrossSectionNumericConflicts({
      body1: 'Un lavoratore che ha guadagnato 60.000 franchi svizzeri dovrà pagare un\'imposta di 28.920 franchi svizzeri.',
      body3: 'Un lavoratore che guadagna 60.000 franchi svizzeri dovrà pagare 6.000 franchi svizzeri in più di imposta.',
    });
    expect(codes(issues)).toContain('contradictory-figures');
  });

  it('does not flag a two-column comparison inside a single section', () => {
    // A legit "current vs projected" table must survive — it lives in one section.
    const issues = checkCrossSectionNumericConflicts({
      body2: '| reddito di 60.000 franchi | imposta attuale 6.000 franchi | imposta prevista 9.000 franchi |',
    });
    expect(issues).toEqual([]);
  });

  it('does not flag consistent figures across sections', () => {
    const issues = checkCrossSectionNumericConflicts({
      body1: 'Con un reddito di 60.000 franchi svizzeri l\'imposta è di 6.000 franchi svizzeri.',
      body3: 'Sul reddito di 60.000 franchi svizzeri si pagano 6.500 franchi svizzeri di imposta.',
    });
    expect(issues).toEqual([]);
  });
});

describe('checkFabricatedInstitutionAcronyms', () => {
  // SHIPPED: "Ufficio federale delle imposte (UFI)" — no such body exists; the
  // federal one is the AFC/ESTV and the source cited the CANTONAL office.
  it('flags an invented federal institution', () => {
    const issues = checkFabricatedInstitutionAcronyms(
      'Secondo i calcoli effettuati dall\'Ufficio federale delle imposte (UFI), circa 2.000 lavoratori...',
    );
    expect(codes(issues)).toContain('fabricated-institution');
    expect(issues[0].message).toContain('UFI');
  });

  it('accepts real institutions', () => {
    expect(checkFabricatedInstitutionAcronyms(
      'L\'Amministrazione federale delle contribuzioni (AFC) ha confermato.',
    )).toEqual([]);
    expect(checkFabricatedInstitutionAcronyms(
      'L\'Ufficio federale di statistica (UST) pubblica i dati.',
    )).toEqual([]);
  });

  // ── 2026-07-29 corpus triage ──
  it('accepts the non-Italian acronym of an office already listed', () => {
    // Swiss federal offices publish under three or four acronyms and the writer
    // quotes whichever its source used. These were 175 warnings' worth of noise.
    for (const text of [
      'La Segreteria di Stato per le questioni finanziarie internazionali (SFI) ha negoziato l\'accordo.',
      'L\'Ufficio federale dell\'aviazione civile (UFAC) ha aggiornato le regole.',
      'La Commissione federale di coordinamento per la sicurezza sul lavoro (CFSL) raccomanda i DPI.',
    ]) expect(checkFabricatedInstitutionAcronyms(text)).toEqual([]);
  });

  it('accepts a superseded federal office quoted from an older source', () => {
    expect(checkFabricatedInstitutionAcronyms(
      'L\'Ufficio federale delle assicurazioni private (UFAP) vigilava sul settore prima della FINMA.',
    )).toEqual([]);
  });

  it('accepts verified cantonal and Italian bodies', () => {
    for (const text of [
      'L\'Istituto delle assicurazioni sociali (IAS) preleva i contributi.',
      'L\'Ufficio della protezione delle acque e dell\'approvvigionamento idrico (UPAAI) ha approvato il piano.',
      'L\'Ente Regionale per lo Sviluppo del Luganese (ERSL) finanzia il progetto.',
      'L\'Agenzia delle Dogane e dei Monopoli (ADM) ha pubblicato la circolare.',
    ]) expect(checkFabricatedInstitutionAcronyms(text)).toEqual([]);
  });

  it('blocks federal offices the generator invented', () => {
    // Each of these shipped in the corpus. The real body is in the allowlist.
    for (const [text, acronym] of [
      ['Secondo l\'Ufficio federale delle strade (UFSTR) il traffico è aumentato.', 'UFSTR'],
      ['L\'Ufficio federale delle imposte dirette (UFID) ha comunicato le aliquote.', 'UFID'],
      ['L\'Ufficio federale per la migrazione e il soggiorno (UVMS) rilascia il permesso.', 'UVMS'],
      ['Il Dipartimento federale dell\'economia, delle imprese e della formazione professionale (DEEF) ha deciso.', 'DEEF'],
    ] as const) {
      const issues = checkFabricatedInstitutionAcronyms(text);
      expect(codes(issues)).toContain('fabricated-institution');
      expect(issues[0].message).toContain(acronym);
    }
  });

  it('blocks invented cantonal offices without touching the real ones', () => {
    // USTIC vs the real USTAT, UPAI vs the real UPAAI: one-letter inventions.
    expect(codes(checkFabricatedInstitutionAcronyms(
      'L\'Ufficio di statistica del Cantone Ticino (USTIC) ha diffuso i dati.',
    ))).toContain('fabricated-institution');
    expect(checkFabricatedInstitutionAcronyms(
      'L\'Ufficio di statistica del Cantone Ticino (USTAT) ha diffuso i dati.',
    )).toEqual([]);
  });

  it('keeps an unverified acronym as a non-blocking warning', () => {
    // The triage left ~60 acronyms in neither list — real bodies from another
    // domain (SEC, INSS, UCC …) paired with an invented Swiss expansion. They
    // must stay `major`: blocking them would reject correct articles.
    const issues = checkFabricatedInstitutionAcronyms(
      'L\'Istituto nazionale della sicurezza sociale (INSS) eroga la prestazione.',
    );
    expect(codes(issues)).toContain('unknown-institution');
    expect(issues[0].severity).toBe('major');
  });
});

describe('checkFabricatedNormAcronyms', () => {
  // corpus#323 e la sua recidiva del 15-16/08/2026 su nanakokyobashi-rgb/
  // frontaliere-articles: `(LFW)` e `(LPS)` sono ricomparsi in 9 corpi su 4
  // locali DOPO la chiusura dell'incidente, e hanno bloccato la CI del corpus
  // su OGNI branch. Il gate sulle ISTITUZIONI non li vedeva perche' `Legge`
  // non e' in INSTITUTION_NOUN — e' quel buco che questo describe presidia.
  it('flags an invented law acronym as blocking', () => {
    const issues = checkFabricatedNormAcronyms(
      'La legge federale sul lavoro (LFW) del 20 marzo 1943 prevede che l\'apprendistato duri 3 anni.',
    );
    expect(codes(issues)).toContain('fabricated-norm-acronym');
    expect(issues[0].severity).toBe('critical');
    expect(issues[0].message).toContain('LFW');
  });

  it('flags LPS, whose two spelled-out forms are both non-existent laws', () => {
    expect(codes(checkFabricatedNormAcronyms(
      'La legge federale sulle prestazioni sociali (LPS) stabilisce i requisiti minimi.',
    ))).toContain('fabricated-norm-acronym');
    expect(codes(checkFabricatedNormAcronyms(
      'La legge sul permesso di soggiorno in Svizzera (LPS) stabilisce le norme.',
    ))).toContain('fabricated-norm-acronym');
  });

  it('leaves explicit entity/product uses of LFW/LPS alone', () => {
    expect(checkFabricatedNormAcronyms(
      'Il gruppo LFW ha aperto un nuovo sportello vicino al confine per i frontalieri.',
    )).toEqual([]);
    expect(checkFabricatedNormAcronyms(
      'La app LPS aiuta i frontalieri a calcolare lo stipendio netto in Svizzera.',
    )).toEqual([]);
  });

  it('keeps blocking unambiguous norm uses even without legge/art./RS nearby', () => {
    expect(codes(checkFabricatedNormAcronyms(
      'Secondo la LFW, il datore di lavoro deve registrare ogni ora supplementare.',
    ))).toContain('fabricated-norm-acronym');
    expect(codes(checkFabricatedNormAcronyms(
      'I requisiti della LPS si applicano a tutti i residenti del Cantone.',
    ))).toContain('fabricated-norm-acronym');
    expect(codes(checkFabricatedNormAcronyms(
      'La LCO del 2013 disciplina il contrasto alla criminalità organizzata.',
    ))).toContain('fabricated-norm-acronym');
  });

  it('does not let an earlier benign entity mention hide a later legal use of the same sigla', () => {
    expect(codes(checkFabricatedNormAcronyms(
      'Il gruppo LFW apre uno sportello. Secondo la LFW, ogni datore deve registrare le ore.',
    ))).toContain('fabricated-norm-acronym');
  });

  it('still flags LFW inside a German compound that embeds -gesetz mid-word', () => {
    expect(codes(checkFabricatedNormAcronyms(
      'Nach dem Bundesarbeitsgesetz (LFW) vom 13. März 1943 ist die Lehre ein Vertrag.',
    ))).toContain('fabricated-norm-acronym');
  });

  // #6017 item 2/3: LCL e LCO, misurate sul corpus tirato con la stessa
  // firma di fabbricazione — LCL fabbrica due leggi diverse e incompatibili
  // (naturalizzazione cantonale 2020 vs legge cantonale sul lavoro 1995),
  // LCO e' consistente ma inesistente e sopravvive identica a it/en/de/fr.
  it('flags LCL, whose two spelled-out forms are two different, incompatible laws', () => {
    expect(codes(checkFabricatedNormAcronyms(
      'La legge cantonale sulla naturalizzazione del Cantone di Lucerna e\' stata modificata nel 2020 (LCL 2020, art. 15).',
    ))).toContain('fabricated-norm-acronym');
    expect(codes(checkFabricatedNormAcronyms(
      'La legge cantonale sul lavoro (LCL) del 15 dicembre 1995 prevede una retribuzione minima.',
    ))).toContain('fabricated-norm-acronym');
  });

  it('flags LCO, an invented federal act that survives translation unchanged', () => {
    const issues = checkFabricatedNormAcronyms(
      'The key legislation is the Federal Act on Combating Organized Crime (LCO), adopted in 2013.',
    );
    expect(codes(issues)).toContain('fabricated-norm-acronym');
    expect(issues[0].message).toContain('LCO');
  });

  it('leaves an explicit LCO entity mention alone but still flags its measured legal context', () => {
    expect(checkFabricatedNormAcronyms(
      'Il gruppo LCO ha aperto una nuova filiale vicino al confine per i frontalieri.',
    )).toEqual([]);
    expect(codes(checkFabricatedNormAcronyms(
      'La legge federale sul contrasto alla criminalità organizzata (LCO), approvata nel 2013, '
      + 'prevede la creazione di un ufficio federale dedicato.',
    ))).toContain('fabricated-norm-acronym');
  });

  // La guardia `context` di LCL, e i due modi in cui puo' sbagliare.
  //
  // `LCL` e' anche la banca francese (ex Credit Lyonnais), e questo corpus ha
  // gia' 175 file sui frontalieri Francia-Svizzera: senza guardia il gate
  // rigetterebbe un articolo bancario legittimo. La guardia pero' non puo'
  // essere «c'e' un anno vicino» — in un articolo bancario un anno accanto
  // alla sigla e' la norma, non il segno di una citazione di legge. Serve il
  // segno di una CITAZIONE di norma, ed e' multilingue per costruzione
  // (NORM_CITATION_CUE), non una parola italiana sola.
  it('leaves the French bank LCL alone even when a year sits right next to it', () => {
    expect(checkFabricatedNormAcronyms(
      'Dal 2024 LCL offre un conto dedicato ai frontalieri, con carta multivaluta e prelievi gratuiti.',
    )).toEqual([]);
  });

  // `legg[ei]` e `lois?` in `NORM_CITATION_CUE` matchavano come PREFISSO di
  // parole comuni prive di ogni legame con una citazione di norma — `leggero`,
  // `leggenda`, `loisir` — perché l'alternanza non chiudeva con `\b`. Una di
  // queste basta, nel raggio di 120 caratteri da una menzione reale della
  // banca LCL, a far scattare `context.test()` e bloccare come `critical` un
  // articolo legittimo: esattamente il difetto che questa PR dichiara di
  // risolvere, riaperto da un lato diverso della stessa regex.
  it('leaves the bank LCL alone even when a nearby word merely starts with legg-/lois-', () => {
    expect(checkFabricatedNormAcronyms(
      'Dal 2024 LCL offre un servizio leggero e veloce per i frontalieri, pensato per chi cerca leggerezza '
      + 'nella gestione dei conti correnti in Svizzera.',
    )).toEqual([]);
    expect(checkFabricatedNormAcronyms(
      'Dal 2024 LCL, secondo una leggenda metropolitana leggendaria fra i frontalieri, avrebbe conti gratuiti.',
    )).toEqual([]);
    expect(checkFabricatedNormAcronyms(
      'Depuis 2024, LCL propose aux frontaliers un service de loisirs bancaires pour la Suisse.',
    )).toEqual([]);
  });

  // Stesso difetto di `legg[ei]`/`lois?`, riaperto da un terzo lato della
  // stessa alternanza: `federal\s+act`, `act\s+on` e `law\s+on` non
  // chiudevano con `\b` e matchavano come PREFISSO di frasi ordinarie senza
  // alcun legame con una citazione di norma — «federal action plan», «will
  // act only if requested», «this law only concerns residents».
  it('leaves the bank LCL alone even when a nearby word merely starts with act-/law-', () => {
    expect(checkFabricatedNormAcronyms(
      'Since 2024, LCL offers a federal action plan discount for cross-border commuters banking in Switzerland.',
    )).toEqual([]);
    expect(checkFabricatedNormAcronyms(
      'Since 2024, LCL support staff will act only if requested by the cross-border commuter opening an account.',
    )).toEqual([]);
    expect(checkFabricatedNormAcronyms(
      'Since 2024, LCL notes that this law only concerns residents opening a new account in Switzerland.',
    )).toEqual([]);
  });

  // Il test sopra nomina tre parole; la classe ne ha altre cinque, e la coda
  // del prefisso `legg-` e' fitta di parole ordinarie. Enumerarle qui evita che
  // un domani si «semplifichi» il cue guardando solo i tre esempi citati.
  it('leaves the bank LCL alone for the rest of the legg-/lois- family too', () => {
    const frasiSenzaCitazione = [
      'Il tariffario LCL resta leggibile online e non prevede spese fisse mensili.',
      'Un logo leggiadro accompagna la nuova app LCL dedicata ai frontalieri.',
      'Le commissioni LCL sono leggermente inferiori a quelle della concorrenza.',
      'Conviene leggere le condizioni del conto LCL prima di aprirlo.',
      'La carta LCL offre sconti su viaggi e loisir per i frontalieri.',
    ];
    for (const frase of frasiSenzaCitazione) {
      expect(checkFabricatedNormAcronyms(frase), frase).toEqual([]);
    }
  });

  // Contro-prova, ed e' la meta' che mancava del tutto: restringere il cue per
  // chiudere il falso positivo puo' spegnere il gate, e nessun test se ne
  // accorgerebbe. Le forme vere devono restare cue in italiano e in francese,
  // al singolare E al plurale — `legislazioni` non lo era: l'alternanza diceva
  // `legislazione`, che come prefisso non copre il plurale, quindi una sigla
  // fabbricata citata al plurale passava senza contesto riconosciuto.
  it('still recognises real citation cues, singular and plural', () => {
    const frasiConCitazione = [
      'La legge cantonale sul lavoro (LCL) del 15 dicembre 1995 fissa un minimo.',
      'Le leggi cantonali richiamate dalla LCL fissano un minimo salariale.',
      'La legislazione richiamata dalla LCL fissa un minimo salariale.',
      'Le legislazioni cantonali richiamate dalla LCL fissano un minimo salariale.',
      'La loi cantonale sur le travail (LCL) fixe un salaire minimum.',
      'Les lois cantonales citees par la LCL fixent un salaire minimum.',
    ];
    for (const frase of frasiConCitazione) {
      expect(codes(checkFabricatedNormAcronyms(frase)), frase).toContain('fabricated-norm-acronym');
    }
  });

  // Il tedesco compone in due direzioni opposte, e il `\b` va messo solo da
  // una parte. Questi due test codificano la scelta perche' non venga
  // «riparata» al giro dopo: chiudere `Gesetz`/`Bundesgesetz` farebbe passare
  // il primo test e romperebbe il secondo.
  it('leaves the bank LCL alone when the German word is a product or a news article', () => {
    const frasiSenzaCitazione = [
      'Die Artikelnummer der LCL-Karte steht auf der Rueckseite.',
      'Eine Artikelserie ueber die LCL und die Grenzgaenger erscheint woechentlich.',
      'Das Artikelbild der LCL-Broschuere zeigt eine Filiale in Genf.',
    ];
    for (const frase of frasiSenzaCitazione) {
      expect(checkFabricatedNormAcronyms(frase), frase).toEqual([]);
    }
  });

  // Terza domanda adversarial del giro: `RS\s*\d` prenderebbe uno standard
  // tecnico («RS 232») accanto a LCL. Misurato: no, e per due ragioni
  // indipendenti. Lo standard seriale si scrive col trattino, e `\s*` non
  // copre `-`; e «RS 232» col numero puntato E' una citazione vera — RS 232.11
  // e' la legge sui marchi. Restringere al formato puntato romperebbe `RS 101`
  // (la Costituzione) e `RS 220` (il CO), che di punto non ne hanno: sarebbe
  // il falso negativo del caso 2, non una chiusura di falso positivo.
  it('does not read a hyphenated technical standard as a Swiss RS citation', () => {
    expect(
      checkFabricatedNormAcronyms('Il terminale di pagamento LCL usa ancora un cavo RS-232 in cassa.'),
    ).toEqual([]);
  });

  it('keeps an unpunctuated RS number as a citation cue', () => {
    // `RS 101` e' la Costituzione: nessun punto, e deve restare cue.
    expect(
      codes(checkFabricatedNormAcronyms('La LCL richiamata in RS 101 fissa un minimo salariale ai frontalieri.')),
    ).toContain('fabricated-norm-acronym');
  });

  // Caso 3 del commento: `Gesetz` resta aperto a prefisso per i composti VERI,
  // ma `gesetzt` non e' un composto — e' il participio di `setzen`, parola
  // ordinaria in qualunque pezzo de-locale. Senza il `(?!t)` una frase come la
  // prima qui sotto flaggava `critical` una banca legittima.
  it('leaves the bank LCL alone when the German word is the participle gesetzt', () => {
    const frasiSenzaCitazione = [
      'Der Rahmen fuer die LCL-Karte der Grenzgaenger ist gesetzt.',
      'Gesetzt den Fall, dass die LCL ihre Gebuehren fuer Grenzgaenger erhoeht.',
      'Die gesetzte Frist fuer den LCL-Kontowechsel laeuft Ende Monat ab.',
      'Ein gesetzter Termin bei der LCL-Filiale in Genf dauert rund 30 Minuten.',
    ];
    for (const frase of frasiSenzaCitazione) {
      expect(checkFabricatedNormAcronyms(frase), frase).toEqual([]);
    }
  });

  // Stesso difetto dei composti tedeschi, ma in italiano e in inglese: senza
  // il `\b` la coda di `articol-` prendeva chi SCRIVE sui giornali invece di
  // chi cita una legge. Nessuna delle due lingue ha l'argomento della
  // composizione che tiene aperto `Gesetz-`, quindi qui il `\b` va messo.
  it('leaves the bank LCL alone for articolista and the rest of the articol- tail', () => {
    const frasiSenzaCitazione = [
      "L'articolista che segue la LCL sui giornali ticinesi firma una rubrica settimanale.",
      'La produzione articolistica sulla LCL e i frontalieri e cresciuta molto nel 2024.',
      'Gli articolisti economici citano la LCL fra le banche piu attive sul confine.',
    ];
    for (const frase of frasiSenzaCitazione) {
      expect(checkFabricatedNormAcronyms(frase), frase).toEqual([]);
    }
  });

  it('keeps German legal compounds as citation cues, by design', () => {
    // `Gesetz-` in testa a un composto e' SEMPRE dominio giuridico: chiudere
    // l'alternativa con `\b` darebbe falsi negativi, non toglierebbe falsi
    // positivi. `Artikeln` invece e' il dativo plurale di una citazione vera,
    // ed e' il motivo della `n?`.
    const frasiConCitazione = [
      'Die kantonale Gesetzgebung (LCL) vom 15. Dezember 1995 legt einen Mindestlohn fest.',
      'Das Bundesgesetzblatt nennt die LCL als Grundlage fuer den Mindestlohn.',
      'Das Gesetzbuch verweist auf die LCL fuer den Mindestlohn der Grenzgaenger.',
      'Der Gesetzentwurf zur LCL sieht einen Mindestlohn fuer Grenzgaenger vor.',
      'Der Gesetzestext der LCL nennt den Mindestlohn fuer Grenzgaenger.',
      'Die Gesetzeslage rund um die LCL bleibt fuer Grenzgaenger unveraendert.',
      'Artikel 5 der LCL legt den Mindestlohn fuer Grenzgaenger fest.',
      'In den Artikeln 5 und 6 der LCL steht der Mindestlohn der Grenzgaenger.',
    ];
    for (const frase of frasiConCitazione) {
      expect(codes(checkFabricatedNormAcronyms(frase)), frase).toContain('fabricated-norm-acronym');
    }
  });


  // Il falso negativo che NASCE con la guardia: `re.exec` torna solo la prima
  // occorrenza, quindi una menzione legittima messa in cima nasconde una
  // fabbricazione piu' in basso. Le due `LCL` qui stanno a 270 caratteri di
  // distanza, oltre la finestra di 120: la finestra della PRIMA non contiene
  // alcuna cue, quindi il test cade davvero se lo scan si ferma al primo match.
  it('still flags a fabricated LCL that follows a legitimate bank mention', () => {
    const issues = checkFabricatedNormAcronyms(
      'Dal 2024 LCL propone ai frontalieri conti correnti in euro, carte multivaluta e prelievi '
      + 'gratuiti agli sportelli di tutto il gruppo bancario francese, senza spese fisse mensili '
      + 'per chi accredita lo stipendio. Un altro paragrafo sostiene invece che la legge cantonale '
      + 'sul lavoro (LCL) del 15 dicembre 1995 fissi un minimo di 3500 franchi.',
    );
    expect(codes(issues)).toContain('fabricated-norm-acronym');
  });

  // Lo scan usa un CLONE locale con flag `g`, mai la regex della tabella:
  // l'invariante `entry.re.global === false` (verificata piu' sotto) resta
  // vera e nessuna entry diventa stateful fra due chiamate consecutive.
  it('keeps the table entries non-global even though the scan clones them', () => {
    const text = 'La legge cantonale sul lavoro (LCL) del 15 dicembre 1995 prevede una retribuzione minima.';
    expect(codes(checkFabricatedNormAcronyms(text))).toContain('fabricated-norm-acronym');
    expect(codes(checkFabricatedNormAcronyms(text))).toContain('fabricated-norm-acronym');
    for (const entry of FABRICATED_NORM_ACRONYMS as any[]) {
      expect(entry.re.global).toBe(false);
    }
  });

  // Il confine e' su LETTERE, non `\b`: queste due sono norme VERE e il gate le
  // deve lasciare passare, altrimenti blocca contenuto legittimo.
  it('leaves MLPS and TULPS alone — real norms that contain the letters', () => {
    expect(checkFabricatedNormAcronyms(
      'Il Ministero del Lavoro e delle Politiche Sociali (MLPS) e il TULPS del 1931 restano applicabili.',
    )).toEqual([]);
  });

  it('accepts the repaired citations', () => {
    expect(checkFabricatedNormAcronyms(
      'La legge sul lavoro (LL, RS 822.11) del 13 marzo 1964 regola la durata del lavoro; '
      + 'la formazione professionale di base e\' retta dalla LFPr (RS 412.10).',
    )).toEqual([]);
    expect(checkFabricatedNormAcronyms(
      'La legge federale sugli stranieri e la loro integrazione (LStrI, RS 142.20) regola il permesso di soggiorno.',
    )).toEqual([]);
  });

  // La ragione per cui il controllo sta FUORI dal ramo `locale === 'it'` di
  // runFactualityGates: `(LFW)` e' arrivato byte-identico anche nei corpi
  // de/fr/en di `apprendistato-urie-2024-2025`. Un gate solo-italiano avrebbe
  // lasciato passare le tre traduzioni.
  it('blocks in a non-Italian locale too, not only in Italian', () => {
    const de = runFactualityGates({
      sections: { body1: 'Nach dem Bundesarbeitsgesetz (LFW) vom 13. März 1943 ist die Lehre ein Vertrag.' },
      locale: 'de',
      italianSections: { body1: 'Secondo la legge sul lavoro il rapporto di tirocinio e\' un contratto di formazione.' },
    });
    expect(de.passed).toBe(false);
    expect(codes(de.blocking)).toContain('fabricated-norm-acronym');
  });

  it('is wired into runFactualityGates as a blocking gate for Italian', () => {
    const res = runFactualityGates({
      sections: { body1: 'Secondo la legge federale sul lavoro (LFW) del 1943, il contratto e\' annuale.' },
      locale: 'it',
    });
    expect(res.passed).toBe(false);
    expect(codes(res.blocking)).toContain('fabricated-norm-acronym');
  });

  // Le regex della tabella sono module-level e condivise fra le chiamate: con
  // il flag `g` porterebbero `lastIndex` da una chiamata all'altra e il gate
  // salterebbe un articolo si' e uno no. Difetto invisibile a un test a
  // chiamata singola, quindi va asserito sulla tabella.
  it('keeps the shared patterns non-global, so no lastIndex leaks between calls', () => {
    for (const entry of FABRICATED_NORM_ACRONYMS as any[]) {
      expect(entry.re.global).toBe(false);
    }
    const text = 'La legge federale sul lavoro (LFW) del 1943 vale ovunque.';
    expect(codes(checkFabricatedNormAcronyms(text))).toContain('fabricated-norm-acronym');
    expect(codes(checkFabricatedNormAcronyms(text))).toContain('fabricated-norm-acronym');
  });
});

describe('checkContradictoryNormDates', () => {
  // SHIPPED: "Il 1° gennaio 2024 entrerà in vigore il Decreto Omnibus" and
  // "Il Decreto Omnibus è stato varato il 1° gennaio 2023" in the same article.
  it('flags one norm carrying two different dates', () => {
    const issues = checkContradictoryNormDates(
      'Il Decreto Omnibus è stato varato il 1° gennaio 2023. '
      + 'Il Decreto Omnibus è stato varato il 9 agosto 2024.',
    );
    expect(codes(issues)).toContain('contradictory-norm-dates');
  });

  it('accepts a norm mentioned consistently', () => {
    const issues = checkContradictoryNormDates(
      'Il Decreto Omnibus è stato varato il 9 agosto 2024 ed è entrato in vigore il 10 agosto 2024.',
    );
    expect(issues).toEqual([]);
  });
});

describe('checkSourceFreshness', () => {
  // SHIPPED: a 25 January 2026 source published as news on 28 July 2026.
  it('flags a source far older than the publication date', () => {
    const issues = checkSourceFreshness({
      sourceDate: '2026-01-25',
      publishedAt: '2026-07-28T10:45:02.800Z',
    });
    expect(codes(issues)).toContain('stale-source');
    expect(issues[0].severity).toBe('critical');
  });

  it('accepts a same-week source', () => {
    const issues = checkSourceFreshness({
      sourceDate: '2026-07-25',
      publishedAt: '2026-07-28T10:45:02.800Z',
    });
    expect(codes(issues)).not.toContain('stale-source');
  });

  it('flags future tense pointing at an already-past date', () => {
    const issues = checkSourceFreshness({
      publishedAt: '2026-07-28T00:00:00Z',
      sourceDate: '2026-07-27',
      text: 'I frontalieri interessati dovranno presentare una dichiarazione dei redditi entro il 31 marzo 2024.',
    });
    expect(codes(issues)).toContain('past-date-future-tense');
  });

  it('does not flag future tense about a genuinely future date', () => {
    const issues = checkSourceFreshness({
      publishedAt: '2026-07-28T00:00:00Z',
      sourceDate: '2026-07-27',
      text: 'La nuova regola entrerà in vigore il 1 gennaio 2027.',
    });
    expect(codes(issues)).not.toContain('past-date-future-tense');
  });
});

describe('source fidelity', () => {
  // The real source text, trimmed to the passage that carries the anchors.
  const SOURCE = 'Il Canton Ticino alza il tiro e impone ai cosiddetti "vecchi frontalieri dei nuovi Comuni" '
    + 'di pagare una imposta alla fonte del cento per cento. I frontalieri dei nuovi Comuni di confine che '
    + 'opteranno per il meccanismo del Decreto Omnibus (tassazione in Italia con imposta sostitutiva pari al '
    + '25% dell\'imposta alla fonte pagata in Svizzera) dovranno essere tassati in Ticino al 100% (quindi '
    + 'secondo le tabelle A, B, C e H), e non più all\'80% come nuovi frontalieri. I lavoratori che hanno '
    + 'lavorato in Ticino tra il 31 dicembre 2018 e il 17 luglio 2023 con rientro giornaliero, con residenza '
    + 'fiscale in un Comune ricompreso entro i 20 km dal confine.';

  it('extracts the checkable anchors from the source', () => {
    const anchors = extractSourceAnchors(SOURCE);
    expect(anchors).toContain('pct:25');
    expect(anchors).toContain('pct:80');
    expect(anchors).toContain('pct:100');
    expect(anchors).toContain('km:20');
    expect(anchors).toContain('date:2018-12-31');
  });

  // THE ROOT-CAUSE CASE. The shipped article kept 4/6 anchors — a 67% recall
  // that clears the global threshold — while dropping exactly the two rates
  // that make the story legible: the 80% reduced rate and the Italian 25%.
  it('flags an article that dropped the key rates despite passing global recall', () => {
    const article = 'Il Canton Ticino ha deciso di imporre una imposta alla fonte del cento per cento ai '
      + '\'vecchi\' frontalieri. Riguarda chi ha lavorato in Ticino tra il 31 dicembre 2018 e il 17 luglio 2023 '
      + 'con residenza fiscale in un Comune entro i 20 km dal confine.';
    const issues = checkSourceFidelity(article, SOURCE);
    expect(codes(issues)).toContain('source-key-rates-dropped');
  });

  it('accepts an article that preserved the source rates', () => {
    const article = 'Chi opta per il Decreto Omnibus (imposta sostitutiva italiana al 25%) viene tassato in '
      + 'Ticino al 100% delle tabelle invece che all\'80%. Riguarda chi ha lavorato in Ticino tra il '
      + '31 dicembre 2018 e il 17 luglio 2023, residente entro i 20 km dal confine.';
    expect(checkSourceFidelity(article, SOURCE)).toEqual([]);
  });

  // ── The 2026-07-30 → 2026-08-03 production stall ──────────────────
  //
  // Article output fell from ~16/day to zero. Two independent defects in this
  // module, both of which made the gate unsatisfiable rather than strict, and
  // both invisible until the run logs were read: the retry loop burned all six
  // attempts on every evergreen slot and the job was SIGKILLed at 2400s.

  // Defect 1. `[A-Z]{3,8}` minus a deny-list harvested all-caps EMPHASIS as
  // required "institution" anchors. An evergreen SEO brief is full of it.
  it('does not turn all-caps emphasis or prompt scaffolding into required anchors', () => {
    const brief = '[ARTICOLO EVERGREEN SEO]\n'
      + '- Imposta alla fonte: trattenuta SOLO in Svizzera per i frontalieri (MAI "in entrambi i paesi").\n'
      + '- Nuovo Accordo: in vigore dal 1° GENNAIO 2024 (NON 2026). La Svizzera NON è membro UE/SEE.\n'
      + '- Acronimi/enti VALIDI (non inventarne altri): SECO, SEM, USTAT, INPS.';
    const anchors = extractSourceAnchors(brief);
    // Real bodies still required.
    for (const org of ['org:SECO', 'org:SEM', 'org:USTAT', 'org:INPS']) expect(anchors).toContain(org);
    // Emphasis and scaffolding are not facts an article can ever "keep".
    for (const junk of ['org:ARTICOLO', 'org:SEO', 'org:SOLO', 'org:MAI', 'org:NON', 'org:VALIDI', 'org:GENNAIO']) {
      expect(anchors).not.toContain(junk);
    }
  });

  // Defect 2. renderAnchorForPrompt emitted the raw dot-decimal key while
  // matchedAnchors only ever credits the Italian comma form — so the contract
  // and the remediation asked for "5.3%" and the gate refused it. Identical to
  // the date-branch bug already fixed above, and invisible on whole numbers,
  // which is why only fractional rates were ever reported missing.
  it('asks for percentages in the exact form the recall check accepts', () => {
    expect(renderAnchorForPrompt('pct:5.3')).toBe('5,3%');
    expect(renderAnchorForPrompt('pct:23')).toBe('23%'); // whole numbers unchanged
  });

  it('credits an article that wrote every rate exactly as the gate asked for it', () => {
    const src = 'Contributi svizzeri: AVS/AI/IPG 5.3% dipendente, AD/AC 1.1%, LAINF 0.7–1.5%, LPP 7–18%. '
      + 'IRPEF italiana: 23%, 35%, 43%. Enti: SECO, SEM, USTAT, INPS.';
    const anchors = extractSourceAnchors(src);
    // The article is written by following renderAnchorForPrompt literally.
    const article = 'I contributi valgono '
      + [...anchors].filter((a) => a.startsWith('pct:')).map(renderAnchorForPrompt).join(', ')
      + '. Gli enti competenti sono SECO, SEM, USTAT e INPS.';
    const found = matchedAnchors(article, anchors);
    for (const pct of [...anchors].filter((a) => a.startsWith('pct:'))) expect(found).toContain(pct);
    expect(codes(checkSourceFidelity(article, src))).not.toContain('source-key-rates-dropped');
  });

  it('treats regex metacharacters in organization anchors as literal text', () => {
    const anchor = 'org:A(B)C+CH';
    const source = 'L’ente A(B)C+CH pubblica il rapporto. Un altro ente non è rilevante.';
    const anchors = new Set([anchor]);

    expect(anchorEvidence(source, anchor)).toBe('L’ente A(B)C+CH pubblica il rapporto.');
    expect(matchedAnchors(source, anchors)).toEqual(new Set([anchor]));
    expect(matchedAnchors('L’ente ABCCH pubblica il rapporto.', anchors)).toEqual(new Set());
  });

  it('tells the writer how many more anchors are needed to pass, not just that it failed', () => {
    const src = 'Contributi: AVS 5.3%, AD 1.1%, LAINF 1.5%, LPP 18%. IRPEF 23%, 35%, 43%. '
      + 'Enti: SECO, SEM, USTAT, INPS, SUVA, MEF.';
    const vague = 'Un articolo generico sui contributi, senza aliquote. Cita solo SECO.';
    const fidelity = checkSourceFidelity(vague, src).find((i) => i.code === 'source-fidelity-low');
    expect(fidelity).toBeDefined();
    expect(fidelity!.fix).toMatch(/Ne mancano \d+ per superare il controllo/);
    expect(fidelity!.fix).toMatch(/ne servono \d+ su \d+, adesso ne hai \d+/);
  });

  it('does not gate on a source too thin to carry anchors', () => {
    expect(checkSourceFidelity('qualsiasi testo', 'fonte narrativa senza numeri.')).toEqual([]);
  });
});

describe('detectTruncation', () => {
  it('flags a clause left open inside its paragraph', () => {
    const issues = detectTruncation(
      'Il lavoratore dovrà pagare un\'imposta del 4,5% (0,45 x 60.000 = 27.000 operative',
    );
    expect(codes(issues)).toContain('unbalanced-parentheses');
  });

  it('flags an unclosed bold marker', () => {
    expect(codes(detectTruncation('Ecco la **checklist operativa'))).toContain('truncated-bold');
  });

  it('flags prose that stops without terminal punctuation', () => {
    expect(codes(detectTruncation(
      'Il frontaliere che risiede entro i venti chilometri dal confine deve presentare la dichiarazione dei redditi entro',
    ))).toContain('incomplete-ending');
  });

  it('accepts well-formed prose, lists and tables', () => {
    expect(detectTruncation('Il lavoratore paga il 3,2% (0,032 x 60.000 = 1.920 franchi).')).toEqual([]);
    expect(detectTruncation('Checklist:\n\n- Presentare la dichiarazione\n- Verificare la residenza')).toEqual([]);
    expect(detectTruncation('| Scenario | Imposta |\n| --- | --- |\n| Omnibus | 6.000 |')).toEqual([]);
  });

  // Corpus triage 2026-07-29: the three noise classes below accounted for 5 of
  // the 47 `incomplete-ending` hits; the other 42 are real defects.
  it('accepts a sentence closed with a typographic quote', () => {
    expect(codes(detectTruncation(
      'Il sindaco precisa: “l’azienda deve consegnare in Municipio i documenti che ne certificano l’ubicazione.”',
    ))).not.toContain('incomplete-ending');
  });

  it('accepts a footnote reference number after the full stop', () => {
    expect(codes(detectTruncation(
      'Le sintesi degli specialisti collocano la svolta operativa nel 2023 dopo la ratifica, '
      + 'con l\'allineamento delle misure nazionali in seguito. 6',
    ))).not.toContain('incomplete-ending');
  });

  it('accepts a markdown footnote entry closing on the back-reference glyph', () => {
    expect(codes(detectTruncation(
      'Testo del comunicato: Ministero dell\'economia e delle finanze, 06/06/2024. Parte seconda. 83 ↩',
    ))).not.toContain('incomplete-ending');
  });

  it('still flags a cut-off that merely happens to end in digits', () => {
    // The footnote exemption must not rescue this: dropping "000" would leave
    // "…sale a 60." which ends on a full stop, so the guard requires whitespace
    // before the number AND a clean boundary once it is removed.
    expect(codes(detectTruncation(
      'Per i frontalieri residenti entro i venti chilometri dal confine il tetto imponibile sale a 60.000',
    ))).toContain('incomplete-ending');
  });

  it('still flags leaked generation scaffolding at the end of a body', () => {
    // 17 of the 47 corpus hits end on a leaked prompt header like this one.
    // Its tail is 66 chars — just past the `looksLikeHeading` cut-off, which is
    // why that threshold must not be raised.
    expect(codes(detectTruncation(
      'Il quadro resta quindi invariato per i frontalieri con permesso G.\n\n'
      + 'TITOLO ARTICOLO: Svizzeri scelgono capitale al posto della rendita',
    ))).toContain('incomplete-ending');
  });
});

describe('runFactualityGates', () => {
  it('blocks on any critical and reports every issue', () => {
    const result = runFactualityGates({
      sections: {
        body1: 'Un lavoratore che ha guadagnato 60.000 franchi svizzeri dovrà pagare un\'imposta '
          + 'sulla rendita del 4,5% (0,45 x 60.000 = 27.000 franchi svizzeri).',
        body2: 'Secondo l\'Ufficio federale delle imposte (UFI), con un reddito di 60.000 franchi '
          + 'svizzeri la quota di imposta sale a 60.000 franchi svizzeri.',
      },
      publishedAt: '2026-07-28T00:00:00Z',
    });
    expect(result.passed).toBe(false);
    expect(codes(result.blocking)).toEqual(
      expect.arrayContaining(['percent-factor-mismatch', 'tax-exceeds-income', 'fabricated-institution']),
    );
  });

  it('passes a clean, source-faithful article', () => {
    const result = runFactualityGates({
      sections: {
        body1: 'Chi opta per il Decreto Omnibus viene tassato in Ticino al 100% delle tabelle A, B, C e H '
          + 'invece che all\'80%, con imposta sostitutiva italiana al 25%.',
        body2: 'Con un reddito di 60.000 franchi svizzeri, l\'imposta alla fonte ammonta a 6.000 franchi svizzeri.',
      },
      sourceText: 'Tassati in Ticino al 100% (tabelle A, B, C e H) e non più all\'80%, con imposta '
        + 'sostitutiva pari al 25% dell\'imposta alla fonte pagata in Svizzera, entro i 20 km dal confine.',
      sourceDate: '2026-07-27',
      publishedAt: '2026-07-28T00:00:00Z',
    });
    expect(result.blocking).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

describe('time-base guard', () => {
  // Most of the residual corpus noise came from pairing a monthly salary with
  // an annual tax figure. Different, known periods are never compared.
  it('does not pair a monthly income with an annual tax', () => {
    const issues = checkTaxPlausibility(
      'Un operaio che guadagna 4.000 CHF al mese dovrà pagare 7.000 CHF all\'anno di imposte.',
    );
    expect(issues).toEqual([]);
  });

  it('still flags an impossible tax when both are stated over the same period', () => {
    const issues = checkTaxPlausibility(
      'Un frontaliere con uno stipendio di 60.000 franchi all\'anno dovrà pagare 72.000 franchi all\'anno di imposte.',
    );
    expect(codes(issues)).toContain('tax-exceeds-income');
  });
});

describe('formatItalianNumber', () => {
  // toLocaleString('it-IT') degrades to "2700" on reduced-ICU Node builds, and
  // these strings are copied into the article by the writer.
  it('groups thousands with dots and keeps a decimal comma', () => {
    expect(formatItalianNumber(2700)).toBe('2.700');
    expect(formatItalianNumber(60000)).toBe('60.000');
    expect(formatItalianNumber(1234567)).toBe('1.234.567');
    expect(formatItalianNumber(0.045)).toBe('0,045');
    expect(formatItalianNumber(900)).toBe('900');
  });
});

describe('formatRemediation', () => {
  // The regeneration loop gets instructions, not complaints: given only a
  // diagnosis the writer's cheapest move is deletion, which is how the incident
  // article shed its real facts and kept the invented ones.
  const gateResult = () => runFactualityGates({
    sections: {
      body1: 'Un lavoratore che ha guadagnato 60.000 franchi svizzeri dovrà pagare un\'imposta '
        + 'del 4,5% (0,45 x 60.000 = 27.000 franchi svizzeri).',
      body2: 'Secondo l\'Ufficio federale delle imposte (UFI), con un reddito di 60.000 franchi '
        + 'svizzeri la quota di imposta sale a 60.000 franchi svizzeri.',
    },
    publishedAt: '2026-07-28T00:00:00Z',
  });

  it('tells the writer to correct rather than delete', () => {
    const out = formatRemediation(gateResult().blocking);
    expect(out).toContain('correggi, non cancellare');
    expect(out).toContain('CORREZIONE RICHIESTA');
  });

  it('supplies the corrected values, not just the diagnosis', () => {
    const out = formatRemediation(gateResult().blocking);
    // 4,5% of 60.000 is 2.700 — the writer should not have to work it out.
    expect(out).toContain('0,045');
    expect(out).toContain('2.700');
  });

  it('explains the misreading behind an impossible tax', () => {
    const out = formatRemediation(gateResult().blocking);
    expect(out).toContain('ALIQUOTA PIENA');
  });

  it('names the real institution when one was invented', () => {
    const out = formatRemediation(gateResult().blocking);
    expect(out).toMatch(/AFC|ESTV/);
  });

  it('falls back to per-category guidance for LLM issues without a fix', () => {
    const out = formatRemediation([
      { claim: 'La Svizzera è membro UE', reason: 'Affermazione falsa', category: 'eu_svizzera', severity: 'critical' },
    ]);
    expect(out).toContain('Accordi Bilaterali');
  });

  it('returns an empty string when there is nothing to fix', () => {
    expect(formatRemediation([])).toBe('');
  });
});

describe('stale source vs. undated source', () => {
  // Covering an older fact is fine; passing it off as breaking news is not.
  const OLD = { sourceDate: '2026-01-25', publishedAt: '2026-07-28T00:00:00Z' };

  it('blocks when the article never says when the fact happened', () => {
    const issues = checkSourceFreshness({
      ...OLD,
      text: 'Il Canton Ticino applica ora l\'aliquota piena ai frontalieri interessati.',
    });
    expect(issues.find((i) => i.code === 'stale-source')?.severity).toBe('critical');
  });

  it('reports but does not block when the article dates the fact explicitly', () => {
    const issues = checkSourceFreshness({
      ...OLD,
      text: 'Da gennaio 2026 l\'ufficio imposte alla fonte del Canton Ticino applica l\'aliquota piena.',
    });
    const stale = issues.find((i) => i.code === 'stale-source');
    expect(stale?.severity).toBe('major');
    expect(stale?.message).toContain('non fuorvia');
  });
});

describe('reviewer follow-ups (PR #4900)', () => {
  // 🔴 Regression the reviewer caught: lastSourcePublishedAt is module-level and
  // was only set on the real-fetch branch, so a Fase-1 news source date could
  // leak into the Fase-2 evergreen article in the same process and block it as
  // stale. fetchPageContent() now clears it first, unconditionally. Asserted at
  // the source level because the function is not exported.
  it('fetchPageContent clears the source date before every early return', () => {
    const src = readFileSync(
      new URL('../scripts/create-article.mjs', import.meta.url),
      'utf-8',
    );
    const fnStart = src.indexOf('async function fetchPageContent(url) {');
    expect(fnStart).toBeGreaterThan(-1);
    const head = src.slice(fnStart, fnStart + 1400);
    const resetAt = head.indexOf("lastSourcePublishedAt = ''");
    const firstEarlyReturn = head.indexOf("if (url.startsWith('stats-bfs://'))");
    expect(resetAt).toBeGreaterThan(-1);
    expect(resetAt).toBeLessThan(firstEarlyReturn);
  });

  // Adversarial check #2: a category present in the prompt but missing from
  // REMEDIATION_BY_CATEGORY silently drops the "CORREZIONE RICHIESTA" line.
  it('every fact-check category has remediation text', () => {
    for (const category of FACT_CHECK_CATEGORIES) {
      const out = formatRemediation([
        { claim: 'un claim di prova sufficientemente lungo', reason: 'motivo', category, severity: 'critical' },
      ]);
      expect(out, `categoria senza remediation: ${category}`).toContain('CORREZIONE RICHIESTA');
    }
  });

  // Adversarial check #1: all-caps furniture in a source must not count as an
  // institution anchor, or recall is measured against noise.
  it('ignores currency, format and editorial all-caps tokens as anchors', () => {
    const anchors = extractSourceAnchors(
      'LEGGI ANCHE: il prelievo in CHF sale al 25%. Scarica il PDF. Fonte ANSA. '
      + "L'OCST conferma l'aliquota all'80%.",
    );
    expect(anchors).toContain('org:OCST');
    for (const noise of ['org:CHF', 'org:PDF', 'org:ANSA', 'org:LEGGI', 'org:ANCHE']) {
      expect(anchors, `token spurio conteggiato: ${noise}`).not.toContain(noise);
    }
  });
});

describe('detectLeakedScaffolding', () => {
  // 2026-07-29: 49 published bodies carried instructions meant for the model.
  // One German article shipped the translator's entire rulebook — terminology
  // bans included. Invisible to every other gate: the prose is well-formed, the
  // arithmetic is fine, the institutions are real. It just isn't an article.
  it('flags a generation section marker left in the body', () => {
    expect(codes(detectLeakedScaffolding('## TITOLO ARTICOLO: come funziona il permesso G\n\nIl permesso G...')))
      .toContain('leaked-prompt-scaffolding');
  });

  it('flags the translator rulebook', () => {
    const leaked = 'TERMINOLOGIE DEUTSCH OBBLIGATORISCH:\n'
      + '*   "G-Bewilligung" / "Grenzgängerbewilligung" (MAI "G-Führerschein")\n'
      + '*   "Franken" (MAI "Francs" — es ist Französisch)';
    expect(codes(detectLeakedScaffolding(leaked))).toContain('leaked-prompt-scaffolding');
  });

  it('flags a formatting directive addressed to the model', () => {
    expect(codes(detectLeakedScaffolding('Verwenden Sie ZERO Fettschrift im ganzen Feld.')))
      .toContain('leaked-prompt-scaffolding');
  });

  it('tells the writer to delete it, not to rephrase it', () => {
    const fix = detectLeakedScaffolding('## TITOLO ARTICOLO: prova')[0]?.fix || '';
    expect(fix).toMatch(/non deve esserci affatto/i);
  });

  // The negatives matter as much: an article may legitimately discuss
  // terminology, bans, or the word "titolo" without being scaffolding.
  it('does not flag prose that merely talks about terminology', () => {
    expect(detectLeakedScaffolding(
      'La terminologia usata negli accordi bilaterali è obbligatoria per i Comuni di confine, '
      + 'e il titolo dell\'articolo 5 chiarisce quali documenti servono.',
    )).toEqual([]);
  });

  it('does not flag a normal heading or a quoted phrase', () => {
    expect(detectLeakedScaffolding('## Requisiti\n\nServe il "permesso G" e nulla più.')).toEqual([]);
    expect(detectLeakedScaffolding('Il datore di lavoro non può MAI trattenere il documento.')).toEqual([]);
  });
});
