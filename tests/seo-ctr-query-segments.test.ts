import { describe, it, expect } from 'vitest';
import {
  classifyCtrQuery,
  segmentPrefilterRegex,
  segmentFamilyRows,
  excludedSegmentsForState,
  renderExcludedSegmentsSection,
  describeMeasureChange,
  ctrMeasureVersion,
  ctrMeasureVersionFor,
  CTR_MEASURE_VERSION,
  fetchSegmentedFamilyRows,
  LEGACY_CTR_MEASURE_VERSION,
  PROMO_TOKENS,
  PHRASE_QUOTES,
  splitQuotedPhrases,
} from '../scripts/lib/seo-ctr-query-segments.mjs';
import {
  aggregateFamilyRows,
  ctrExcludedSegmentsForFamily,
  isJobBoardFamily,
  SEO_CTR_FAMILIES,
} from '../scripts/lib/seo-ctr-curve.mjs';
import { fetchGscPageQueryRows } from '../scripts/lib/perf-sources/gsc.mjs';

// Decisione I5 del 2026-10-05 (caso guida: issue 11198). Fixture anonimizzate:
// «brillex» e' un marchio inventato, i numeri sono di forma, non misure.

const PROMO = [
  'brillex offerta',
  'offerta brillex',
  'brillex sconto occhiali',
  'brillex promo',
  'brillex coupon',
  'brillex saldi',
  'brillex aperto domenica',
  'brillex orari paese',
  'brillex angebot',
  'brillex öffnungszeiten',
  'brillex gutschein',
  'brillex soldes',
  'brillex horaires',
  'brillex code promo',
  'brillex discount',
  'brillex opening hours',
];

const OPERATORS = [
  'brillex -site:brillex.ch',
  'lavoro ticino site:example.ch',
  'inurl:cerca-lavoro brillex',
  'intitle:"offerte di lavoro" ticino',
  '"brillex" -site:brillex.ch',
  '"lavoro ticino" -indeed',
  'allinurl:lavoro svizzera',
  'filetype:pdf stipendi ticino',
  // frase quotata + operatore fuori dalle virgolette, anche tipografiche
  '"brillex" OR "lavoro"',
  '"lavoro" AND ticino',
  '"lavoro" | ticino',
  '\u201Clavoro ticino\u201D -indeed',
  '\u201Estellen tessin\u201C OR jobs',
  'intitle:\u201Cofferte di lavoro\u201D ticino',
  // un operatore dentro le virgolette e uno fuori: decide quello fuori
  '"lavoro OR frontaliere" -indeed',
  '"lavoro -site:example.ch" inurl:jobs',
];

const JOB = [
  'brillex lavoro',
  'offerte di lavoro brillex',
  'brillex stellenangebote',
  'brillex offre d\'emploi',
  'brillex jobs',
  'brillex careers',
  'brillex offerta part time',
  'brillex commessa',
  'cerca lavoro svizzera',
  'brillex paese', // solo marchio: nessun segnale affidabile, resta dentro
  '"lavoro in ticino"', // virgolette senza operatori
  'brillex orari di lavoro',
  'brillex aperto assunzioni',
  'pizzaiolo svizzera offerte', // plurale ambiguo: resta dentro
  'je cherche des offres au tessin',
  'offre d\'emploie geneve', // refuso frequente
  'can you show me open roles at brillex switzerland',
  '',
  // operatori DENTRO una frase esatta: testo cercato alla lettera
  '"lavoro OR frontaliere"',
  '"lavoro AND ticino"',
  '"cerco lavoro | ticino"',
  '"brillex -site:brillex.ch"',
  '"site:example.ch lavoro ticino"',
  '\u201Clavoro OR frontaliere\u201D',
  '\u201Earbeit -stelle tessin\u201C',
  '\u201Cinurl:lavoro ticino\u201D',
  // virgoletta rimasta aperta: nel dubbio resta dentro
  '"lavoro ticino -site:example.ch',
];

describe('classifyCtrQuery', () => {
  it.each(PROMO)('promozionale senza parole di lavoro: %s', (q) => {
    expect(classifyCtrQuery(q)).toBe('promo');
  });

  it.each(OPERATORS)('query con operatori di ricerca: %s', (q) => {
    expect(classifyCtrQuery(q)).toBe('operator');
  });

  it.each(JOB)('intento di lavoro (o non classificabile) resta dentro: %s', (q) => {
    expect(classifyCtrQuery(q)).toBe('job');
  });

  it('una parola che contiene un token promozionale non e\' quel token', () => {
    // «stellenangebote» contiene «angebote», «offertissima» contiene
    // «offerta»: i token si confrontano interi, non come sottostringhe.
    expect(classifyCtrQuery('brillex stellenangebote')).toBe('job');
    expect(classifyCtrQuery('brillex offertissima')).toBe('job');
    expect(classifyCtrQuery('promozione interna brillex')).toBe('promo');
  });

  it('un OR dentro una frase esatta non e\' un operatore (finding della review sulla PR 11661)', () => {
    expect(classifyCtrQuery('"lavoro OR frontaliere"')).toBe('job');
    expect(classifyCtrQuery('"lavoro OR frontaliere" -indeed')).toBe('operator');
  });
});

describe('splitQuotedPhrases', () => {
  it('separa le frasi chiuse dal testo fuori, con virgolette dritte e tipografiche', () => {
    expect(splitQuotedPhrases('"a OR b" -c')).toEqual({ outside: '\uFFFC -c', phrases: ['a OR b'] });
    expect(splitQuotedPhrases('\u201Ea b\u201C site:x')).toEqual({ outside: '\uFFFC site:x', phrases: ['a b'] });
    expect(splitQuotedPhrases('\u201Ca\u201D OR \u201Cb\u201D').phrases).toEqual(['a', 'b']);
  });

  it('una virgoletta aperta nasconde il resto ma non conta come frase', () => {
    expect(splitQuotedPhrases('x "y -site:z')).toEqual({ outside: 'x ', phrases: [] });
  });

  it('ogni virgoletta riconosciuta passa il prefiltro degli operatori', () => {
    const re = new RegExp(segmentPrefilterRegex(['operator']).replace(/^\(\?i\)/, ''), 'iu');
    for (const quote of PHRASE_QUOTES) expect(re.test(`${quote}x${quote} -y`)).toBe(true);
  });
});

describe('segmentPrefilterRegex — soprainsieme del classificatore', () => {
  // La Search Console vuole RE2 con `(?i)` in testa; JS no.
  const re = new RegExp(segmentPrefilterRegex().replace(/^\(\?i\)/, ''), 'iu');

  it.each([...PROMO, ...OPERATORS])('lascia passare ogni query esclusa: %s', (q) => {
    expect(re.test(q)).toBe(true);
  });

  it('contiene ogni token promozionale', () => {
    for (const token of PROMO_TOKENS) expect(re.test(`x ${token} y`)).toBe(true);
  });

  it('dichiara il case-insensitive per RE2', () => {
    expect(segmentPrefilterRegex().startsWith('(?i)')).toBe(true);
  });
});

describe('segmentFamilyRows', () => {
  const pageRows = [
    // pagina guida: quasi solo query promozionali, CTR 0 a posizione 3,8
    { path: '/cerca-lavoro-svizzera/ricerca-brillex-paese/', clicks: 4, impressions: 1000, ctr: 0.004, position: 3.8 },
    // pagina minore: molte impressioni da query con operatori
    { path: '/cerca-lavoro-svizzera/ricerca-magazziniere/', clicks: 6, impressions: 400, ctr: 0.015, position: 9 },
    // pagina senza query escluse: non cambia
    { path: '/cerca-lavoro-svizzera/', clicks: 50, impressions: 1000, ctr: 0.05, position: 5 },
  ];
  const queryRows = [
    { path: '/cerca-lavoro-svizzera/ricerca-brillex-paese/', query: 'brillex offerta', clicks: 0, impressions: 700, position: 3.5 },
    { path: '/cerca-lavoro-svizzera/ricerca-brillex-paese/', query: 'offerta brillex', clicks: 0, impressions: 200, position: 4 },
    // passa il prefiltro («offerte») ma e' una query di lavoro: resta dentro
    { path: '/cerca-lavoro-svizzera/ricerca-brillex-paese/', query: 'offerte di lavoro brillex', clicks: 2, impressions: 60, position: 5 },
    { path: '/cerca-lavoro-svizzera/ricerca-magazziniere/', query: 'magazziniere -site:example.ch', clicks: 0, impressions: 300, position: 9 },
  ];

  const seg = segmentFamilyRows(pageRows, queryRows);

  it('toglie dai totali di pagina solo i segmenti esclusi', () => {
    const brand = seg.rows.find((r) => r.path.includes('brillex'));
    expect(brand.impressions).toBe(100);
    expect(brand.clicks).toBe(4);
    expect(brand.ctr).toBeCloseTo(0.04, 6);
    // posizione ponderata delle sole impressioni rimaste: (3,8×1000 − 3,5×700 − 4×200) / 100
    expect(brand.position).toBeCloseTo((3.8 * 1000 - 3.5 * 700 - 4 * 200) / 100, 6);
    const minor = seg.rows.find((r) => r.path.includes('magazziniere'));
    expect(minor.impressions).toBe(100);
    expect(minor.clicks).toBe(6);
    const hub = seg.rows.find((r) => r.path === '/cerca-lavoro-svizzera/');
    expect(hub).toEqual(pageRows[2]);
  });

  it('riporta i segmenti esclusi con impressioni, click e query principali', () => {
    expect(seg.segments.promo.impressions).toBe(900);
    expect(seg.segments.promo.clicks).toBe(0);
    expect(seg.segments.promo.topQueries[0]).toEqual({ query: 'brillex offerta', impressions: 700, clicks: 0 });
    expect(seg.segments.operator.impressions).toBe(300);
    expect(seg.segments.operator.topQueries.map((q) => q.query)).toEqual(['magazziniere -site:example.ch']);
  });

  it('conserva la misura precedente (tutte le query) per il confronto', () => {
    const total = pageRows.reduce((sum, r) => sum + r.impressions, 0);
    const clicks = pageRows.reduce((sum, r) => sum + r.clicks, 0);
    expect(seg.allQueries.impressions).toBe(total);
    expect(seg.allQueries.ctr).toBeCloseTo(clicks / total, 6);
  });

  it('niente sparisce: principale + esclusi = tutte le query', () => {
    const main = seg.rows.reduce((sum, r) => sum + r.impressions, 0);
    expect(main + seg.segments.promo.impressions + seg.segments.operator.impressions).toBe(seg.allQueries.impressions);
  });

  it('la pagina guida non e\' piu\' sotto curva per colpa delle query promozionali', () => {
    const before = aggregateFamilyRows(pageRows, { minImpressions: 5 });
    const after = aggregateFamilyRows(seg.rows, { minImpressions: 5 });
    expect(before.belowCurvePages.map((p) => p.path)).toContain('/cerca-lavoro-svizzera/ricerca-brillex-paese/');
    expect(after.belowCurvePages.map((p) => p.path)).not.toContain('/cerca-lavoro-svizzera/ricerca-brillex-paese/');
  });

  it('una pagina tutta esclusa ha zero impressioni e CTR nulla, non NaN', () => {
    const only = segmentFamilyRows(
      [{ path: '/p/', clicks: 0, impressions: 50, ctr: 0, position: 2 }],
      [{ path: '/p/', query: 'brillex offerta', clicks: 0, impressions: 50, position: 2 }],
    );
    expect(only.rows[0]).toMatchObject({ impressions: 0, clicks: 0, ctr: null, position: null });
  });
});

describe('report e state dei segmenti esclusi', () => {
  const seg = segmentFamilyRows(
    [{ path: '/p/', clicks: 1, impressions: 100, ctr: 0.01, position: 4 }],
    [{ path: '/p/', query: 'brillex | offerta `x`', clicks: 0, impressions: 40, position: 4 }],
  );

  it('la sezione della issue elenca entrambi i segmenti e la misura precedente', () => {
    const md = renderExcludedSegmentsSection(seg);
    expect(md).toContain('### Query escluse dalla metrica principale');
    expect(md).toContain(CTR_MEASURE_VERSION);
    expect(md).toContain('Query con operatori di ricerca');
    expect(md).toContain('Query promozionali');
    expect(md).toContain('Tutte le query (misura precedente)');
    // una query con `|` o backtick non rompe la tabella
    expect(md).not.toMatch(/`brillex \|/);
  });

  it('lo state file porta impressioni, click e le prime query di ogni segmento', () => {
    const state = excludedSegmentsForState(seg.segments);
    expect(Object.keys(state)).toEqual(['operator', 'promo']);
    expect(state.promo.impressions).toBe(40);
    expect(state.operator).toEqual({ impressions: 0, clicks: 0, ctr: null, topQueries: [] });
  });
});

describe('versione della misura (sul modello di predicateVersion)', () => {
  it('e\' un\'impronta stabile e distinta dalla misura precedente', () => {
    expect(CTR_MEASURE_VERSION).toMatch(/^query-segmented-[0-9a-f]{12}$/);
    expect(ctrMeasureVersion()).toBe(CTR_MEASURE_VERSION);
    expect(CTR_MEASURE_VERSION).not.toBe(LEGACY_CTR_MEASURE_VERSION);
  });

  it('la versione di famiglia dichiara i segmenti applicati', () => {
    expect(ctrMeasureVersionFor(['promo', 'operator'])).toBe(`${CTR_MEASURE_VERSION}:operator+promo`);
    expect(ctrMeasureVersionFor(['operator'])).toBe(`${CTR_MEASURE_VERSION}:operator`);
    expect(ctrMeasureVersionFor(['operator'])).not.toBe(ctrMeasureVersionFor(['operator', 'promo']));
  });

  it('dichiara il cambio di misura rispetto a uno stato senza versione', () => {
    const line = describeMeasureChange({ lastCtr: 0.018 }, { allQueriesCtr: 0.017 });
    expect(line).toContain(LEGACY_CTR_MEASURE_VERSION);
    expect(line).toContain(CTR_MEASURE_VERSION);
    expect(line).toContain('non sono confrontabili');
  });

  it('tace quando la misura e\' la stessa', () => {
    const version = ctrMeasureVersionFor(['operator', 'promo']);
    expect(describeMeasureChange({ measureVersion: version, lastCtr: 0.02 }, { measureVersion: version })).toBeNull();
    // stessa impronta, segmenti diversi: e' un cambio di misura
    expect(describeMeasureChange({ measureVersion: ctrMeasureVersionFor(['operator']) }, { measureVersion: version })).not.toBeNull();
  });
});

describe('fetchGscPageQueryRows', () => {
  it('mette filtro di pagina e prefiltro query nello stesso gruppo (AND), una richiesta per alias', async () => {
    const bodies: any[] = [];
    const fetchImpl = async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        json: async () => ({
          rows: [{ keys: ['https://frontaliereticino.ch/cerca-lavoro-svizzera/x/', 'brillex offerta'], clicks: 0, impressions: 9, ctr: 0, position: 3 }],
        }),
      };
    };
    const { rows } = await fetchGscPageQueryRows({
      windowDays: 14,
      pathContains: ['/cerca-lavoro-svizzera/', '/jobs-in-schweiz/'],
      queryRegex: segmentPrefilterRegex(),
      fetchImpl: fetchImpl as any,
      getTokenImpl: async () => 'token',
    });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.dimensions).toEqual(['page', 'query']);
      expect(body.dimensionFilterGroups).toHaveLength(1);
      expect(body.dimensionFilterGroups[0].filters.map((f: any) => f.dimension)).toEqual(['page', 'query']);
      expect(body.dimensionFilterGroups[0].filters[1].operator).toBe('includingRegex');
    }
    expect(rows[0]).toMatchObject({ path: '/cerca-lavoro-svizzera/x/', query: 'brillex offerta', impressions: 9 });
  });
});

describe('fetchSegmentedFamilyRows — un solo percorso per monitor e baseline', () => {
  it('passa alias e prefiltro alle due letture e restituisce le righe segmentate', async () => {
    const calls: any[] = [];
    const out = await fetchSegmentedFamilyRows({
      windowDays: 14,
      pathContains: ['/a/', '/b/'],
      fetchByPage: async (args: any) => {
        calls.push(['page', args]);
        return { rows: 1, perPath: new Map([['/a/x/', { clicks: 1, impressions: 50, ctr: 0.02, position: 4 }]]) };
      },
      fetchPageQuery: async (args: any) => {
        calls.push(['query', args]);
        return { rows: [{ path: '/a/x/', query: 'brillex offerta', clicks: 0, impressions: 30, position: 4 }] };
      },
    });
    expect(calls.map(([kind]) => kind)).toEqual(['page', 'query']);
    expect(calls[1][1]).toEqual({ windowDays: 14, pathContains: ['/a/', '/b/'], queryRegex: segmentPrefilterRegex() });
    expect(out.rawRowCount).toBe(1);
    expect(out.pageRows[0].impressions).toBe(50);
    expect(out.rows[0].impressions).toBe(20);
    expect(out.segments.promo.impressions).toBe(30);
  });
});

describe('segmento promo solo sulle famiglie di ricerca lavoro', () => {
  const byId = (id: string) => SEO_CTR_FAMILIES.find((f: any) => f.id === id);

  it('le famiglie job board escludono operatori e promo, le altre solo operatori', () => {
    // caso guida della issue 11198
    expect(ctrExcludedSegmentsForFamily(byId('cerca-lavoro-svizzera'))).toEqual(['operator', 'promo']);
    expect(ctrExcludedSegmentsForFamily(byId('cerca-lavoro-ticino'))).toEqual(['operator', 'promo']);
    // su una guida «dogana … orari» e' l'intento della pagina
    expect(ctrExcludedSegmentsForFamily(byId('guida-frontaliere'))).toEqual(['operator']);
    expect(ctrExcludedSegmentsForFamily(byId('articoli-frontaliere'))).toEqual(['operator']);
  });

  it('riconosce una famiglia job board anche solo da un alias di locale', () => {
    expect(isJobBoardFamily({ pathContains: '/qualcosa/', pathAliases: ['/jobs-in-schweiz/'] })).toBe(true);
    expect(isJobBoardFamily({ pathContains: '/eventi/' })).toBe(false);
  });

  it('con il solo segmento operatori le query promozionali restano nella metrica principale', () => {
    const seg = segmentFamilyRows(
      [{ path: '/g/', clicks: 5, impressions: 100, ctr: 0.05, position: 4 }],
      [
        { path: '/g/', query: 'dogana brillex orari', clicks: 2, impressions: 30, position: 4 },
        { path: '/g/', query: 'site:example.ch', clicks: 0, impressions: 10, position: 4 },
      ],
      { segments: ['operator'] },
    );
    expect(seg.rows[0].impressions).toBe(90);
    expect(Object.keys(seg.segments)).toEqual(['operator']);
    expect(seg.measureVersion).toBe(ctrMeasureVersionFor(['operator']));
    expect(renderExcludedSegmentsSection(seg)).toContain('non applicato a questa famiglia');
    expect(Object.keys(excludedSegmentsForState(seg.segments))).toEqual(['operator']);
  });

  it('il prefiltro dei soli operatori non scarica le query promozionali', () => {
    const re = new RegExp(segmentPrefilterRegex(['operator']).replace(/^\(\?i\)/, ''), 'iu');
    expect(re.test('brillex offerta')).toBe(false);
    expect(re.test('brillex -site:example.ch')).toBe(true);
  });

  it('«tutte le query» usa lo stesso floor di impressioni dell\'aggregato', () => {
    const seg = segmentFamilyRows(
      [
        { path: '/a/', clicks: 1, impressions: 100, ctr: 0.01, position: 4 },
        { path: '/b/', clicks: 3, impressions: 3, ctr: 1, position: 1 },
      ],
      [],
      { minImpressions: 5 },
    );
    expect(seg.allQueries).toEqual({ impressions: 100, clicks: 1, ctr: 0.01 });
    expect(seg.allQueries.ctr).toBe(aggregateFamilyRows(seg.rows, { minImpressions: 5 }).avgCtr);
  });
});
