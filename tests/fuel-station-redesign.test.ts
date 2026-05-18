/**
 * Per-station SEO page redesign — regression tests for the 2026-05-18 layout.
 *
 * We test the public surface (`generateFuelStationPages`) with a minimal
 * synthetic dataset, then assert the emitted HTML carries every above-the-fold
 * affordance the redesign introduces. This keeps the tests resilient to
 * helper-function refactors as long as the rendered output remains correct.
 */

import { describe, expect, it } from 'vitest';
import { generateFuelStationPages } from '../build-plugins/fuelDailyPagesPlugin';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { buildStationSlug as _buildStationSlugJsRaw } from '../scripts/lib/fuel-station-slug.mjs';
import { buildStationSlug as buildStationSlugTs } from '../build-plugins/fuelDailyData';

// `.mjs` has no `.d.ts` companion, so TS infers strict-required object props.
// At runtime the JS twin accepts undefined/null/missing fields exactly like
// the TS version — wrap it in a typed pass-through so the parity test can
// share a single fixture type with the TS function.
const buildStationSlugJs: typeof buildStationSlugTs = (opts) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (_buildStationSlugJsRaw as unknown as (o: unknown) => string)(opts as any);

const TODAY = new Date('2026-05-18T06:00:00Z');

interface SyntheticStation {
  id: string;
  brand: string;
  name: string;
  address: string;
  sp95PriceChf: number;
  dieselPriceChf?: number;
  lat?: number;
  lng?: number;
  updatedAt?: string;
}

function buildDataset(stations: SyntheticStation[]) {
  return {
    generatedAt: TODAY.toISOString(),
    municipalities: [
      {
        municipality: 'Como',
        province: 'CO',
        swiss: {
          nearbyStations: stations,
        },
      },
    ],
  };
}

/** Three Chiasso stations spanning cheaper/median/premium so we get rank + delta variance. */
const STATIONS: SyntheticStation[] = [
  {
    id: '1',
    brand: 'Migrol',
    name: 'Migrol Chiasso',
    address: 'Via Cantonale 5, 6830 Chiasso',
    sp95PriceChf: 1.85,
    dieselPriceChf: 1.95,
    lat: 45.836,
    lng: 9.033,
    updatedAt: '2026-05-18',
  },
  {
    id: '2',
    brand: 'Silo',
    name: 'Silo Via Emilio Bossi',
    address: 'Via Emilio Bossi 19, 6830 Chiasso',
    sp95PriceChf: 1.9,
    dieselPriceChf: 2.0,
    lat: 45.8349,
    lng: 9.0311,
    updatedAt: '2026-05-18',
  },
  {
    id: '3',
    brand: 'Esso',
    name: 'Esso Chiasso',
    address: 'Via Vela 10, 6830 Chiasso',
    sp95PriceChf: 1.95,
    dieselPriceChf: 2.1,
    lat: 45.838,
    lng: 9.029,
    updatedAt: '2026-05-18',
  },
];

function render() {
  return generateFuelStationPages({
    dataset: buildDataset(STATIONS),
    today: TODAY,
    history: [],
    // Pass rootDir so resolveBrandLogoUrl can find public/images/brands/{slug}.svg
    rootDir: process.cwd(),
  });
}

describe('Per-station page redesign — hero', () => {
  it('emits an above-the-fold hero card with brand name, price, and CHF/Diesel currency label', () => {
    const pages = render();
    const path = '/prezzi-diesel/chiasso/stazioni/migrol-via-cantonale/';
    expect(pages[path]).toBeDefined();
    const html = pages[path];
    expect(html).toContain('aria-label="Migrol Chiasso"');
    expect(html).toMatch(/font-size:clamp\(2\.2rem,6vw,3rem\);font-weight:800[^>]*>1,950</);
    expect(html).toContain('CHF/litro · Diesel');
  });

  it('places the rank chip BEFORE long editorial prose (mobile-first ordering)', () => {
    const pages = render();
    const html = pages['/prezzi-diesel/chiasso/stazioni/silo-via-emilio-bossi/'];
    // Hero card aria-label format is "{brand} {city}"
    const idxHero = html.indexOf('aria-label="Silo Chiasso"');
    const idxAdvice = html.indexOf('data-station-advice');
    const idxLocation = html.indexOf('aria-labelledby="stationLocation"');
    const idxReview = html.indexOf('aria-labelledby="stationReview"');
    expect(idxHero).toBeGreaterThan(0);
    expect(idxAdvice).toBeGreaterThan(idxHero);
    expect(idxLocation).toBeGreaterThan(idxAdvice);
    expect(idxReview).toBeGreaterThan(idxLocation);
  });

  it('renders the rank chip with a link back to the zone classifica', () => {
    const pages = render();
    const html = pages['/prezzi-diesel/chiasso/stazioni/migrol-via-cantonale/'];
    // Rank chip: <a href=".../prezzi-diesel/chiasso/oggi/" ...>…1° su 3 a Chiasso…</a>
    // The href appears MANY times in the page (breadcrumbs, related, back-link),
    // so we match the rank-text specifically and check it sits inside an <a> with
    // the classifica href anywhere within the surrounding ~600 chars.
    expect(html).toContain('1° su 3 a Chiasso');
    const rankIdx = html.indexOf('1° su 3 a Chiasso');
    // ~800 chars to clear the inline lucide SVG markup between href and rank label.
    const window = html.slice(Math.max(0, rankIdx - 1200), rankIdx);
    expect(window).toMatch(/href="https:\/\/frontaliereticino\.ch\/prezzi-diesel\/chiasso\/oggi\/"/);
  });

  it('uses lucide SVG icons (no emoji) for trophy/map-pin/navigation/bar-chart in the hero', () => {
    const pages = render();
    const html = pages['/prezzi-diesel/chiasso/stazioni/migrol-via-cantonale/'];
    // Lucide trophy SVG signature path
    expect(html).toContain('<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/>');
    // Lucide navigation/triangle polygon
    expect(html).toContain('<polygon points="3 11 22 2 13 21 11 13 3 11"/>');
    // Lucide bar-chart-3 signature
    expect(html).toContain('<path d="M3 3v18h18"/>');
    // No raw emoji should remain in the hero area
    const heroChunk = html.slice(html.indexOf('aria-label="Migrol'), html.indexOf('data-station-advice'));
    expect(heroChunk).not.toMatch(/🏆|📍|🚗|📊|📌|🧭/);
  });
});

describe('Per-station page redesign — brand logo', () => {
  it('uses /images/brands/{slug}.svg when a real logo exists for the brand', () => {
    const pages = render();
    const html = pages['/prezzi-diesel/chiasso/stazioni/migrol-via-cantonale/'];
    expect(html).toContain('src="/images/brands/migrol.svg"');
    expect(html).toContain('alt="Migrol"');
  });

  it('falls back to a monogram chip when no brand SVG is on disk (Silo)', () => {
    const pages = render();
    const html = pages['/prezzi-diesel/chiasso/stazioni/silo-via-emilio-bossi/'];
    // Silo has no logo file — monogram chip with first letter "S"
    expect(html).not.toContain('src="/images/brands/silo.svg"');
    expect(html).toMatch(/border-radius:14px;background:var\(--color-accent-subtle\)[^>]*flex-shrink:0">S</);
  });
});

describe('Per-station page redesign — advice banner', () => {
  it('renders a SUCCESS-tone advice when the station beats the zone average', () => {
    const pages = render();
    // Migrol diesel 1.95 vs zone avg ((1.95+2.0+2.1)/3) = 2.017 → -0.067 → success
    const html = pages['/prezzi-diesel/chiasso/stazioni/migrol-via-cantonale/'];
    expect(html).toContain('data-station-advice');
    expect(html).toMatch(/data-station-advice[^>]*background:var\(--color-success-subtle\)/);
    expect(html).toMatch(/Buona scelta/);
    // No double "CHF CHF"
    expect(html).not.toMatch(/CHF CHF\/litro/);
  });

  it('renders a DANGER-tone advice when the station is more expensive than the zone average', () => {
    const pages = render();
    // Esso diesel 2.10 vs avg 2.017 → +0.083 → danger
    const html = pages['/prezzi-diesel/chiasso/stazioni/esso-via-vela/'];
    expect(html).toMatch(/data-station-advice[^>]*background:var\(--color-danger-subtle\)/);
    expect(html).toMatch(/Attenzione/);
  });
});

describe('Per-station page redesign — location card', () => {
  it('embeds a lazy OpenStreetMap iframe with bbox + marker derived from the station coords', () => {
    const pages = render();
    const html = pages['/prezzi-diesel/chiasso/stazioni/migrol-via-cantonale/'];
    expect(html).toContain('<iframe');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('openstreetmap.org/export/embed.html');
    expect(html).toMatch(/marker=45\.836000%2C9\.033000/);
    expect(html).toMatch(/bbox=9\.02700%2C45\.83000%2C9\.03900%2C45\.84200/);
  });

  it('renders Google Maps + Waze action links with the canonical URL schemes', () => {
    const pages = render();
    const html = pages['/prezzi-diesel/chiasso/stazioni/migrol-via-cantonale/'];
    expect(html).toContain('https://www.google.com/maps/search/?api=1&amp;query=45.836000,9.033000');
    expect(html).toContain('https://www.waze.com/ul?ll=45.836000%2C9.033000&amp;navigate=yes');
  });

  it('omits the location card entirely when the station has no lat/lng', () => {
    const noGeo: SyntheticStation = {
      ...STATIONS[0],
      id: '999',
      address: 'Via Test 1, 6830 Chiasso',
      brand: 'TestBrand',
      name: 'TestBrand Test',
      lat: undefined,
      lng: undefined,
    };
    const pages = generateFuelStationPages({
      dataset: buildDataset([...STATIONS, noGeo]),
      today: TODAY,
      history: [],
    });
    const html = pages['/prezzi-diesel/chiasso/stazioni/testbrand-via-test/'];
    expect(html).toBeDefined();
    expect(html).not.toContain('aria-labelledby="stationLocation"');
    expect(html).not.toContain('openstreetmap.org/export');
  });
});

describe('Per-station page redesign — history chart', () => {
  it('omits the chart card when no history snapshots are provided', () => {
    const pages = generateFuelStationPages({
      dataset: buildDataset(STATIONS),
      today: TODAY,
      history: [],
    });
    const html = pages['/prezzi-diesel/chiasso/stazioni/migrol-via-cantonale/'];
    expect(html).not.toContain('aria-labelledby="stationHistory"');
  });

  it('falls back to the zone chart with disclaimer when station-level history is sparse', () => {
    // 3 snapshots, zone averages only (no `stations` field) → zone fallback.
    const history = [
      { date: '2026-05-15', zones: { chiasso: { diesel: 2.05, benzina: 1.88 }, mendrisio: {}, lugano: {}, bellinzona: {}, locarno: {} } } as never,
      { date: '2026-05-16', zones: { chiasso: { diesel: 2.04, benzina: 1.88 }, mendrisio: {}, lugano: {}, bellinzona: {}, locarno: {} } } as never,
      { date: '2026-05-17', zones: { chiasso: { diesel: 2.03, benzina: 1.88 }, mendrisio: {}, lugano: {}, bellinzona: {}, locarno: {} } } as never,
    ];
    const pages = generateFuelStationPages({
      dataset: buildDataset(STATIONS),
      today: TODAY,
      history,
    });
    const html = pages['/prezzi-diesel/chiasso/stazioni/migrol-via-cantonale/'];
    expect(html).toContain('aria-labelledby="stationHistory"');
    expect(html).toContain('Andamento prezzo nella zona Chiasso');
    expect(html).toMatch(/non ancora disponibile/);
  });

  it('renders the per-station chart when ≥3 snapshots carry station-level prices', () => {
    const slug = 'migrol-via-cantonale';
    const history = [
      { date: '2026-05-15', zones: { chiasso: { diesel: 2.05 }, mendrisio: {}, lugano: {}, bellinzona: {}, locarno: {} }, stations: { [slug]: { diesel: 1.92, benzina: 1.83 } } } as never,
      { date: '2026-05-16', zones: { chiasso: { diesel: 2.04 }, mendrisio: {}, lugano: {}, bellinzona: {}, locarno: {} }, stations: { [slug]: { diesel: 1.94, benzina: 1.84 } } } as never,
      { date: '2026-05-17', zones: { chiasso: { diesel: 2.03 }, mendrisio: {}, lugano: {}, bellinzona: {}, locarno: {} }, stations: { [slug]: { diesel: 1.95, benzina: 1.85 } } } as never,
    ];
    const pages = generateFuelStationPages({
      dataset: buildDataset(STATIONS),
      today: TODAY,
      history,
    });
    const html = pages[`/prezzi-diesel/chiasso/stazioni/${slug}/`];
    expect(html).toContain('Andamento prezzo di Migrol');
    expect(html).not.toMatch(/non ancora disponibile/);
  });
});

describe('Per-station slug parity — TS plugin vs JS snapshot writer', () => {
  // Two implementations exist (TS in build-plugins, JS in scripts/lib) because
  // .mjs scripts cannot import .ts files. They MUST agree byte-for-byte or
  // snapshots and renderer-side lookups will drift and silently fall back to
  // the zone chart for every page.
  const FIXTURES: Array<{ brand?: string | null; name?: string | null; address?: string | null }> = [
    { brand: 'Migrol', name: 'Migrol Chiasso', address: 'Via Cantonale 5, 6830 Chiasso' },
    { brand: 'Coop Pronto', name: 'Coop Pronto', address: 'Viale Cassarate 17A, 6900 Lugano' },
    { brand: 'BP', name: 'BP', address: 'Via del Breggia 1, 6830 Chiasso' },
    { brand: 'UNDEFINED', name: 'Silo Via Emilio Bossi', address: 'Via Emilio Bossi 19, 6830 Chiasso' },
    { brand: '', name: 'Esso Mendrisio', address: 'Strada Cantonale 3' },
    { brand: 'Eni', name: '', address: "Via D'Annunzio 4, 6900 Lugano" },
    { brand: 'Tamoil', name: 'Tamoil 24h', address: 'Via Passeggiata 2' },
    { brand: null, name: null, address: null },
  ];

  it.each(FIXTURES)('produces identical slugs for %o', (fx) => {
    const ts = buildStationSlugTs(fx);
    const js = buildStationSlugJs(fx);
    expect(js).toBe(ts);
  });
});
