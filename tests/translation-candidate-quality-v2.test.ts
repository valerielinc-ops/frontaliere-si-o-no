import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { assessTranslationCandidateQualityV2 } from '../scripts/lib/translation-candidate-quality-v2.mjs';
import {
  createEmptyTranslationMemoryV2,
  recordTranslationCandidateV2,
} from '../scripts/lib/content-addressed-translation-memory-v2.mjs';
import { createTranslationUnitIdentityV2 } from '../scripts/lib/translation-unit-identity-v2.mjs';

const long = (text: string) => `${text} ${'esperienza competenze responsabilità '.repeat(5)}`;
const base = {
  sourceText: long('The candidate supports clients and the team.'),
  candidateText: long('Il candidato supporta clienti e il team.'),
  sourceLang: 'en',
  targetLang: 'it',
  field: 'description' as const,
  protectedTokens: [],
};

function codes(result: ReturnType<typeof assessTranslationCandidateQualityV2>) {
  return result.evidence.map((item) => item.code);
}

describe('translation candidate quality v2', () => {
  it('has a frozen exact, deterministic and PII-free result schema', () => {
    const first = assessTranslationCandidateQualityV2(base);
    const second = assessTranslationCandidateQualityV2({ ...base, protectedTokens: [] });
    expect(first).toEqual(second);
    expect(Object.keys(first).sort()).toEqual(['evidence', 'metrics', 'retryClass', 'schemaVersion', 'status']);
    expect(Object.keys(first.metrics).sort()).toEqual(['advisoryCount', 'appliedGates', 'blockingFailureCount']);
    expect(first).toEqual(expect.objectContaining({ schemaVersion: 2, status: 'validated', retryClass: 'none' }));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.evidence)).toBe(true);
    expect(Object.isFrozen(first.metrics)).toBe(true);
    expect(() => { (first.metrics as { appliedGates: number }).appliedGates = 0; }).toThrow();
    expect(JSON.stringify(first)).not.toContain(base.sourceText);
    expect(JSON.stringify(first)).not.toContain(base.candidateText);
    expect(first.evidence).toEqual([...first.evidence].sort((a, b) => `${a.code}:${a.digest}`.localeCompare(`${b.code}:${b.digest}`)));
    expect(new Set(first.evidence.map((item) => `${item.code}:${item.digest}`)).size).toBe(first.evidence.length);
    expect(first.evidence.every((item) => /^[a-f0-9]{64}$/.test(item.digest))).toBe(true);
  });

  it('rejects non-plain, non-exact, invalid and hostile bounded inputs', () => {
    expect(() => assessTranslationCandidateQualityV2([] as never)).toThrow(TypeError);
    expect(() => assessTranslationCandidateQualityV2({ ...base, extra: true } as never)).toThrow(TypeError);
    expect(() => assessTranslationCandidateQualityV2({ ...base, sourceLang: 'es' })).toThrow(TypeError);
    expect(() => assessTranslationCandidateQualityV2({ ...base, field: 'summary' as never })).toThrow(TypeError);
    expect(() => assessTranslationCandidateQualityV2({ ...base, candidateText: 'x'.repeat(120_001) })).toThrow(TypeError);
    expect(() => assessTranslationCandidateQualityV2({
      ...base,
      protectedTokens: Array.from({ length: 65 }, () => ({ category: 'company', value: 'Acme' })),
    })).toThrow(TypeError);
    expect(() => assessTranslationCandidateQualityV2({
      ...base,
      protectedTokens: [{ category: 'company', value: 'Acme', extra: true }],
    } as never)).toThrow(TypeError);
    expect(() => assessTranslationCandidateQualityV2({
      ...base,
      protectedTokens: [{ category: 'company', value: 'ACME' }, { category: 'company', value: 'acme' }],
    })).toThrow(TypeError);
    expect(() => assessTranslationCandidateQualityV2({
      ...base,
      protectedTokens: [{ category: 'structured', value: '\u200b' }],
    })).toThrow(TypeError);
  });

  it('snapshots only exact data descriptors before reading bounded quality input', () => {
    let candidateReads = 0;
    const candidateAccessor = { ...base } as Record<string, unknown>;
    Object.defineProperty(candidateAccessor, 'candidateText', {
      enumerable: true,
      get() { candidateReads += 1; return 'x'.repeat(120_001); },
    });
    expect(() => assessTranslationCandidateQualityV2(candidateAccessor as never)).toThrow(TypeError);
    expect(candidateReads).toBe(0);

    let tokenReads = 0;
    const tokensAccessor = { ...base } as Record<string, unknown>;
    Object.defineProperty(tokensAccessor, 'protectedTokens', {
      enumerable: true,
      get() { tokenReads += 1; return Array.from({ length: 65 }, () => ({ category: 'company', value: 'Acme' })); },
    });
    expect(() => assessTranslationCandidateQualityV2(tokensAccessor as never)).toThrow(TypeError);
    expect(tokenReads).toBe(0);

    let itemReads = 0;
    const protectedTokens = [{ category: 'company', value: 'Acme' }];
    Object.defineProperty(protectedTokens, '0', {
      enumerable: true,
      get() { itemReads += 1; return { category: 'company', value: 'Acme' }; },
    });
    expect(() => assessTranslationCandidateQualityV2({ ...base, protectedTokens })).toThrow(TypeError);
    expect(itemReads).toBe(0);

    for (const length of [500_000, 2 ** 32 - 1]) {
      const sparse = [] as Array<{ category: string; value: string }>;
      sparse.length = length;
      expect(() => assessTranslationCandidateQualityV2({ ...base, protectedTokens: sparse })).toThrow(TypeError);
    }
  });

  it('classifies empty source terminally and empty candidate as retryable', () => {
    expect(assessTranslationCandidateQualityV2({ ...base, sourceText: '', candidateText: '' })).toMatchObject({
      status: 'rejected', retryClass: 'terminal',
    });
    expect(assessTranslationCandidateQualityV2({ ...base, candidateText: '' })).toMatchObject({
      status: 'rejected', retryClass: 'retryable',
    });
  });

  it('preserves URL and email multisets exactly, including query strings', () => {
    const source = long('Read https://example.test/jobs?id=42&lang=en and write hr@example.test twice: hr@example.test.');
    const candidate = long('Leggi https://example.test/jobs?id=42&lang=en e scrivi hr@example.test due volte: hr@example.test.');
    expect(assessTranslationCandidateQualityV2({ ...base, sourceText: source, candidateText: candidate }).status).toBe('validated');
    const changed = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: source,
      candidateText: candidate.replace('lang=en', 'lang=it').replace('hr@example.test.', 'jobs@example.test.'),
    });
    expect(codes(changed)).toEqual(expect.arrayContaining(['email.multiset_mismatch', 'url.multiset_mismatch']));
    const terminalUrl = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long('Read https://example.test/jobs/?a=1#fragment!'),
      candidateText: long('Leggi https://example.test/jobs/?a=1#fragment/'),
    });
    expect(codes(terminalUrl)).toContain('url.multiset_mismatch');
    const wrappedUrl = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long('Read (https://example.test/jobs/?a=1#fragment)'),
      candidateText: long('Leggi https://example.test/jobs/?a=1#fragment'),
    });
    expect(codes(wrappedUrl)).not.toContain('url.multiset_mismatch');
    const wrappedUnicodeEmail = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long('Write (üñîçøðé@example.test) and <hr@example.test>.'),
      candidateText: long('Scrivi üñîçøðé@example.test e <jobs@example.test>.'),
    });
    expect(codes(wrappedUnicodeEmail)).toContain('email.multiset_mismatch');
  });

  it('normalizes Swiss, German, French and Italian number separators conservatively', () => {
    const cases = [
      ['CHF 120\'000', 'CHF 120.000', 'de'],
      ['EUR 1,234.50', '1.234,50 €', 'it'],
      ['1\u202f234,50 €', 'EUR 1,234.50', 'en'],
      ['2,5%', '2.5 %', 'en'],
    ] as const;
    for (const [sourceNumber, candidateNumber, targetLang] of cases) {
      const source = long(`Salary is ${sourceNumber} for this position.`);
      const candidate = long(`La retribuzione è ${candidateNumber} per questa posizione.`);
      expect(codes(assessTranslationCandidateQualityV2({ ...base, sourceText: source, candidateText: candidate, targetLang }))).not.toContain('numeric.multiset_mismatch');
    }
    const wrong = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long('Salary is CHF 120\'000 and bonus is 10%.'),
      candidateText: long('Lo stipendio è CHF 121.000 e il bonus è 10%.'),
      targetLang: 'it',
    });
    expect(codes(wrong)).toContain('numeric.multiset_mismatch');
    const signsAndSegments = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long('Compensation is - CHF 10, bonus +2.5%, date 2024.10.01 and v1.2.3.'),
      candidateText: long('Il compenso è - CHF 10, bonus +2,5%, data 2024.10.01 e v1.2.3!'),
    });
    expect(codes(signsAndSegments)).not.toContain('numeric.multiset_mismatch');
    const changedSignsAndSegments = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long('Compensation is - CHF 10, date 2024.10.01 and v1.2.3.'),
      candidateText: long('Il compenso è CHF 10, data 20241001 e v123.'),
    });
    expect(codes(changedSignsAndSegments)).toContain('numeric.multiset_mismatch');
    const terminalPunctuation = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long('There are 42.'),
      candidateText: long('Ci sono 42!'),
    });
    expect(codes(terminalPunctuation)).not.toContain('numeric.multiset_mismatch');
    const unicodeMinus = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long('Compensation is − CHF 10 and bonus is +2%.'),
      candidateText: long('Il compenso è - CHF 10 e il bonus è +2%.'),
    });
    expect(codes(unicodeMinus)).not.toContain('numeric.multiset_mismatch');
    const orderedDate = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long('The start date is 2024-10-01 and the rate is .5%.'),
      candidateText: long('La data di inizio è 2024-01-10 e il tasso è .6%.'),
    });
    expect(codes(orderedDate)).toContain('numeric.multiset_mismatch');
    const rangeDash = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long('The employment level is 80-100% and salary is CHF10.'),
      candidateText: long('Il grado di impiego è 80–100% e lo stipendio è CHF10.'),
    });
    expect(codes(rangeDash)).not.toContain('numeric.multiset_mismatch');
    const spacedAffixes = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long(`The adjustment is +\n\n\n CHF\n\n10 and the bonus is .5 %.`),
      candidateText: long(`L'adeguamento è +\n\n\n CHF\n\n10 e il bonus è .5 %.`),
    });
    expect(codes(spacedAffixes)).not.toContain('numeric.multiset_mismatch');
    const changedCurrency = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long('The salary is CHF10.'),
      candidateText: long('Lo stipendio è EUR10.'),
    });
    expect(codes(changedCurrency)).toContain('numeric.multiset_mismatch');
    for (const [sourceNumber, candidateNumber, expected] of [
      ['CHF\u206110', 'CHF10', false],
      ['CHF\u206110', 'EUR10', true],
      ['+\u2061CHF\u206110', '+ CHF 10', false],
      ['10\u2061%', '10%', false],
      ['10\u2061%', '10', true],
      ['CHF\u206180\u2061-\u2061100', '80-100 CHF', false],
    ] as const) {
      const result = assessTranslationCandidateQualityV2({
        ...base,
        sourceText: long(`The amount is ${sourceNumber}.`),
        candidateText: long(`L'importo è ${candidateNumber}.`),
      });
      expect(codes(result).includes('numeric.multiset_mismatch')).toBe(expected);
    }
    const completeRange = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long('The compensation range is - CHF 80 - + CHF 100%.'),
      candidateText: long('La fascia salariale è -\nCHF 80 – +\nCHF 100 %.'),
    });
    expect(codes(completeRange)).not.toContain('numeric.multiset_mismatch');
    for (const candidateText of [
      'La fascia salariale è - EUR 80 – + EUR 100%.',
      'La fascia salariale è - 80 – + 100%.',
      'La fascia salariale è + CHF 80 – + CHF 100%.',
      'La fascia salariale è - CHF 80 – - CHF 100%.',
    ]) {
      expect(codes(assessTranslationCandidateQualityV2({
        ...base,
        sourceText: long('The compensation range is - CHF 80 - + CHF 100%.'),
        candidateText: long(candidateText),
      }))).toContain('numeric.multiset_mismatch');
    }
    const postfixedRange = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long('The compensation range is 80 CHF - 100 CHF.'),
      candidateText: long('La fascia salariale è 80 EUR – 100 EUR.'),
    });
    expect(codes(postfixedRange)).toContain('numeric.multiset_mismatch');
    const rangeEquivalents = ['CHF 80-100', '80-100 CHF', '80 CHF - 100 CHF', '80%-100%', '80-100%'];
    for (const candidateText of rangeEquivalents) {
      const sourceRange = candidateText.includes('%') ? '80-100%' : 'CHF 80-100';
      expect(codes(assessTranslationCandidateQualityV2({
        ...base,
        sourceText: long(`The range is ${sourceRange}.`),
        candidateText: long(`La fascia è ${candidateText}.`),
      }))).not.toContain('numeric.multiset_mismatch');
    }
    const groupingEquivalent = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long('The range is EUR 1,000-2,000.'),
      candidateText: long('La fascia è 1.000-2.000 €.'),
      targetLang: 'it',
    });
    expect(codes(groupingEquivalent)).not.toContain('numeric.multiset_mismatch');
    const mixedCurrency = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long('The range is CHF 80-EUR 100.'),
      candidateText: long('La fascia è EUR 80-CHF 100.'),
    });
    expect(codes(mixedCurrency)).toContain('numeric.multiset_mismatch');
    for (const currency of ['CHF', 'EUR', 'USD', 'GBP']) {
      for (const candidateRange of [`10-20 ${currency}`, `10 ${currency} - 20 ${currency}`]) {
        expect(codes(assessTranslationCandidateQualityV2({
          ...base,
          sourceText: long(`The range is ${currency} 10-20.`),
          candidateText: long(`La fascia è ${candidateRange}.`),
        }))).not.toContain('numeric.multiset_mismatch');
      }
    }
    for (const [sourceRange, candidateRange] of [
      ['10% - EUR20', 'EUR10 - 20%'],
      ['10CHF-20%', '10%-20CHF'],
    ]) {
      expect(codes(assessTranslationCandidateQualityV2({
        ...base,
        sourceText: long(`The range is ${sourceRange}.`),
        candidateText: long(`La fascia è ${candidateRange}.`),
      }))).toContain('numeric.multiset_mismatch');
    }
    for (const [sourceNumber, candidateNumber] of [
      ['40 hours/week', '40 ore/settimana'],
      ['40h', '40 heures'],
      ['40 Stunden/Woche', '40 hours/week'],
      ['40 months', '40 mesi'],
    ]) {
      expect(codes(assessTranslationCandidateQualityV2({
        ...base,
        sourceText: long(`The contract is ${sourceNumber}.`),
        candidateText: long(`Il contratto è ${candidateNumber}.`),
      }))).not.toContain('numeric.multiset_mismatch');
    }
    for (const [sourceNumber, candidateNumber] of [
      ['100CHF', '200CHF'],
      ['100CHF', '100EUR'],
      ['40h', '20h'],
      ['40 hours/week', '40 ore/mese'],
    ]) {
      expect(codes(assessTranslationCandidateQualityV2({
        ...base,
        sourceText: long(`The contract is ${sourceNumber}.`),
        candidateText: long(`Il contratto è ${candidateNumber}.`),
      }))).toContain('numeric.multiset_mismatch');
    }
    let seed = 0x5eed;
    for (let index = 0; index < 32; index += 1) {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      const first = 1 + (seed % 900);
      const second = first + 1 + ((seed >>> 8) % 99);
      const sourceRange = `CHF ${first}-${second}`;
      const candidateRange = index % 2 === 0 ? `${first}-${second} CHF` : `${first} CHF – ${second} CHF`;
      expect(codes(assessTranslationCandidateQualityV2({
        ...base,
        sourceText: long(`The range is ${sourceRange}.`),
        candidateText: long(`La fascia è ${candidateRange}.`),
      }))).not.toContain('numeric.multiset_mismatch');
    }
  });

  it('keeps numeric and email extraction bounded for dense hostile-looking text', () => {
    const numericRun = Array.from({ length: 8_000 }, (_, index) => String(index + 1)).join(' ');
    const emailRun = 'http://x.co u@e.co '.repeat(6_000);
    const start = performance.now();
    const numeric = assessTranslationCandidateQualityV2({
      ...base, sourceText: numericRun, candidateText: numericRun,
    });
    const emails = assessTranslationCandidateQualityV2({
      ...base, sourceText: emailRun, candidateText: emailRun,
    });
    expect(numeric.status).toBe('rejected');
    expect(emails.status).toBe('rejected');
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it('streams URL suppression before email comparison without a sorting path', () => {
    const source = readFileSync(new URL('../scripts/lib/translation-candidate-quality-v2.mjs', import.meta.url), 'utf8');
    const emailExtraction = source.slice(source.indexOf('function extractEmails'), source.indexOf('function numericCore'));
    expect(emailExtraction).not.toContain('mergeRanges');
    expect(emailExtraction).not.toContain('.sort(');
  });

  it('blocks source echoes, flattened bullets, title residue and concatenated words', () => {
    expect(codes(assessTranslationCandidateQualityV2({ ...base, candidateText: base.sourceText }))).toContain('source.echo');
    const echoSource = `Skills: JavaScript, SQL; 2024-10-01! ${'unique skills roles '.repeat(8)}`;
    const echoCandidate = `skills JavaScript SQL 2024 10 01 ${'unique skills roles '.repeat(8)}`;
    expect(codes(assessTranslationCandidateQualityV2({ ...base, sourceText: echoSource, candidateText: echoCandidate }))).toContain('source.echo');
    const bullets = `- First responsibility\n- Second responsibility\n- Third responsibility\n${'More role details. '.repeat(12)}`;
    const flattened = `Prima responsabilità. Seconda responsabilità. Terza responsabilità. ${'Altri dettagli del ruolo. '.repeat(12)}`;
    expect(codes(assessTranslationCandidateQualityV2({ ...base, sourceText: bullets, candidateText: flattened }))).toContain('structure.flattened');
    const title = assessTranslationCandidateQualityV2({
      ...base,
      field: 'title',
      sourceText: 'Senior Software Engineer',
      candidateText: 'Senior Software Engineer',
    });
    expect(codes(title)).toContain('title.untranslated');
    const glued = assessTranslationCandidateQualityV2({
      ...base,
      field: 'title',
      sourceText: 'Branch manager',
      candidateText: 'Direttoredifiliale',
    });
    expect(codes(glued)).toContain('title.concatenated_words');
  });

  it('recognizes source echoes through default-ignorable and combining insertions', () => {
    for (const insertion of ['\u200b', '\u2061', '\u{e0100}', '\ufe0f', '\u034f', '\u1ab0']) {
      const sourceText = long('The candidate supports clients with practical experience.');
      for (const candidateText of [
        `${insertion}${sourceText}`,
        sourceText.replace('supports', `sup${insertion}ports`),
        `${sourceText}${insertion}`,
      ]) {
        expect(codes(assessTranslationCandidateQualityV2({ ...base, sourceText, candidateText }))).toContain('source.echo');
      }
    }
  });

  it('requires source-present protected values with case and Unicode-insensitive matching', () => {
    const protectedTokens = [
      { category: 'company', value: 'Société Müller AG' },
      { category: 'person', value: 'Anaïs Dupont' },
      { category: 'location', value: 'Zürich' },
      { category: 'salary', value: 'CHF 120\'000' },
    ] as const;
    const source = long('Société Müller AG asks Anaïs Dupont to work in Zürich for CHF 120\'000.');
    const preserved = long('SOCIETE MULLER AG chiede ad ANAIS DUPONT di lavorare a ZURICH per CHF 120.000.');
    expect(codes(assessTranslationCandidateQualityV2({ ...base, sourceText: source, candidateText: preserved, protectedTokens: [...protectedTokens] }))).not.toContain('protected_token.missing');
    const missing = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: source,
      candidateText: long('L’azienda richiede una persona per lavorare in Svizzera per CHF 120\'000.'),
      protectedTokens: [...protectedTokens],
    });
    expect(codes(missing)).toContain('protected_token.missing');
    expect(JSON.stringify(missing)).not.toContain('Müller');
    expect(JSON.stringify(missing)).not.toContain('Dupont');
    const boundary = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long('ACME hires a developer.'),
      candidateText: long('ACMEX assume uno sviluppatore.'),
      protectedTokens: [{ category: 'company', value: 'ACME' }],
    });
    expect(codes(boundary)).toContain('protected_token.missing');
    const symbols = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long('C++ works with AT&T.'),
      candidateText: long('C works with AT T.'),
      protectedTokens: [{ category: 'structured', value: 'C++' }, { category: 'company', value: 'AT&T' }],
    });
    expect(codes(symbols)).toContain('protected_token.missing');
    const preservedSymbols = assessTranslationCandidateQualityV2({
      ...base,
      sourceText: long('C++ works with C# and AT&T.'),
      candidateText: long('C++ lavora con C# e AT&T.'),
      protectedTokens: [{ category: 'structured', value: 'C++' }, { category: 'structured', value: 'C#' }, { category: 'company', value: 'AT&T' }],
    });
    expect(codes(preservedSymbols)).not.toContain('protected_token.missing');
    for (const candidateText of ['C++X works with AT&T.', 'XC++ works with AT&T.', 'C++ works with AT&TX.', 'C++ works with XAT&T.']) {
      expect(codes(assessTranslationCandidateQualityV2({
        ...base,
        sourceText: long('C++ works with C# and AT&T.'),
        candidateText: long(candidateText),
        protectedTokens: [{ category: 'structured', value: 'C++' }, { category: 'structured', value: 'C#' }, { category: 'company', value: 'AT&T' }],
      }))).toContain('protected_token.missing');
    }
    for (const candidateText of ['C ++ works with C# and AT&T.', 'C++ works with C-# and AT&T.', 'C++ works with AT-&-T.']) {
      expect(codes(assessTranslationCandidateQualityV2({
        ...base,
        sourceText: long('C++ works with C# and AT&T.'),
        candidateText: long(candidateText),
        protectedTokens: [{ category: 'structured', value: 'C++' }, { category: 'structured', value: 'C#' }, { category: 'company', value: 'AT&T' }],
      }))).toContain('protected_token.missing');
    }
    for (const candidateText of ['ACME\u1ab0X lavora.', 'ACME\u200dX lavora.', 'C++\u1ab0X lavora.']) {
      const token = candidateText.startsWith('C++') ? 'C++' : 'ACME';
      expect(codes(assessTranslationCandidateQualityV2({
        ...base,
        sourceText: long(`${token} lavora.`),
        candidateText: long(candidateText),
        protectedTokens: [{ category: 'company', value: token }],
      }))).toContain('protected_token.missing');
    }
    for (const ignorable of ['\u2061', '\u00ad', '\u200e', '\u2066', '\u200c', '\u{e0100}']) {
      for (const [token, candidateText] of [
        ['ACME', `ACME${ignorable}X lavora.`],
        ['C++', `C++${ignorable}X lavora.`],
      ]) {
        expect(codes(assessTranslationCandidateQualityV2({
          ...base,
          sourceText: long(`${token} lavora.`),
          candidateText: long(candidateText),
          protectedTokens: [{ category: 'company', value: token }],
        }))).toContain('protected_token.missing');
      }
    }
    for (const candidateText of ['C+++ lavora.', 'C## lavora.', 'AT&T& lavora.', '+C++ lavora.', '#C# lavora.', '&AT&T lavora.']) {
      const token = candidateText.includes('AT&T') ? 'AT&T' : candidateText.includes('C#') ? 'C#' : 'C++';
      expect(codes(assessTranslationCandidateQualityV2({
        ...base,
        sourceText: long(`${token} lavora.`),
        candidateText: long(candidateText),
        protectedTokens: [{ category: 'structured', value: token }],
      }))).toContain('protected_token.missing');
    }
    expect(() => assessTranslationCandidateQualityV2({
      ...base,
      protectedTokens: [{ category: 'structured', value: 'C++' }, { category: 'structured', value: 'c++' }],
    })).toThrow(TypeError);
  });

  it('rejects degenerate visible content and records it only as rejected', () => {
    const degenerateDescriptions = ['A', 'X', 'OK', 'Dev', '...', '!'.repeat(160), '\u200b'.repeat(160), 'ciao '.repeat(40), 'ciao mondo '.repeat(40), '🚀'.repeat(80)];
    const identity = createTranslationUnitIdentityV2({
      kind: 'job', fieldPath: 'description', sourceLocale: 'en', targetLocale: 'it', sourceText: base.sourceText,
      context: { company: null, location: null },
    });
    for (const candidateText of degenerateDescriptions) {
      const outcome = assessTranslationCandidateQualityV2({ ...base, candidateText });
      expect(outcome.status).toBe('rejected');
      expect(codes(outcome)).toContain('description.degenerate_content');
      const stored = recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
        identity,
        engineVersion: 'candidate-quality-v2',
        gateVersion: 'candidate-quality-v2',
        outputText: candidateText,
        status: outcome.status,
        evidence: outcome.evidence,
      });
      expect(stored.records[0].candidates[0].status).toBe('rejected');
    }
  });

  it('rejects dominant near-periodic descriptions but preserves ordinary prose', () => {
    const repeated = Array.from({ length: 40 }, () => 'ciao mondo').join(' ');
    for (const candidateText of [
      `${repeated} ciao`,
      repeated.replace('ciao mondo ciao mondo', 'ciao mondo ciao universo'),
    ]) {
      const outcome = assessTranslationCandidateQualityV2({ ...base, candidateText });
      expect(codes(outcome)).toContain('description.degenerate_content');
    }
    expect(codes(assessTranslationCandidateQualityV2({
      ...base,
      candidateText: long('Il candidato coordina clienti, documentazione e responsabilità operative con il team.'),
    }))).not.toContain('description.degenerate_content');
  });

  it('rejects long-period repeated descriptions with short prefixes, tails and one replacement', () => {
    for (const period of [17, 32, 100]) {
      const phrase = Array.from({ length: period }, (_, index) => `term${index}`).join(' ');
      const repeated = Array.from({ length: 4 }, () => phrase).join(' ');
      const prefix = Array.from({ length: 2 }, (_, index) => `intro${index}`).join(' ');
      for (const candidateText of [
        `${prefix} ${repeated} tail`,
        `${prefix} ${repeated}`.replace(`term${Math.floor(period / 2)}`, 'sostituito'),
      ]) {
        expect(codes(assessTranslationCandidateQualityV2({ ...base, candidateText }))).toContain('description.degenerate_content');
      }
    }
  });

  it('rejects a periodic tail despite same-period decoy anchors outside the region', () => {
    const prefixTokens = Array.from({ length: 500 }, (_, index) => `intro${index}`);
    for (const index of [0, 25, 50, 75]) prefixTokens[index] = 'decoy';
    const prefix = prefixTokens.join(' ');
    const phraseTokens = Array.from({ length: 25 }, (_, index) => `tail${index}`);
    const tailTokens = Array.from({ length: 200 }, () => phraseTokens).flat();
    tailTokens[Math.floor(tailTokens.length / 2)] = 'sostituito';
    const candidateText = `${prefix} ${tailTokens.join(' ')}`;
    expect(codes(assessTranslationCandidateQualityV2({ ...base, candidateText }))).toContain('description.degenerate_content');
    const suffix = Array.from({ length: 35 }, (_, index) => `suffix${index}`);
    expect(codes(assessTranslationCandidateQualityV2({
      ...base,
      candidateText: `${tailTokens.join(' ')} ${suffix.join(' ')}`,
    }))).toContain('description.degenerate_content');
    const period100 = Array.from({ length: 100 }, (_, index) => `period${index}`).join(' ');
    const withSuffix = `${Array.from({ length: 4 }, () => period100).join(' ')} ${Array.from({ length: 35 }, (_, index) => `suffix${index}`).join(' ')}`;
    expect(codes(assessTranslationCandidateQualityV2({ ...base, candidateText: withSuffix }))).toContain('description.degenerate_content');
  });

  it('measures the title fixture and uses a structural, not ratio, truncation gate', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/title-locale-corpus.json', import.meta.url), 'utf8'));
    const tokens = (text: string | null) => String(text ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[\p{L}\p{N}]+/gu) ?? [];
    const fold = (text: string) => tokens(text).join(' ').toLowerCase();
    const pairs = fixture.entries.filter((entry: Record<string, string | null>) => (
      entry.sourceTitle && entry.title && entry.sourceLang !== entry.targetLocale
      && fold(entry.sourceTitle) !== fold(entry.title)
    ));
    const singletonTargets = pairs.filter((entry: Record<string, string>) => tokens(entry.title).length === 1);
    expect(pairs).toHaveLength(119);
    expect(singletonTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceTitle: 'Techniker*in', title: 'Technicien', broken: false }),
    ]));
    expect(Math.min(...singletonTargets.map((entry: Record<string, string>) => tokens(entry.title)[0].length))).toBe(10);

    for (const candidateText of ['A', 'X', 'OK', 'Dev', '...', '\u200b', '🚀']) {
      const outcome = assessTranslationCandidateQualityV2({
        ...base, field: 'title', sourceText: 'Senior Software Developer', candidateText,
      });
      expect(outcome.status).toBe('rejected');
      expect(codes(outcome)).toContain('title.incomplete_content');
    }
    expect(codes(assessTranslationCandidateQualityV2({
      ...base, field: 'title', sourceText: 'Techniker*in', candidateText: 'Technicien', sourceLang: 'de', targetLang: 'fr',
    }))).not.toContain('title.incomplete_content');
    for (const [sourceText, candidateText] of [
      ['Chief Executive Officer', 'CEO'],
      ['Human Resources', 'HR'],
      ['Quality Assurance', 'QA'],
      ['Information Technology', 'IT'],
      ['Ressources Humaines', 'RH'],
    ]) {
      const outcome = assessTranslationCandidateQualityV2({ ...base, field: 'title', sourceText, candidateText });
      expect(codes(outcome)).not.toContain('title.incomplete_content');
      expect(outcome.status).toBe('validated');
    }
  });

  it('blocks every known non-target language while retaining truly unknown detection as advisory', () => {
    const mismatch = assessTranslationCandidateQualityV2({
      ...base,
      candidateText: 'Wir suchen eine erfahrene Person mit Berufserfahrung. Die Aufgaben und Anforderungen sind klar. '.repeat(12),
    });
    expect(codes(mismatch)).toContain('language.high_confidence_mismatch');
    const advisory = assessTranslationCandidateQualityV2({
      ...base,
      candidateText: 'The position requires qualifications and responsibilities, and the team will support you. '.repeat(12),
    });
    expect(advisory.status).toBe('rejected');
    expect(codes(advisory)).toContain('language.low_confidence_mismatch');
    const shortTitle = assessTranslationCandidateQualityV2({
      ...base,
      field: 'title',
      sourceText: 'Chef',
      candidateText: 'Chef',
      sourceLang: 'fr',
      targetLang: 'it',
    });
    expect(codes(shortTitle)).not.toContain('language.high_confidence_mismatch');
  });

  it('keeps clean title fixture entries out of low-confidence language rejection', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/title-locale-corpus.json', import.meta.url), 'utf8'));
    const titleEntry = (entry: unknown): entry is {
      broken: boolean; isSourceSlot: boolean; sourceTitle: string; title: string; sourceLang: string; targetLocale: string;
    } => {
      if (!entry || typeof entry !== 'object') return false;
      const value = entry as Record<string, unknown>;
      return value.broken === false && value.isSourceSlot === false
        && typeof value.sourceTitle === 'string' && typeof value.title === 'string'
        && typeof value.sourceLang === 'string' && typeof value.targetLocale === 'string';
    };
    const clean = fixture.entries.filter(titleEntry).filter((entry: {
      sourceTitle: string; title: string; sourceLang: string; targetLocale: string;
    }) => (
      entry.sourceTitle.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('und')
        !== entry.title.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('und')
      && entry.sourceLang !== entry.targetLocale
    ));
    expect(clean).toHaveLength(81);
    for (const entry of clean) {
      const result = assessTranslationCandidateQualityV2({
        ...base,
        field: 'title',
        sourceText: entry.sourceTitle,
        candidateText: entry.title,
        sourceLang: entry.sourceLang,
        targetLang: entry.targetLocale,
      });
      expect(result.status === 'rejected' && codes(result).every((code) => code === 'language.low_confidence_mismatch')).toBe(false);
    }
  });

  it('can be recorded directly by translation memory v2 for both outcomes', () => {
    const identity = createTranslationUnitIdentityV2({
      kind: 'job', fieldPath: 'description', sourceLocale: 'en', targetLocale: 'it', sourceText: base.sourceText,
      context: { company: null, location: null },
    });
    const validated = assessTranslationCandidateQualityV2(base);
    const rejected = assessTranslationCandidateQualityV2({ ...base, candidateText: base.sourceText });
    for (const outcome of [validated, rejected]) {
      const stored = recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
        identity,
        engineVersion: 'candidate-quality-v2',
        gateVersion: 'candidate-quality-v2',
        outputText: outcome.status === 'validated' ? base.candidateText : base.sourceText,
        status: outcome.status,
        evidence: outcome.evidence,
      });
      expect(stored.records[0].candidates[0].status).toBe(outcome.status);
    }
  });

  it('remains linear for 120k text, 64 tokens and separator-heavy input', () => {
    const protectedTokens = Array.from({ length: 64 }, (_, index) => ({
      category: 'structured', value: `TOKEN${String(index).padStart(2, '0')}`,
    }));
    const tokenLine = protectedTokens.map((token) => token.value).join(' ');
    const sourceText = `${tokenLine} ${'1.'.repeat(60_000)}`.slice(0, 120_000);
    const candidateText = `${tokenLine} ${'1!'.repeat(60_000)}`.slice(0, 120_000);
    const start = performance.now();
    const result = assessTranslationCandidateQualityV2({
      ...base,
      sourceText,
      candidateText,
      protectedTokens,
    });
    expect(result.status).toBe('rejected');
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});
