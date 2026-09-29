import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyVtgWorkplaceAddress,
  assertVtgAdapterParity,
  ensureAdapterSeedUrls,
  fetchVtgJobUrls,
} from '../scripts/update-vtg-jobs.mjs';
import { __testables as sharedCrawlerTestables } from '../scripts/lib/shared-jobs-crawler.mjs';
import { parseFederalJobDetailExtras } from '../scripts/lib/federal-job-detail.mjs';

const readFixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

function job(id: string, city = 'Chur') {
  return {
    links: { directlink: `https://jobs.admin.ch/offene-stellen/test-${id.slice(0, 4)}/${id}` },
    attributes: {
      arbeitsort: [city],
      region: [city === 'Bellinzona' ? 'Tessin' : 'Ostschweiz'],
      verwaltungseinheit: ['Gruppe Verteidigung'],
    },
  };
}

function regionFromUrl(input: string | URL | Request) {
  const url = new URL(String(input));
  return url.searchParams.getAll('f').find((value) => value.startsWith('region:'))?.split(':')[1];
}

describe('VTG authoritative regional discovery', () => {
  it('requires all regions and accounts for expected cross-region identities', async () => {
    const byRegion: Record<string, object[]> = {
      '1083341': [job(IDS[0], 'Bellinzona')],
      '1083334': [job(IDS[1]), job(IDS[2])],
      '1083319': [job(IDS[2])],
    };
    const fetchImpl = async (input: string | URL | Request) => {
      const jobs = byRegion[regionFromUrl(input)!];
      return new Response(JSON.stringify({ total: jobs.length, jobs }), { status: 200 });
    };

    const result = await fetchVtgJobUrls({ fetchImpl, timeoutMs: 1000 });
    expect(result).toMatchObject({ fetched: 4, duplicateIdentity: 1, droppedMalformed: 0, sourceZero: false });
    expect(result.urls).toHaveLength(3);
    expect(Object.keys(result.seedMetaByUrl)).toHaveLength(3);
    expect(result.regionTotals).toEqual({ TI: 1, Ostschweiz1: 2, Ostschweiz2: 1 });
  });

  it('fails closed on a partial region, an unavailable region, or an off-contract URL', async () => {
    const partial = async () => new Response(JSON.stringify({ total: 2, jobs: [job(IDS[0])] }), { status: 200 });
    await expect(fetchVtgJobUrls({ fetchImpl: partial, timeoutMs: 1000 })).rejects.toThrow(/incomplete/);

    const unavailable = async () => new Response('down', { status: 503 });
    await expect(fetchVtgJobUrls({ fetchImpl: unavailable, timeoutMs: 1000 })).rejects.toThrow(/503/);

    const offContract = async () => new Response(JSON.stringify({
      total: 1,
      jobs: [{ ...job(IDS[0]), links: { directlink: `https://example.test/offene-stellen/x/${IDS[0]}` } }],
    }), { status: 200 });
    await expect(fetchVtgJobUrls({ fetchImpl: offContract, timeoutMs: 1000 })).rejects.toThrow(/malformed=3/);
  });

  it('accepts source-zero only when every required region reports total=0', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ total: 0, jobs: [] }), { status: 200 });
    await expect(fetchVtgJobUrls({ fetchImpl, timeoutMs: 1000 })).resolves.toMatchObject({
      urls: [],
      fetched: 0,
      sourceZero: true,
      regionTotals: { TI: 0, Ostschweiz1: 0, Ostschweiz2: 0 },
    });
  });

  it('rejects missing, blank, or malformed totals before numeric coercion', async () => {
    for (const total of [null, '', 'not-a-number']) {
      const fetchImpl = async () => new Response(JSON.stringify({ total, jobs: [] }), { status: 200 });

      await expect(fetchVtgJobUrls({ fetchImpl, scope: 'ch-wide', timeoutMs: 1000 }))
        .rejects.toThrow(/invalid total/);
    }
  });

  it('paginates the Swiss-wide scope through the declared total', async () => {
    const jobs = Array.from({ length: 501 }, (_, index) => job(
      `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    ));
    const offsets: number[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get('offset'));
      offsets.push(offset);
      return new Response(JSON.stringify({
        total: jobs.length,
        jobs: jobs.slice(offset, offset + 500),
      }), { status: 200 });
    };

    const result = await fetchVtgJobUrls({ fetchImpl, scope: 'ch-wide', timeoutMs: 1000 });

    expect(offsets).toEqual([0, 500]);
    expect(result).toMatchObject({
      fetched: 501,
      regionTotals: { CH: 501 },
      sourceZero: false,
    });
    expect(result.urls).toHaveLength(501);
  });

  it('fails closed when a Swiss-wide page is shorter than its declared remainder', async () => {
    const jobs = Array.from({ length: 500 }, (_, index) => job(
      `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    ));
    const fetchImpl = async (input: string | URL | Request) => {
      const offset = Number(new URL(String(input)).searchParams.get('offset'));
      return new Response(JSON.stringify({
        total: 501,
        jobs: offset === 0 ? jobs : [],
      }), { status: 200 });
    };

    await expect(fetchVtgJobUrls({ fetchImpl, scope: 'ch-wide', timeoutMs: 1000 }))
      .rejects.toThrow(/fetched 500\/501/);
  });

  it('fails closed when a Swiss-wide page repeats the prior page', async () => {
    const page = Array.from({ length: 500 }, (_, index) => job(
      `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    ));
    const fetchImpl = async () => new Response(JSON.stringify({
      total: 1000,
      jobs: page,
    }), { status: 200 });

    await expect(fetchVtgJobUrls({ fetchImpl, scope: 'ch-wide', timeoutMs: 1000 }))
      .rejects.toThrow(/repeated job identity/);
  });
});

describe('VTG adapter persistence', () => {
  it('is atomic, parity-checked, idempotent, and never swallows stale/write failures', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtg-adapter-'));
    const adapterPath = path.join(dir, 'vtg.json');
    const urls = [`https://jobs.admin.ch/offene-stellen/test/${IDS[0]}`];
    const meta = { [urls[0]]: { location: 'Bellinzona', canton: 'TI' } };
    const updatedAt = '2026-09-01T00:00:00.000Z';
    try {
      ensureAdapterSeedUrls(urls, meta, adapterPath, updatedAt);
      const firstBytes = fs.readFileSync(adapterPath, 'utf8');
      ensureAdapterSeedUrls(urls, meta, adapterPath, updatedAt);
      expect(fs.readFileSync(adapterPath, 'utf8')).toBe(firstBytes);
      expect(() => assertVtgAdapterParity({ seedUrls: [] }, urls, meta)).toThrow(/parity failed/);

      fs.writeFileSync(adapterPath, '{ stale');
      const staleBytes = fs.readFileSync(adapterPath, 'utf8');
      expect(() => ensureAdapterSeedUrls(urls, meta, adapterPath, updatedAt)).toThrow();
      expect(fs.readFileSync(adapterPath, 'utf8')).toBe(staleBytes);
      expect(() => ensureAdapterSeedUrls(urls, meta, dir, updatedAt)).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('VTG workplace location', () => {
  // The jobs.admin.ch JSON-LD address is the administrative unit (Bern), not
  // the workplace the page states ("Arbeitsort: Places d'armes, 1436
  // Chamblon") — 174/184 VTG jobs were published in Bern and the same
  // apprenticeship in Hinwil and Bronschhofen became two identical listings.
  const jsonLd = {
    '@type': 'JobPosting',
    title: 'Verantwortliche/-r Ausbildungsanlagen',
    description: '<p><div>Diesen Beitrag können Sie leisten</div><br><ul><li>Anlagen und Gebäude instand halten</li></ul></p>',
    hiringOrganization: { name: 'Schweizer Armee - Logistikbasis der Armee LBA' },
    jobLocation: {
      '@type': 'Place',
      address: { addressLocality: 'Bern', addressRegion: 'Bern', postalCode: '3003', addressCountry: 'Schweiz' },
    },
  };
  const url = `https://jobs.admin.ch/offene-stellen/verantwortliche-r-ausbildungsanlagen/${IDS[0]}`;

  async function seedMetaFor(arbeitsort: string) {
    const apiJob = {
      links: { directlink: url },
      attributes: { arbeitsort: [arbeitsort], region: ['Genferseeregion (GE, VD, VS)'], verwaltungseinheit: ['Gruppe Verteidigung'] },
    };
    const fetchImpl = async () => new Response(JSON.stringify({ total: 1, jobs: [apiJob] }), { status: 200 });
    const result = await fetchVtgJobUrls({ fetchImpl, timeoutMs: 1000, scope: 'ch-wide' });
    return result.seedMetaByUrl[url];
  }

  it('hands the engine the arbeitsort as workplace and the engine publishes it', async () => {
    const seedMeta = await seedMetaFor('Chamblon');
    expect(seedMeta).toMatchObject({ workplaceLocation: 'Chamblon' });
    expect(sharedCrawlerTestables.toJobFromJsonLd(jsonLd, 'Swiss Armed Forces (VTG)', url, { seedMeta, isSeedDetail: true }))
      .toMatchObject({ reason: null, job: { location: 'Chamblon', canton: 'VD' } });
  });

  it('keeps an explicit canton marker for a locality it cannot place alone, and no workplace abroad', async () => {
    expect(await seedMetaFor('Grolley (FR), Lehrbeginn August 2027')).toMatchObject({ workplaceLocation: 'Grolley (FR)' });
    // A former municipality without a marker would get a canton guessed from
    // the job text: the engine keeps its previous behaviour instead.
    expect((await seedMetaFor('Bronschhofen')).workplaceLocation).toBeUndefined();
    expect((await seedMetaFor('Ausland / Kosovo')).workplaceLocation).toBeUndefined();
  });

  it('skips a leading site label that is not a place: "Places d\'armes, 1436 Chamblon" is Chamblon', async () => {
    const seedMeta = await seedMetaFor("Places d'armes, 1436 Chamblon");
    expect(seedMeta).toMatchObject({ workplaceLocation: 'Chamblon' });
    expect(seedMeta.workplaceLocation).not.toBe("Places d'armes");
    expect(sharedCrawlerTestables.toJobFromJsonLd(jsonLd, 'Swiss Armed Forces (VTG)', url, { seedMeta, isSeedDetail: true }))
      .toMatchObject({ reason: null, job: { location: 'Chamblon', canton: 'VD' } });
  });
});

describe('VTG workplace site (audit-parser-quality issue 5253, duplicate-descriptions)', () => {
  // Two "Panzermechatroniker/-in schwere Raupenfahrzeuge" postings, same body,
  // both published in Bern: the pages name two sites, Hinwil (ZH) and the
  // barracks at 9552 Bronschhofen (SG). Bronschhofen merged into Wil in 2013
  // and is missing from the BFS list, so the seed had no workplace and the
  // region facet "Ostschweiz (AI, AR, …)" gave canton AI.
  const page = (name: string) => readFixture(`jobs-admin-ch-vtg-workplace-${name}.html`);
  const url = (id: string) => `https://jobs.admin.ch/offene-stellen/panzermechatroniker-in-schwere-raupenfahrzeuge/${id}`;
  const BRONSCHHOFEN = url('1a36400a-eebc-49dd-8032-1c3eacf586e0');
  const HINWIL = url('7913fbca-fc96-41b5-ba14-b44e842199d4');
  const jsonLd = {
    '@type': 'JobPosting',
    title: 'Panzermechatroniker/-in schwere Raupenfahrzeuge',
    description: '<p><div>Diesen Beitrag kannst du leisten</div><ul><li>Haupt- und Nebenaggregate reparieren und revidieren</li></ul></p>',
    hiringOrganization: { name: 'Schweizer Armee - Logistikbasis der Armee LBA' },
    jobLocation: { '@type': 'Place', address: { addressLocality: 'Bern', addressRegion: 'Bern', postalCode: '3003', addressCountry: 'Schweiz' } },
  };

  async function seedMeta(directLink: string, arbeitsort: string, region: string[]) {
    const apiJob = {
      links: { directlink: directLink },
      attributes: { arbeitsort: [arbeitsort], region, verwaltungseinheit: ['Gruppe Verteidigung'] },
    };
    const fetchImpl = async () => new Response(JSON.stringify({ total: 1, jobs: [apiJob] }), { status: 200 });
    return (await fetchVtgJobUrls({ fetchImpl, timeoutMs: 1000, scope: 'ch-wide' })).seedMetaByUrl[directLink];
  }

  it('places an arbeitsort the BFS list lacks within the cantons of its region, never on the first code', async () => {
    const meta = await seedMeta(BRONSCHHOFEN, 'Bronschhofen', ['Ostschweiz (AI, AR, GL, GR, SG, SH, TG)']);
    expect(meta).toMatchObject({ workplaceLocation: 'Bronschhofen (SG)', canton: 'SG' });
    expect(sharedCrawlerTestables.toJobFromJsonLd(jsonLd, 'Swiss Armed Forces (VTG)', BRONSCHHOFEN, { seedMeta: meta, isSeedDetail: true }))
      .toMatchObject({ reason: null, job: { location: 'Bronschhofen (SG)', canton: 'SG' } });
    // "Bremgarten" in region Espace Mittelland: the directory has Bremgarten
    // only in Aargau ("Bremgarten bei Bern" is another name), so no seed —
    // the page's address "Kaserne, 5620 Bremgarten" settles it below.
    const bremgarten = await seedMeta(url('c5fc8871-7a1c-4be6-b55f-e88fb9a525a2'), 'Bremgarten, Lehrbeginn August 2027', ['Espace Mittelland (BE, FR, JU, NE, SO)']);
    expect(bremgarten.workplaceLocation).toBeUndefined();
  });

  it('carries the page address into the job: two same-title postings are two sites', () => {
    const published = (jobUrl: string, location: string, canton: string) => ({
      url: jobUrl, title: jsonLd.title, location, addressLocality: location, canton, addressRegion: canton,
    });
    const hinwil = applyVtgWorkplaceAddress(published(HINWIL, 'Hinwil', 'ZH'),
      parseFederalJobDetailExtras(page('hinwil')).facts, { seededWorkplace: true });
    const bronschhofen = applyVtgWorkplaceAddress(published(BRONSCHHOFEN, 'Bronschhofen (SG)', 'SG'),
      parseFederalJobDetailExtras(page('bronschhofen')).facts, { seededWorkplace: true });

    expect(hinwil).toMatchObject({ location: 'Hinwil', streetAddress: 'Ueberlandstrasse 17', postalCode: '8340', addressLocality: 'Hinwil', canton: 'ZH', addressRegion: 'ZH' });
    expect(bronschhofen).toMatchObject({ location: 'Bronschhofen (SG)', streetAddress: 'Amp-Strasse 12', postalCode: '9552', addressLocality: 'Bronschhofen', canton: 'SG' });
  });

  it('replaces the administrative unit the engine fell back to, and keeps a job the page gives no address for', () => {
    // Engine output of the previous code for the Bronschhofen posting: the
    // JSON-LD address (Bern) with the region's first canton. The locality
    // alone does not name its canton, so the display keeps the marker.
    const fallback = { url: BRONSCHHOFEN, title: jsonLd.title, location: 'Bern', addressLocality: 'Bern', canton: 'AI', addressRegion: 'AI' };
    expect(applyVtgWorkplaceAddress(fallback, parseFederalJobDetailExtras(page('bronschhofen')).facts))
      .toMatchObject({ location: 'Bronschhofen (SG)', addressLocality: 'Bronschhofen', postalCode: '9552', streetAddress: 'Amp-Strasse 12', canton: 'SG', addressRegion: 'SG' });

    // An arbeitsort read in another canton than the page's address: the address wins.
    const misplaced = { ...fallback, location: 'Bremgarten (BE)', addressLocality: 'Bremgarten (BE)', canton: 'BE', addressRegion: 'BE' };
    expect(applyVtgWorkplaceAddress(misplaced, [{ label: 'Arbeitsort', value: 'Kaserne, 5620 Bremgarten' }], { seededWorkplace: true }))
      .toMatchObject({ location: 'Bremgarten (AG)', addressLocality: 'Bremgarten', postalCode: '5620', streetAddress: 'Kaserne', canton: 'AG' });

    // A CAP two cantons share is read in the published one.
    const rueti = { ...fallback, location: 'Rüti (ZH)', addressLocality: 'Rüti (ZH)', canton: 'ZH', addressRegion: 'ZH' };
    expect(applyVtgWorkplaceAddress(rueti, [{ label: 'Arbeitsort', value: 'Rekrutierungszentrum Rüti, Spitalstrasse 33, 8630 Rüti' }], { seededWorkplace: true }))
      .toMatchObject({ location: 'Rüti (ZH)', addressLocality: 'Rüti', postalCode: '8630', canton: 'ZH' });

    // Abroad or no fact: nothing is made up, the very same object comes back.
    expect(applyVtgWorkplaceAddress(fallback, [{ label: 'Arbeitsort', value: 'Pristina, Kosovo' }])).toBe(fallback);
    expect(applyVtgWorkplaceAddress(fallback, [])).toBe(fallback);
  });
});
