// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { validateEditorialFactualityLedger } from '../scripts/ci/export-l6-factuality-outcomes.mjs';
import {
  buildVerdictRows,
  extractKeyFigures,
  extractSourceCitation,
  figureInSource,
  htmlToText,
  localeNumericParity,
  missingLocaleFigures,
  numberKeysInText,
} from '../scripts/lib/l6-source-check.mjs';

/**
 * Reduced copy of the real body of `blocco-ristorni-ticino-politica-2026`
 * (packages/articles/content/blog-body/<locale>/...): the key-facts lists,
 * one prose paragraph and the closing source citation, as the generator
 * writes them.
 */
const SOURCE_URL = 'https://www.ticinonews.ch/ticino/blocco-dei-ristorni-la-politica-e-possibilista-433327';
const CITATION = `*Fonte: [ticinonews.ch](${SOURCE_URL})*`;
const IT_BODY = [
  '## In breve',
  '- Il Consiglio di Stato ha tempo fino a fine giugno per decidere sul blocco dei ristorni',
  '- I partiti sono possibilisti ma chiedono fatti concreti',
  '',
  '## Fatti chiave',
  '- **Cosa**: Possibile blocco dei ristorni',
  '- Quando: Decisione entro fine giugno 2026',
  '- Dove: Canton Ticino',
  '- Importo: 120 milioni di franchi',
  '',
  'Il Consiglio di Stato ha tempo fino a fine giugno per decidere se trattenere i 120 milioni di imposta alla fonte dei frontalieri. Proprio come quindici anni fa, il blocco dei ristorni torna in prima pagina.',
  '',
  '### Conclusione',
  'Il possibile blocco dei ristorni rappresenta una sfida per i frontalieri che lavorano in Ticino.',
  '',
  CITATION,
].join('\n');
const EN_BODY = '## In brief\n- The State Council has until the end of June to decide\n\n## Key facts\n- When: Decision by the end of June 2026\n- Amount: 120 million francs\n\nThe State Council may withhold the 120 million francs.';
const DE_BODY = '## In Kürze\n- Der Staatsrat hat bis Ende Juni Zeit\n\n## Wichtige Fakten\n- Wann: Entscheidung bis Ende Juni 2026\n- Betrag: 120 Millionen Franken\n\nDer Staatsrat kann die 120 Millionen Franken zurückhalten.';
const FR_BODY = '## En bref\n- Le Conseil d\'État a jusqu\'à la fin juin\n\n## Faits clés\n- Quand : Décision d\'ici fin juin 2026\n- Montant : 120 millions de francs\n\nLe Conseil d\'État peut retenir les 120 millions de francs.';
const BODIES = { it: IT_BODY, en: EN_BODY, de: DE_BODY, fr: FR_BODY };
const SOURCE_HTML = `<!doctype html><html><head><style>.x{width:999px}</style><script>var id = 120;</script></head>
<body><article><h1>Blocco dei ristorni, la politica è possibilista</h1>
<p>Il Consiglio di Stato ha tempo fino a fine giugno per decidere se trattenere i 120&nbsp;Mio. di franchi.</p></article></body></html>`;

function source(text: string) {
  const now = new Date();
  return {
    url: SOURCE_URL,
    finalUrl: SOURCE_URL,
    httpStatus: 200,
    fetchedAt: new Date(now.getTime() - 60_000).toISOString(),
    sha256: 'b'.repeat(64),
    text,
  };
}

describe('extractSourceCitation', () => {
  it('reads the last cited source of the body', () => {
    expect(extractSourceCitation(IT_BODY)).toEqual({ host: 'www.ticinonews.ch', url: SOURCE_URL });
    const twice = `*Fonte: [rsi.ch](https://www.rsi.ch/a/)*\n\n${IT_BODY}`;
    expect(extractSourceCitation(twice)?.url).toBe(SOURCE_URL);
  });

  it('refuses this site, its subdomains, IP literals, localhost and plain http', () => {
    for (const url of [
      'https://frontaliereticino.ch/articoli/x/',
      'https://www.frontaliereticino.ch/articoli/x/',
      'https://cdn.frontaliereticino.ch/x/',
      'https://203.0.113.7/x/',
      'https://localhost/x/',
      'http://www.ticinonews.ch/x/',
    ]) {
      expect(extractSourceCitation(`testo\n\n*Fonte: [fonte](${url})*`), url).toBeNull();
    }
  });

  it('returns null when the body cites nothing', () => {
    expect(extractSourceCitation('## Fatti chiave\n- Importo: 120 milioni')).toBeNull();
  });
});

describe('extractKeyFigures', () => {
  it('reads the key facts of the real article and drops the year', () => {
    expect(extractKeyFigures(IT_BODY)).toEqual([{ raw: '120 milioni', value: 120_000_000, key: '120000000' }]);
  });

  it('discards years and one-digit numbers but keeps a one-digit amount with a multiplier', () => {
    const body = '## Fatti chiave\n- Anno: 2025\n- Persone: 5\n- Fondo: 5 milioni\n- Quota: 15%';
    expect(extractKeyFigures(body).map((figure) => figure.raw)).toEqual(['5 milioni', '15']);
  });

  it('ignores dates, clock times, legal references and the prose outside the lists', () => {
    const body = [
      '## In breve',
      '- Decreto firmato il 17 settembre, segnalato poco dopo le 2.30',
      '- Base legale: art. 15 LIFD, termine 30.06.2026',
      '- Aumento: dell’80%',
      '',
      'Nella prosa compaiono 999 franchi che non sono nei fatti chiave.',
    ].join('\n');
    expect(extractKeyFigures(body).map((figure) => figure.value)).toEqual([80]);
  });

  it('treats a bare number equal to a multiplied figure as the same figure', () => {
    const body = '## In breve\n- Fondo: 21,16 per il 2026\n\n## Fatti chiave\n- Fondo: 21,16 milioni di euro per il 2026';
    expect(extractKeyFigures(body).map((figure) => figure.raw)).toEqual(['21,16 milioni']);
  });

  it('returns no figure when the key facts carry none', () => {
    expect(extractKeyFigures('## Fatti chiave\n- Luogo: Lugano\n- Data: giugno 2026')).toEqual([]);
  });
});

describe('figureInSource', () => {
  const [figure] = extractKeyFigures(IT_BODY);

  it('matches 120 milioni with 120 Mio., 120\'000\'000 and the other spellings', () => {
    for (const text of ['trattenere i 120 Mio. di franchi', "importo di 120'000'000 franchi", 'CHF 120’000’000', '120.000.000 di franchi', 'i 120 milioni', '120 million francs', htmlToText(SOURCE_HTML)]) {
      expect(figureInSource(figure, text), text).toBe(true);
    }
  });

  it('does not match a different amount or the bare mantissa', () => {
    expect(figureInSource(figure, 'trattenere i 12 milioni')).toBe(false);
    expect(figureInSource(figure, 'trattenere i 120 franchi')).toBe(false);
  });

  it('reads elisions, number words and ambiguous separators on the source side', () => {
    expect([...numberKeysInText('tra lo 0,7% e l’1,2%')]).toEqual(expect.arrayContaining(['0.7', '1.2']));
    expect(numberKeysInText('oltre settanta docenti').has('70')).toBe(true);
    expect(numberKeysInText('ventitré persone').has('23')).toBe(true);
    const ambiguous = numberKeysInText('1,500 francs');
    expect(ambiguous.has('1500') && ambiguous.has('1.5')).toBe(true);
  });
});

describe('localeNumericParity', () => {
  const figures = extractKeyFigures(IT_BODY);

  it('accepts the real translations', () => {
    for (const body of [EN_BODY, DE_BODY, FR_BODY]) expect(localeNumericParity(figures, body)).toBe(true);
  });

  it('reports the figure a translation dropped', () => {
    const broken = DE_BODY.replace(/120 Millionen/g, '12 Millionen');
    expect(localeNumericParity(figures, broken)).toBe(false);
    expect(missingLocaleFigures(figures, broken).map((figure) => figure.raw)).toEqual(['120 milioni']);
  });
});

describe('buildVerdictRows', () => {
  it('emits one supported row per locale, each accepted by the L6 export contract', () => {
    const rows = buildVerdictRows({ articleId: 'blocco-ristorni-ticino-politica-2026', bodies: BODIES, source: source(htmlToText(SOURCE_HTML)) });
    expect(rows.map((row) => row.locale)).toEqual(['it', 'en', 'de', 'fr']);
    expect(rows.every((row) => row.verdict === 'supported' && row.evidence.figuresChecked === 1 && row.evidence.figuresMatched === 1)).toBe(true);
    const verdict = validateEditorialFactualityLedger(rows.map((row) => JSON.stringify(row)).join('\n'));
    expect(verdict.invalidRecords).toEqual([]);
    expect(verdict.quality).toBe('observed');
    expect(verdict.snapshot.reviewedArticles).toBe(rows.length);
  });

  it('turns a figure absent from the source into confirmed_defect with source:<figure>', () => {
    const invented = Object.fromEntries(Object.entries(BODIES).map(([locale, body]) => [locale, body.replace(/120/g, '450')]));
    const rows = buildVerdictRows({ articleId: 'invented', bodies: invented, source: source(htmlToText(SOURCE_HTML)) });
    expect(rows.map((row) => row.verdict)).toEqual(rows.map(() => 'confirmed_defect'));
    expect(rows.every((row) => row.evidence.figuresMatched === 0)).toBe(true);
    expect(rows[0].evidence.missingFigures).toEqual(['source:450 milioni']);
    const verdict = validateEditorialFactualityLedger(rows.map((row) => JSON.stringify(row)).join('\n'));
    expect(verdict.invalidRecords).toEqual([]);
    expect(verdict.snapshot.confirmedDefects).toBe(rows.length);
  });

  it('marks only the translation that lost a figure, with localeVerified still true', () => {
    const bodies = { ...BODIES, de: DE_BODY.replace(/120 Millionen/g, '12 Millionen') };
    const rows = buildVerdictRows({ articleId: 'parity', bodies, source: source(htmlToText(SOURCE_HTML)) });
    const de = rows.find((row) => row.locale === 'de');
    expect(de?.verdict).toBe('confirmed_defect');
    expect(de?.evidence.missingFigures).toEqual(['locale:120 milioni']);
    expect(de?.evidence.localeVerified).toBe(true);
    expect(rows.filter((row) => row.locale !== 'de').every((row) => row.verdict === 'supported')).toBe(true);
    const verdict = validateEditorialFactualityLedger(rows.map((row) => JSON.stringify(row)).join('\n'));
    expect(verdict.invalidRecords).toEqual([]);
  });

  it('emits nothing without figures, without a download or without the Italian body', () => {
    const noFigures = { ...BODIES, it: IT_BODY.replace('- Importo: 120 milioni di franchi\n', '') };
    expect(buildVerdictRows({ articleId: 'x', bodies: noFigures, source: source('120 Mio.') })).toEqual([]);
    expect(buildVerdictRows({ articleId: 'x', bodies: BODIES, source: { ...source('120 Mio.'), httpStatus: 404 } })).toEqual([]);
    expect(buildVerdictRows({ articleId: 'x', bodies: { ...BODIES, it: '' }, source: source('120 Mio.') })).toEqual([]);
  });

  it('skips a missing translation instead of writing a row for it', () => {
    const rows = buildVerdictRows({ articleId: 'x', bodies: { ...BODIES, fr: null }, source: source('120 Mio.') });
    expect(rows.map((row) => row.locale)).toEqual(['it', 'en', 'de']);
  });
});
