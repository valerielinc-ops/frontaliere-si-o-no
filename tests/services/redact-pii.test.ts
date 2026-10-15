// @vitest-environment node
/**
 * PII redaction for user-authored free text (issue #5196).
 *
 * WHY THE FIXTURES BELOW LOOK THE WAY THEY DO.
 *
 * Every fixture is realistic text in one of the site's four locales, with the
 * real diacritics, the real street-name grammar and the real date formats —
 * never synthetic ASCII. That is not decoration. In this same session a byte
 * budget passed CI for weeks because its tests were ASCII while production data
 * was German: `String.length` counts UTF-16 code units, the gate counted bytes,
 * and `ä`/`ö`/`ü` are the entire difference. A redactor tested only on
 * `John Smith` and `01/01/2000` would pass here and then fail to recognise
 * `Jürgen Müller`, `Bahnhofstrasse`, `22. Februar 2008` or `Rue du Rhône` —
 * which is exactly the data it exists to catch.
 *
 * No real user text appears in this file. The two Italian questions used as
 * "must survive" cases are the site's own suggestion buttons, not anything a
 * user authored. Everything identifying is invented.
 *
 * The asymmetry that decides every ambiguous case is stated in the module
 * under test: over-redaction costs analytic value, under-redaction is a
 * data-protection incident.
 */
import { describe, expect, it } from 'vitest';

import { redactPersonalData, REDACTION_TOKENS } from '@/services/privacy/redactPii';

const red = (s: string) => redactPersonalData(s).text;
const kinds = (s: string) => redactPersonalData(s).kinds;

/** Fails if a fixture stops being non-ASCII — see the header. */
const hasNonAscii = (s: string) => /[^\x00-\x7F]/.test(s);

describe('the incident shape — name + date of birth + address together', () => {
  // Structurally identical to what was found in production, entirely invented.
  const IT = 'Nome: Marco Bernasconi Data di nascita: 22/02/1988 Indirizzo: Via alla Stampa 11B, 6965 Cadro';

  it('leaves no fragment of any of the three', () => {
    const out = red(IT);
    for (const leak of ['Marco', 'Bernasconi', '22/02/1988', 'Via alla Stampa', '11B', 'Cadro']) {
      expect(out, `leaked "${leak}"`).not.toContain(leak);
    }
    expect(kinds(IT)).toEqual(['address', 'date', 'name']);
  });

  it('keeps the labels, so the question is still readable as a shape', () => {
    const out = red(IT);
    expect(out).toContain('Nome');
    expect(out).toContain(REDACTION_TOKENS.name);
    expect(out).toContain(REDACTION_TOKENS.date);
    expect(out).toContain(REDACTION_TOKENS.address);
  });
});

describe('names, in all four locales, with real diacritics and apostrophes', () => {
  const CASES: Array<[string, string, string[]]> = [
    ['it', 'Mi chiamo Giovanni Bianchi e sono frontaliere', ['Giovanni', 'Bianchi']],
    ['de', 'Ich heiße Jürgen Müller und arbeite in der Schweiz', ['Jürgen', 'Müller']],
    ['fr', "Je m'appelle François Dupont, frontalier depuis 2020", ['François', 'Dupont']],
    ['fr-typographic', 'Je m’appelle Chloé Béranger', ['Chloé', 'Béranger']],
    ['en', "My name is Siobhán O'Connor", ['Siobhán', "O'Connor"]],
  ];

  for (const [locale, input, leaks] of CASES) {
    it(`${locale}: redacts the name`, () => {
      const out = red(input);
      for (const leak of leaks) expect(out, `leaked "${leak}"`).not.toContain(leak);
      expect(kinds(input)).toContain('name');
    });
  }

  it('the German and French fixtures are genuinely non-ASCII', () => {
    expect(hasNonAscii('Ich heiße Jürgen Müller')).toBe(true);
    expect(hasNonAscii('Je m’appelle Chloé Béranger')).toBe(true);
  });

  it('redacts after an honorific', () => {
    expect(red('Buongiorno, sono il Sig. Rossi')).not.toContain('Rossi');
    expect(red('Guten Tag Herr Schmidt')).not.toContain('Schmidt');
    expect(red('Bonjour Madame Lefèvre')).not.toContain('Lefèvre');
  });

  it('redacts an unknown capitalised pair even without any cue', () => {
    // The broad rule, carrying the asymmetry: unknown capitalised pair → person.
    const out = red('Ho parlato con Anna Pedrazzini della pratica');
    expect(out).not.toContain('Anna');
    expect(out).not.toContain('Pedrazzini');
  });

  it('does NOT redact a single capitalised word', () => {
    // Redacting singles would blank every sentence opener and every place name
    // the allowlist happens to miss — over-redaction past usefulness.
    expect(red('Lavoro a Bellinzona')).toContain('Bellinzona');
  });
});

describe('dates of birth, in the formats the four locales actually use', () => {
  const DATES = [
    '22/02/1988', // it/fr numeric
    '22.02.1988', // it/de/ch numeric
    '22-02-1988',
    '1988-02-22', // ISO
    '22 febbraio 1988', // it textual
    '22. Februar 1988', // de textual
    '22 février 1988', // fr textual
    '22 February 1988', // en textual
  ];

  for (const d of DATES) {
    it(`redacts ${d}`, () => {
      const input = `Sono nato il ${d}, posso fare domanda?`;
      const out = red(input);
      expect(out).not.toContain(d);
      expect(out).toContain(REDACTION_TOKENS.date);
    });
  }

  it('does NOT redact a bare year — it is the single most common query token here', () => {
    for (const q of ['tasse frontalieri 2026', 'aliquote 2026 e 2027', 'premi cassa malati 2026']) {
      expect(red(q), q).toBe(q);
      expect(kinds(q)).toEqual([]);
    }
  });
});

describe('addresses, in the street grammar of each locale', () => {
  const ADDRESSES: Array<[string, string, string[]]> = [
    ['it street-first', 'Abito in Via alla Stampa 11B', ['Via alla Stampa', '11B']],
    ['it piazza', 'Vicino a Piazza Riforma 3', ['Piazza Riforma']],
    ['de compound', 'Ich wohne an der Bahnhofstrasse 12', ['Bahnhofstrasse 12']],
    ['de eszett', 'Meine Adresse ist Hauptstraße 5', ['Hauptstraße 5']],
    ['fr street-first', 'J’habite Rue du Rhône 14', ['Rue du Rhône', '14']],
    ['fr chemin', 'Chemin des Fleurs 7, merci', ['Chemin des Fleurs']],
    ['en number-first', 'I live at 12 Station Road', ['12 Station Road']],
  ];

  for (const [label, input, leaks] of ADDRESSES) {
    it(`${label}: redacts the address`, () => {
      const out = red(input);
      for (const leak of leaks) expect(out, `leaked "${leak}"`).not.toContain(leak);
      expect(kinds(input)).toContain('address');
    });
  }

  it('sweeps the postal code + town glued to an address it already redacted', () => {
    const out = red('Via alla Stampa 11B, 6965 Cadro');
    expect(out).not.toContain('6965');
    expect(out).not.toContain('Cadro');
  });

  it('redacts an Italian 5-digit postal code + town on its own', () => {
    // 5 digits is never a year, so no prefix is needed to disambiguate.
    const out = red('Residenza 22100 Como');
    expect(out).not.toContain('22100');
    expect(out).not.toContain('Como');
  });

  it('redacts a Swiss postal code + town when it carries the country prefix', () => {
    const out = red('Domicilio CH-1204 Genève');
    expect(out).not.toContain('1204');
  });

  // ── The number-first order, which is the standard French one ──
  //
  // These passed through in CLEAR until this change: the type-first rule wants
  // the house number last ("Rue du Rhône 14", the Swiss-Romand habit), and the
  // English rule wants a street/road suffix. A plain French address has neither.
  // `fr` is one of the site's four locales, so this was a live hole, not a
  // theoretical one.
  const NUMBER_FIRST: Array<[string, string, string[]]> = [
    ['fr rue', 'Abito a 5 rue de la Gare a Ginevra', ['5 rue', 'Gare']],
    ['fr avenue', "J'habite au 12 avenue des Alpes", ['12 avenue', 'Alpes']],
    ['fr apostrophe', "Mon adresse est 3 rue d’Italie", ['3 rue', 'Italie']],
    ['fr bis', 'Mon domicile: 7 bis boulevard Carl-Vogt', ['boulevard Carl-Vogt']],
    ['fr chemin', 'Je réside 24 chemin des Coudriers', ['24 chemin', 'Coudriers']],
    ['it number-first', 'Indirizzo 8 via Nassa', ['8 via', 'Nassa']],
  ];

  for (const [label, input, leaks] of NUMBER_FIRST) {
    it(`${label}: redacts a number-first address`, () => {
      const out = red(input);
      for (const leak of leaks) expect(out, `leaked "${leak}"`).not.toContain(leak);
      expect(kinds(input)).toContain('address');
    });
  }

  it('does not fire on Italian prose where the street type is a common noun', () => {
    // `corso`, `largo` and `strada` are ordinary Italian words. The rule needs a
    // CAPITALISED name after the type, which is what keeps these intact — and
    // is also why an all-lowercase "5 rue de la gare" is NOT caught. That limit
    // is the argument for the closed-enum topic field, not for more regex.
    for (const q of ['Ho fatto 1 corso di formazione', 'Servono 2 strade alternative']) {
      expect(red(q), q).toBe(q);
    }
  });

  it('redacts the house-number letter suffix too — "221B Baker Street"', () => {
    // Before: `221B` did not match `\d{1,4}\s`, the generic name heuristic ate
    // "Baker Street", and the house number survived in clear beside a [name].
    const out = red('I live at 221B Baker Street');
    expect(out).not.toContain('221B');
    expect(out).not.toContain('Baker');
    expect(kinds('I live at 221B Baker Street')).toContain('address');
  });

  it('DELIBERATELY does not treat "2026 Lugano" as an address', () => {
    // The one documented departure from over-redaction. A bare 4-digit token
    // followed by a town is indistinguishable from year + town, and year + town
    // is one of the most common question shapes on this site. Redacting it
    // would blank a large share of ordinary questions to catch addresses the
    // street rules above already catch — an address in free text virtually
    // always carries its street.
    const q = 'imposta alla fonte 2026 Lugano';
    expect(red(q)).toBe(q);
  });
});

describe('identifiers that are unambiguously personal', () => {
  it('redacts a Swiss AVS/AHV number', () => {
    const out = red('Il mio numero AVS è 756.1234.5678.97');
    expect(out).not.toContain('756.1234.5678.97');
    expect(kinds('Il mio numero AVS è 756.1234.5678.97')).toContain('id');
  });

  it('redacts an Italian codice fiscale', () => {
    const out = red('Codice fiscale RSSMRA85T10A562S va bene?');
    expect(out).not.toContain('RSSMRA85T10A562S');
  });

  it('redacts an IBAN', () => {
    const out = red('Stipendio su CH9300762011623852957, va bene?');
    expect(out).not.toContain('CH9300762011623852957');
    expect(kinds('Stipendio su CH9300762011623852957')).toContain('iban');
  });

  // ── Documents and plates: state registers keyed to a named person ──
  //
  // A passport number or a plate is not a weaker identifier than the AVS number
  // already handled here — each one resolves to a person or a household in a
  // register. All three shapes below went out in clear before this change.

  it('redacts an Italian passport number', () => {
    const out = red('Il mio passaporto YA1234567 scade nel 2027');
    expect(out).not.toContain('YA1234567');
    expect(kinds('passaporto YA1234567')).toContain('id');
    // The bare year is deliberately preserved — see the date rules.
    expect(out).toContain('2027');
  });

  it('redacts a Swiss passport number', () => {
    expect(red('Mein Pass X1234567 läuft ab')).not.toContain('X1234567');
  });

  it("redacts an Italian carta d'identità elettronica", () => {
    const out = red("La mia carta d'identità è CA12345AB");
    expect(out).not.toContain('CA12345AB');
    expect(kinds("carta d'identità CA12345AB")).toContain('id');
  });

  it('redacts a Swiss vehicle plate', () => {
    for (const plate of ['TI 123456', 'ZH 45678', 'GR-9876']) {
      const input = `La mia auto ha la targa ${plate}`;
      expect(red(input), plate).not.toContain(plate.replace(/[\s-]/, ''));
      expect(kinds(input), plate).toContain('id');
    }
  });

  it('redacts an Italian vehicle plate, glued or spaced', () => {
    for (const plate of ['AB123CD', 'AB 123 CD']) {
      const input = `Targa italiana ${plate}, devo reimmatricolare?`;
      const out = red(input);
      expect(out, plate).not.toContain(plate);
      expect(kinds(input), plate).toContain('id');
    }
  });

  it('does NOT read a canton code plus a year as a plate', () => {
    // Second documented departure from over-redaction, same argument as the
    // ZIP_CITY year carve-out: "TI 2026" is a tax year in almost every real
    // occurrence, and the naive rule would fire on a very common question shape
    // while catching nothing the other identifier rules miss.
    for (const q of ['aliquote TI 2026', 'imposta GE 2027']) {
      expect(red(q), q).toBe(q);
      expect(kinds(q)).toEqual([]);
    }
  });

  it('does NOT read lower-case prose as a plate — the canton code is case-sensitive', () => {
    // German "So 3000 Franken" and Italian "ne 1234" would both be plates under
    // a case-insensitive rule. (The ZIP_CITY rule may still touch such strings;
    // that behaviour predates this change and is not what is asserted here.)
    expect(kinds('so 123456 franchi')).not.toContain('id');
    expect(kinds('ne 45678')).not.toContain('id');
  });

  it('still redacts email, URL and phone — the rules that already existed', () => {
    const out = red('Scrivimi a mario.rossi@example.com o al +41 79 123 45 67, vedi https://x.test/a');
    expect(out).not.toContain('mario.rossi@example.com');
    expect(out).not.toContain('79 123 45 67');
    expect(out).not.toContain('https://x.test/a');
  });
});

describe('ordinary questions survive — the redactor must stay useful', () => {
  // Both of these are the site's own suggestion buttons, not user-authored text.
  const KEEP = [
    "Come funziona l'imposta alla fonte?",
    'Differenza tra Permesso G e B?',
    'Quanto pago di tasse su 41000 franchi lordi da frontaliere in Ticino?',
    'Un frontaliere può aprire un fondo pensione?',
    'Quali documenti servono per il permesso G?',
    'Wie hoch ist die Quellensteuer im Tessin?',
    'Combien de jours puis-je télétravailler depuis l’Italie ?',
    'Can I keep my Italian health insurance as a cross-border worker?',
  ];

  for (const q of KEEP) {
    it(`keeps: ${q.slice(0, 48)}…`, () => {
      expect(red(q)).toBe(q);
      expect(kinds(q)).toEqual([]);
    });
  }

  it('the German and French keep-fixtures are genuinely non-ASCII', () => {
    expect(hasNonAscii('Wie hoch ist die Quellensteuer im Tessin?')).toBe(false); // plain, on purpose
    expect(hasNonAscii('Combien de jours puis-je télétravailler depuis l’Italie ?')).toBe(true);
  });
});

describe('the reported kinds are metadata, never content', () => {
  it('never contains any substring of the input', () => {
    const input = 'Mi chiamo Marco Bernasconi, Via alla Stampa 11B, nato il 22/02/1988';
    const k = kinds(input);
    expect(k.length).toBeGreaterThan(0);
    for (const kind of k) {
      expect(input.toLowerCase()).not.toContain(kind.toLowerCase());
    }
    expect(k.every((x) => ['address', 'date', 'email', 'iban', 'id', 'name', 'phone', 'url'].includes(x))).toBe(true);
  });

  it('is empty for a clean question', () => {
    expect(kinds('Quanto costa la LAMal?')).toEqual([]);
  });
});

describe('edge cases must not throw', () => {
  it('handles empty, whitespace and non-string input', () => {
    expect(red('')).toBe('');
    expect(red('   ')).toBe('');
    expect(redactPersonalData(undefined as unknown as string).text).toBe('');
    expect(redactPersonalData(null as unknown as string).text).toBe('');
  });

  it('collapses whitespace so multi-line pastes become one line', () => {
    expect(red('riga uno\n\n  riga due')).toBe('riga uno riga due');
  });
});

describe('inferNamesFromCapitalisation: the measured exception for short structured fields', () => {
  const off = (s: string) => redactPersonalData(s, { inferNamesFromCapitalisation: false }).text;
  const offKinds = (s: string) => redactPersonalData(s, { inferNamesFromCapitalisation: false }).kinds;

  it('keeps capitalised job titles and employers, which ARE the content of a search box', () => {
    // Real shapes from 800 distinct production search terms. With the broad
    // heuristic on, each of these is destroyed — they were 100% of its hits.
    for (const term of [
      'Project Manager',
      'Data Engineer',
      'Ente Ospedaliero Cantonale',
      'Amministrazione Cantonale Ticino',
      'Sviluppatore SAP BTP',
    ]) {
      expect(off(term), term).toBe(term);
      expect(offKinds(term)).toEqual([]);
    }
  });

  it('still strips every direct identifier, which is what actually protects the user', () => {
    expect(off('scrivimi a mario@example.com')).not.toContain('mario@example.com');
    expect(off('chiamami al +41 79 123 45 67')).not.toContain('79 123 45 67');
    expect(off('IBAN CH9300762011623852957')).not.toContain('CH9300762011623852957');
    expect(off('AVS 756.1234.5678.97')).not.toContain('756.1234.5678.97');
    expect(off('CF RSSMRA85T10A562S')).not.toContain('RSSMRA85T10A562S');
    expect(off('nato il 22/02/1988')).not.toContain('22/02/1988');
    expect(off('Bahnhofstrasse 12')).not.toContain('Bahnhofstrasse 12');
  });

  it('still strips a cue-introduced name — turning the heuristic off is not turning names off', () => {
    expect(off('mi chiamo Giovanni Bianchi')).not.toContain('Bianchi');
    expect(off('Herr Schmidt')).not.toContain('Schmidt');
  });

  it('defaults to ON, so a new caller gets the protective behaviour without opting in', () => {
    const s = 'Ho parlato con Anna Pedrazzini';
    expect(redactPersonalData(s).text).not.toContain('Pedrazzini');
    expect(redactPersonalData(s).text).toBe(redactPersonalData(s, {}).text);
  });
});

// ─── Second pass over the same module (#5196) ───────────────────────────────
//
// Everything below was measured against the module as it stood, not imagined.
// Three findings, of two different kinds:
//
//   UNDER-redaction, the privacy defect —
//     · a Swiss phone written with a slash ("091/123 45 67") went out in clear,
//       because the slash splits it one digit below the generic rule's floor;
//     · a permit / matricola number of seven digits went out in clear, being
//       one digit below that same floor and having no shape of its own.
//
//   OVER-redaction, the usefulness defect —
//     · the capitalised-run heuristic was calibrated on Italian and fires on
//       ORDINARY German and English prose, because German capitalises nouns.
//       On the site's own 412-question FAQ corpus (`data/faq-hub/category-*.ts`,
//       four locales, zero personal data in it) it hit 56 questions — 13.6%,
//       all false positives. After the guards below: 4 — 1.0%.
//     · the bare label cue `nome` swallowed the words after it in questions
//       like "nome del datore di lavoro?", one of this site's most common.

describe('Swiss phone numbers written with a slash', () => {
  // The slash is the ordinary Swiss way of writing these, and it was the one
  // separator the rule did not know — while `scripts/lib/strip-contact-pii.mjs`,
  // in this same repo, already listed it.
  const NUMBERS = ['091/123 45 67', '079/1234567', '022/345 67 89', '+41 91/123 45 67', '079/123.45.67'];

  for (const n of NUMBERS) {
    it(`redacts ${n}`, () => {
      const input = `Chiamami allo ${n}, grazie`;
      const out = red(input);
      expect(out, n).not.toContain(n);
      expect(kinds(input), n).toContain('phone');
    });
  }

  it('does not turn a year range or a fraction into a phone call', () => {
    // The rule anchors on `+41` / `0041` / a leading zero precisely so that the
    // slash alone is not enough — otherwise "2026/2027" becomes [phone] on a
    // site whose most common question token is a tax year.
    for (const q of ['aliquota 2026/2027 per frontalieri', 'orario 9/17', 'quanto costa il 3/4 di giornata']) {
      expect(red(q), q).toBe(q);
      expect(kinds(q), q).toEqual([]);
    }
  });
});

describe('identifiers introduced by an explicit label', () => {
  // A residence-permit card number has no shape to match — it is a bare digit
  // run, most often seven digits, one under the generic phone floor. The label
  // is the only marker, so the label is the anchor.
  it('redacts a permit number', () => {
    const input = 'Il mio permesso G n. 1234567 scade a giugno';
    const out = red(input);
    expect(out).not.toContain('1234567');
    expect(out).toContain('permesso G n.');
    expect(kinds(input)).toContain('id');
  });

  it('redacts a matricola and a German Ausweis number', () => {
    expect(red('La mia matricola 1234567 è corretta?')).not.toContain('1234567');
    expect(red('Meine Ausweis Nr. 12345 ist abgelaufen')).not.toContain('12345');
  });

  it('does NOT swallow a year after the same label', () => {
    // Five digits is the floor for exactly this reason: "numero 2026" must live.
    const q = 'Qual è il numero 2026 di riferimento?';
    expect(red(q)).toBe(q);
  });

  it('leaves a real phone labelled as a phone, not as an id', () => {
    // Ordering check: both phone rules run before the label rule, so the more
    // informative label wins where both could match.
    expect(kinds('il mio numero 0791234567')).toContain('phone');
  });
});

describe('the bare "nome" / "cognome" cue only counts in label position', () => {
  it('keeps the question shapes this site is actually made of', () => {
    // These were destroyed: "nome del datore di lavoro?" → "nome [name] lavoro?".
    for (const q of [
      'nome del datore di lavoro?',
      'il nome della cassa malati?',
      'qual è il cognome corretto sul modulo?',
      'Nome e cognome del titolare?',
    ]) {
      expect(red(q), q).toBe(q);
      expect(kinds(q), q).toEqual([]);
    }
  });

  it('still redacts the label form, which is what a pasted form looks like', () => {
    for (const q of ['Nome: mario rossi', 'Nome e cognome: Marco Bernasconi', 'Nome Marco Bernasconi']) {
      expect(red(q), q).not.toMatch(/rossi|Bernasconi/i);
      expect(kinds(q), q).toContain('name');
    }
  });

  it('a strong verbal cue is unaffected and works in lower case', () => {
    // The phrasings people actually use to volunteer a name. Lower case matters:
    // this is what a phone keyboard produces.
    for (const q of [
      'mi chiamo mario rossi',
      'ich heisse jürgen müller',
      "je m'appelle françois dupont",
      'my name is john smith',
    ]) {
      const out = red(q);
      expect(out, q).toContain(REDACTION_TOKENS.name);
      expect(out.toLowerCase(), q).not.toContain('rossi');
      expect(out.toLowerCase(), q).not.toContain('müller');
      expect(out.toLowerCase(), q).not.toContain('dupont');
      expect(out.toLowerCase(), q).not.toContain('smith');
    }
  });
});

describe('the capitalised-run heuristic outside Italian', () => {
  // German capitalises every noun and English capitalises scheme names, so the
  // rule fired on questions with no person in them at all. All of the fixtures
  // below are verbatim from the site's own FAQ corpus — editorial text, not
  // user input, and containing no personal data.
  const FAQ_MUST_SURVIVE = [
    'Welche Kündigungsfristen gelten in Schweizer Arbeitsverträgen?',
    'Kann ich als Grenzgänger ein Schweizer Bankkonto eröffnen?',
    'Müssen Grenzgänger die Serafe/SRG-Gebühr zahlen?',
    'Does Swiss law provide a TFR equivalent as in Italy?',
    'Which LAMal deductible is most convenient for a cross-border worker?',
    'Is the SBB GA travelcard worthwhile for a cross-border worker?',
    'La NASpI italiana spetta al frontaliere licenziato dalla Svizzera?',
    'Quels cadres du formulaire Redditi PF 2026 doit remplir un nouveau frontalier ?',
  ];

  for (const q of FAQ_MUST_SURVIVE) {
    it(`keeps: ${q.slice(0, 46)}…`, () => {
      expect(red(q)).toBe(q);
      expect(kinds(q)).toEqual([]);
    });
  }

  it('the German fixtures are genuinely non-ASCII', () => {
    expect(hasNonAscii('Welche Kündigungsfristen gelten in Schweizer Arbeitsverträgen?')).toBe(true);
  });

  it('a name flanked by grammar is still redacted — only the grammar survives', () => {
    // This is what keeps the narrowing honest: dropping edge tokens cannot hide
    // a person, it can only stop reporting the words around one.
    for (const [input, leak] of [
      ['Kann Mario Rossi den Antrag stellen?', 'Rossi'],
      ['Ho parlato con Anna Pedrazzini della pratica', 'Pedrazzini'],
      ['Sono Mario Rossi e sono frontaliere', 'Rossi'],
      ['Which documents does Anna Pedrazzini need?', 'Pedrazzini'],
    ] as const) {
      const out = red(input);
      expect(out, input).not.toContain(leak);
      expect(kinds(input), input).toContain('name');
    }
  });

  it('states its own residual: a SHORT all-caps surname is read as an acronym', () => {
    // Documented, not accidental. A 2–4 character all-caps token is an acronym
    // (AVS, KVG, SBB, PF) far more often than a surname, and treating it as a
    // name word is what turned one German question in seven into "[name]".
    // The cue and honorific rules still catch the same person.
    expect(red('Anna NERI mi ha aiutato')).toContain('NERI');
    expect(red('mi chiamo Anna NERI')).not.toContain('NERI');
    expect(red('La Sig.ra NERI mi ha aiutato')).not.toContain('NERI');
    // Five characters and up is still a name: the cap is set below the common
    // surname length on purpose.
    expect(red('Anna ROSSINI mi ha aiutato')).not.toContain('ROSSINI');
  });
});

describe('redaction is idempotent — a token is never re-read as content', () => {
  it('running it twice changes nothing', () => {
    const inputs = [
      'Mi chiamo Marco Bernasconi, nato il 22/02/1988, Via alla Stampa 11B, tel 091/123 45 67',
      'Ich heiße Jürgen Müller, Bahnhofstrasse 12, 8001 Zürich',
      "Je m'appelle Chloé Béranger, 5 rue de la Gare, permesso G n. 1234567",
    ];
    for (const input of inputs) {
      const once = red(input);
      expect(red(once), input).toBe(once);
    }
  });
});
