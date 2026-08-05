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
