/**
 * Per-station SEO page parity — Italian side.
 *
 * Mirrors tests/fuel-station-redesign.test.ts (Swiss) but exercises
 * `generateFuelItalianStationPages`. Validates that every above-the-fold
 * affordance shipped on the Swiss path also appears on the IT path:
 * hero card, advice banner, OSM map iframe, Google Maps + Waze, OSM
 * fallback link, lucide SVG icons, last-updated timestamp, brand logo.
 *
 * Synthetic dataset — keeps tests fast and deterministic.
 */

import { describe, expect, it } from 'vitest';
import { generateFuelItalianStationPages } from '../build-plugins/fuelDailyPagesPlugin';

const TODAY = new Date('2026-05-18T06:00:00Z');

interface SyntheticItalianStation {
  id: string;
  brand: string;
  stationName: string;
  address: string;
  priceEur: number;
  isSelf?: boolean;
  lat?: number;
  lng?: number;
}

function buildDataset(stations: SyntheticItalianStation[]) {
  return {
    generatedAt: TODAY.toISOString(),
    municipalities: [
      {
        municipality: 'Como',
        province: 'CO',
        italy: {
          stations: stations.map((s) => ({
            id: s.id,
            brand: s.brand,
            stationName: s.stationName,
            address: s.address,
            priceEur: s.priceEur,
            isSelf: s.isSelf ?? true,
            lat: s.lat,
            lng: s.lng,
          })),
        },
        swiss: { nearbyStations: [] },
      },
    ],
  };
}

const STATIONS: SyntheticItalianStation[] = [
  {
    id: '1',
    brand: 'Carrefour',
    stationName: 'Carrefour Como',
    address: 'Via Cristoforo Colombo 10, 22100 Como',
    priceEur: 1.65,
    lat: 45.81,
    lng: 9.083,
    isSelf: true,
  },
  {
    id: '2',
    brand: 'Esso',
    stationName: 'Esso Como',
    address: 'Via Milano 5, 22100 Como',
    priceEur: 1.7,
    lat: 45.811,
    lng: 9.081,
    isSelf: true,
  },
  {
    id: '3',
    brand: 'IndieBrand',
    stationName: 'IndieBrand',
    address: 'Via Roma 1, 22100 Como',
    priceEur: 1.78,
    lat: 45.812,
    lng: 9.085,
    isSelf: false,
  },
];

function render() {
  return generateFuelItalianStationPages({
    dataset: buildDataset(STATIONS),
    today: TODAY,
    history: [],
    rootDir: process.cwd(),
  });
}

describe('IT per-station page — hero', () => {
  it('emits an above-the-fold hero card with brand name, EUR price, and fuel label', () => {
    const pages = render();
    const path = '/prezzi-benzina/italia/como/stazioni/carrefour-via-cristoforo-colombo/';
    expect(pages[path]).toBeDefined();
    const html = pages[path];
    expect(html).toContain('aria-label="Carrefour Como"');
    expect(html).toMatch(/font-size:clamp\(2\.2rem,6vw,3rem\);font-weight:800[^>]*>1,650</);
    expect(html).toContain('EUR/litro · Benzina');
  });

  it('places hero BEFORE long prose (mobile-first ordering)', () => {
    const pages = render();
    const html = pages['/prezzi-benzina/italia/como/stazioni/carrefour-via-cristoforo-colombo/'];
    const idxHero = html.indexOf('aria-label="Carrefour Como"');
    const idxAdvice = html.indexOf('data-station-advice');
    const idxLocation = html.indexOf('aria-labelledby="stationLocation"');
    const idxInfo = html.indexOf('aria-labelledby="itStationInfo"');
    const idxContext = html.indexOf('aria-labelledby="itStationContext"');
    expect(idxHero).toBeGreaterThan(0);
    expect(idxAdvice).toBeGreaterThan(idxHero);
    expect(idxLocation).toBeGreaterThan(idxAdvice);
    expect(idxInfo).toBeGreaterThan(idxLocation);
    expect(idxContext).toBeGreaterThan(idxInfo);
  });

  it('uses the SAME lucide SVG icons as the Swiss path (no emoji)', () => {
    const pages = render();
    const html = pages['/prezzi-benzina/italia/como/stazioni/carrefour-via-cristoforo-colombo/'];
    expect(html).toContain('<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/>'); // trophy
    expect(html).toContain('<polygon points="3 11 22 2 13 21 11 13 3 11"/>'); // navigation
    expect(html).toContain('<path d="M3 3v18h18"/>'); // bar-chart
    const heroChunk = html.slice(html.indexOf('aria-label="Carrefour Como"'), html.indexOf('data-station-advice'));
    expect(heroChunk).not.toMatch(/🏆|📍|🚗|📊|📌|🧭/);
  });

  it('renders the rank chip with a link back to the city hub', () => {
    const pages = render();
    const html = pages['/prezzi-benzina/italia/como/stazioni/carrefour-via-cristoforo-colombo/'];
    expect(html).toContain('1° su 3 a Como');
    const rankIdx = html.indexOf('1° su 3 a Como');
    const window = html.slice(Math.max(0, rankIdx - 1200), rankIdx);
    expect(window).toMatch(/href="https:\/\/frontaliereticino\.ch\/prezzi-benzina\/italia\/como\/oggi\/"/);
  });
});

describe('IT per-station page — brand logo', () => {
  it('uses /images/brands/{slug}.svg when a real logo exists (Carrefour)', () => {
    const pages = render();
    const html = pages['/prezzi-benzina/italia/como/stazioni/carrefour-via-cristoforo-colombo/'];
    expect(html).toContain('src="/images/brands/carrefour.svg"');
    expect(html).toContain('alt="Carrefour"');
  });

  it('falls back to monogram chip when no brand SVG is on disk', () => {
    const pages = render();
    const html = pages['/prezzi-benzina/italia/como/stazioni/indiebrand-via-roma/'];
    expect(html).not.toContain('src="/images/brands/indiebrand.svg"');
    // Monogram chip uses accent-subtle background + first letter I
    expect(html).toMatch(/border-radius:14px;background:var\(--color-accent-subtle\)[^>]*flex-shrink:0">I</);
  });
});

describe('IT per-station page — advice banner', () => {
  it('renders SUCCESS-tone advice when the station beats the city average (EUR currency)', () => {
    const pages = render();
    // Avg = (1.65 + 1.7 + 1.78) / 3 = 1.71. Carrefour @ 1.65 → -0.06 → success
    const html = pages['/prezzi-benzina/italia/como/stazioni/carrefour-via-cristoforo-colombo/'];
    expect(html).toMatch(/data-station-advice[^>]*background:var\(--color-success-subtle\)/);
    expect(html).toMatch(/Buona scelta.*EUR\/litro più economica della media città Como/);
    // No double EUR EUR
    expect(html).not.toMatch(/EUR EUR\/litro/);
  });

  it('renders DANGER-tone advice when the station is above the city average', () => {
    const pages = render();
    // IndieBrand @ 1.78 vs avg 1.71 → +0.07 → danger
    const html = pages['/prezzi-benzina/italia/como/stazioni/indiebrand-via-roma/'];
    expect(html).toMatch(/data-station-advice[^>]*background:var\(--color-danger-subtle\)/);
    expect(html).toMatch(/Attenzione.*EUR\/litro più cara della media città Como/);
  });
});

describe('IT per-station page — location card', () => {
  it('embeds the same OSM iframe + GMaps + Waze + OSM fallback as the Swiss path', () => {
    const pages = render();
    const html = pages['/prezzi-benzina/italia/como/stazioni/carrefour-via-cristoforo-colombo/'];
    expect(html).toContain('openstreetmap.org/export/embed.html');
    expect(html).toContain('loading="lazy"');
    expect(html).toMatch(/marker=45\.810000%2C9\.083000/);
    expect(html).toContain('https://www.google.com/maps/search/?api=1&amp;query=45.810000,9.083000');
    expect(html).toContain('https://www.waze.com/ul?ll=45.810000%2C9.083000&amp;navigate=yes');
    // OSM text-fallback link
    expect(html).toMatch(/href="https:\/\/www\.openstreetmap\.org\/\?mlat=45\.810000&amp;mlon=9\.083000/);
    // aria-label external-link warning
    expect(html).toMatch(/aria-label="Apri in Google Maps \(apre in una nuova scheda\)"/);
  });

  it('omits the location card when the station has no lat/lng', () => {
    const noGeo: SyntheticItalianStation = {
      id: '999',
      brand: 'NoGeoBrand',
      stationName: 'NoGeoBrand',
      address: 'Via Senza Coord 1, 22100 Como',
      priceEur: 1.72,
      isSelf: true,
    };
    const pages = generateFuelItalianStationPages({
      dataset: buildDataset([...STATIONS, noGeo]),
      today: TODAY,
      history: [],
    });
    const html = pages['/prezzi-benzina/italia/como/stazioni/nogeobrand-via-senza-coord/'];
    expect(html).toBeDefined();
    expect(html).not.toContain('aria-labelledby="stationLocation"');
    expect(html).not.toContain('openstreetmap.org/export');
  });
});

describe('IT per-station page — last-updated timestamp on chart', () => {
  it('appends "Ultimo aggiornamento: YYYY-MM-DD" under the city history card', () => {
    const history = [
      { date: '2026-05-15', zones: {}, italianCities: { como: { benzina: 1.72 } } } as never,
      { date: '2026-05-16', zones: {}, italianCities: { como: { benzina: 1.71 } } } as never,
      { date: '2026-05-17', zones: {}, italianCities: { como: { benzina: 1.7 } } } as never,
    ];
    const pages = generateFuelItalianStationPages({
      dataset: buildDataset(STATIONS),
      today: TODAY,
      history,
      rootDir: process.cwd(),
    });
    const html = pages['/prezzi-benzina/italia/como/stazioni/carrefour-via-cristoforo-colombo/'];
    expect(html).toContain('aria-labelledby="itStationTrend"');
    expect(html).toContain('Ultimo aggiornamento: 2026-05-18');
  });
});
