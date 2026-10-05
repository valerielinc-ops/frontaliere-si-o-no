/**
 * OpenAgenda (Ginevra e Nyon): crawler API v2, licenza aperta, prezzo con la
 * fonte nel dato.
 *
 * Le fixture in tests/fixtures/openagenda/ sono costruite a mano sulla
 * struttura documentata della API (`total`, `events`, `after`) e sui campioni
 * pubblici dell'ACG: nomi, indirizzi e recapiti sono fittizi. Vanno sostituite
 * con la prima risposta reale quando il proprietario avrà creato la chiave.
 *
 * Casi coperti, ciascuno legato a una condizione della Licence Ouverte 2.0 o
 * della regola H5:
 *   - mappatura sul record evento (testi multilingue, luogo, date nel fuso
 *     dell'evento, link, `updatedAt`) e campi mai scritti (email, telefono,
 *     `conditions`);
 *   - paginazione col cursore `after`, chiave solo nell'header;
 *   - chiave assente → no-op con `::notice::`, nessuna richiesta, slice
 *     intatto;
 *   - `gratuit` dell'ACG → prezzo con provenienza, pubblicabile solo se il
 *     registro lo ammette;
 *   - immagini con credito «DR» (o vuoto) escluse;
 *   - attribuzione «Fonte: OpenAgenda — <agenda>, aggiornato il <data>»;
 *   - deduplica contro ge-agenda in assemble.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  MISSING_KEY_NOTICE,
  OPENAGENDA_AGENDAS,
  buildEventsUrl,
  crawlOpenAgenda,
  eventDatesFromTimings,
  isReusableImageCredit,
  mapOpenAgendaEvent,
} from '../scripts/crawl-openagenda-events.mjs';
import {
  EVENT_PRICE_SOURCES,
  EVENT_SOURCES,
  STRUCTURED_EVENT_PRICE_FIELDS,
  hasConfidentPrice,
  slugifyEvent,
} from '../scripts/lib/events-utils.mjs';
import { RC_TO_ENV } from '../scripts/load-rc-env.mjs';
import { dedupeFuzzy, dedupeSupersededTwins } from '../scripts/assemble-events-dataset.mjs';
import { eventLd, renderEventDetailPage, renderOpenAgendaAttribution } from '../build-plugins/eventsSeoPagesPlugin';

const fixture = (name: string) => JSON.parse(
  readFileSync(new URL(`./fixtures/openagenda/${name}`, import.meta.url), 'utf8'),
);
const PAGE_1 = fixture('geneve-communes-page-1.json');
const PAGE_2 = fixture('geneve-communes-page-2.json');
const ALL_RAW = [...PAGE_1.events, ...PAGE_2.events];
const raw = (uid: number) => ALL_RAW.find((event: { uid: number }) => event.uid === uid);

const [VILLE, ACG] = OPENAGENDA_AGENDAS;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function silentLog() {
  const lines: string[] = [];
  return { lines, log: { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) } };
}

describe('OpenAgenda: mappatura sul record evento', () => {
  const exhibition = mapOpenAgendaEvent(raw(70000001), ACG)!;

  it('legge testi multilingui, luogo, coordinate, link e data di aggiornamento', () => {
    expect(exhibition.id).toBe('openagenda:70000001');
    expect(exhibition.title).toBe('Exposition de printemps');
    expect(exhibition.titleByLocale).toEqual({ en: 'Spring exhibition', fr: 'Exposition de printemps' });
    expect(exhibition.descriptionByLocale?.en).toBe('Photographs and prints by a local collective.');
    expect(exhibition.venue).toBe('Galerie Exemple');
    // La via perde la coda «, 1227 Carouge»: CAP e località sono campi a sé.
    expect(exhibition.address).toEqual({ street: "Rue de l'Exemple 1", postalCode: '1227', locality: 'Carouge' });
    expect(exhibition.geo).toEqual({ lat: 46.1836, lng: 6.1393 });
    // «Carouge (GE)» nell'elenco ufficiale: il suffisso del cantone non deve
    // far perdere il comune.
    expect(exhibition.comune).toBe('Carouge (GE)');
    expect(exhibition.canton).toBe('GE');
    expect(exhibition.url).toBe('https://openagenda.com/fr/geneve-communes/events/exposition-de-printemps');
    expect(exhibition.sourceAgenda).toBe('Association des communes genevoises');
    expect(exhibition.sourceUpdatedAt).toBe('2026-10-01T08:30:00.000Z');
    expect(exhibition.category).toBe('Exposition');
  });

  it('data l\'evento dalla prima fascia e dall\'ultima fine, nel fuso dell\'evento', () => {
    // Fasce fuori ordine nella risposta: l'inizio è la prima in assoluto.
    expect(exhibition.startDate).toBe('2026-11-05');
    expect(exhibition.startTime).toBe('18:00');
    expect(exhibition.endDate).toBe('2026-11-20');
    expect(exhibition.recurring).toBe(true);
    // 22:30 locali = 20:30 UTC: in UTC la data sarebbe giusta ma l'ora no; la
    // fine dopo mezzanotte sposta endDate al giorno dopo.
    const concert = mapOpenAgendaEvent(raw(70000002), ACG)!;
    expect(concert.startDate).toBe('2026-10-23');
    expect(concert.startTime).toBe('22:30');
    expect(concert.endDate).toBe('2026-10-24');
    expect(concert.recurring).toBeUndefined();
  });

  it('tiene lo stesso inizio da un run all\'altro, quindi lo stesso slug', () => {
    const timings = raw(70000001).timings;
    const once = eventDatesFromTimings(timings, 'Europe/Zurich');
    const later = eventDatesFromTimings([...timings].reverse(), 'Europe/Zurich');
    expect(later).toEqual(once);
    expect(slugifyEvent(exhibition)).toContain(exhibition.startDate);
  });

  it('non scrive mai email, telefono, recapiti di registrazione né conditions', () => {
    for (const event of ALL_RAW) {
      const record = mapOpenAgendaEvent(event, ACG);
      if (!record) continue;
      const serialized = JSON.stringify(record);
      expect(serialized).not.toMatch(/@example\.org/);
      expect(serialized).not.toContain('+41 00');
      for (const text of Object.values((event.conditions ?? {}) as Record<string, string>)) {
        expect(serialized).not.toContain(text);
      }
    }
  });

  it('scarta gli eventi solo online e segna quelli annullati', () => {
    expect(mapOpenAgendaEvent(raw(70000003), ACG)).toBeNull();
    const cancelled = mapOpenAgendaEvent(raw(70000004), ACG)!;
    expect(cancelled.eventStatus).toBe('cancelled');
    const ld = eventLd({ ...cancelled, sourceKey: 'openagenda', sourceName: 'OpenAgenda' } as never, 'it') as Record<string, unknown>;
    expect(ld.eventStatus).toBe('https://schema.org/EventCancelled');
  });
});

describe('OpenAgenda: prezzo solo dal booleano gratuit dell\'ACG', () => {
  it('gratuit === true → prezzo gratuito con fonte e campo nel dato', () => {
    const record = mapOpenAgendaEvent(raw(70000001), ACG)!;
    expect(record.price).toEqual({
      amount: 0, currency: 'CHF', isFree: true, priceSource: 'openagenda', priceField: 'gratuit',
    });
  });

  it('gratuit === false, gratuit assente o un\'agenda diversa dall\'ACG → nessun prezzo', () => {
    expect(mapOpenAgendaEvent(raw(70000002), ACG)!.price).toBeUndefined();
    expect(mapOpenAgendaEvent(raw(70000005), ACG)!.price).toBeUndefined();
    expect(mapOpenAgendaEvent(raw(70000001), VILLE)!.price).toBeUndefined();
  });

  it('conditions non diventa mai un prezzo, nemmeno quando dice «Gratuit»', () => {
    const atelier = raw(70000005);
    expect(atelier.conditions.fr).toMatch(/gratuit/i);
    expect(mapOpenAgendaEvent(atelier, ACG)!.price).toBeUndefined();
  });

  it('si pubblica solo quando il registro H5 ammette openagenda/gratuit', () => {
    const { price } = mapOpenAgendaEvent(raw(70000001), ACG)!;
    const admitted = EVENT_PRICE_SOURCES.includes('openagenda') && STRUCTURED_EVENT_PRICE_FIELDS.includes('gratuit');
    expect(hasConfidentPrice(price)).toBe(admitted);
  });
});

describe('OpenAgenda: immagini solo con un credito che non riserva i diritti', () => {
  it('esclude «DR» e le sue varianti, un credito vuoto e un\'agenda senza licenza', () => {
    for (const credit of ['DR', 'dr', 'D.R.', 'D. R.', '© DR', '  ', '', 'Droits réservés', 'Tous droits réservés', 'All rights reserved']) {
      expect(isReusableImageCredit(credit, ACG), credit).toBe(false);
    }
    expect(isReusableImageCredit('Commune de Carouge', ACG)).toBe(true);
    expect(isReusableImageCredit('Commune de Carouge', { ...ACG, license: undefined })).toBe(false);
  });

  it('porta l\'immagine e il suo credito solo dove il credito è riusabile', () => {
    const withImage = mapOpenAgendaEvent(raw(70000001), ACG)!;
    expect(withImage.imageUrl).toBe('https://img.openagenda.com/main/a1b2c3d4.base.image.jpg');
    expect(withImage.imageCredit).toBe('Commune de Carouge');
    for (const uid of [70000002, 70000004, 70000005]) {
      const record = mapOpenAgendaEvent(raw(uid), ACG)!;
      expect(record.imageUrl, String(uid)).toBeUndefined();
      expect(record.imageCredit, String(uid)).toBeUndefined();
    }
  });
});

describe('OpenAgenda: paginazione, chiave e slice', () => {
  function pagedFetch() {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return jsonResponse(calls.length === 1 ? PAGE_1 : PAGE_2);
    };
    return { calls, fetchImpl };
  }

  it('segue il cursore after fino a after: null, con la chiave solo nell\'header', async () => {
    const { calls, fetchImpl } = pagedFetch();
    const sliceDir = mkdtempSync(path.join(os.tmpdir(), 'openagenda-slice-'));
    const { log } = silentLog();
    const mirrored: string[] = [];
    const result = await crawlOpenAgenda({
      key: 'oa_pk_test',
      agendas: [ACG],
      fetchImpl: fetchImpl as never,
      sliceDir,
      delayMs: 0,
      mirrorImage: async (_url: string, id: string) => {
        mirrored.push(id);
        return `/images/events/${id.replace(':', '-')}.webp`;
      },
      log,
    });

    expect(calls).toHaveLength(2);
    const second = new URL(calls[1].url);
    expect(second.searchParams.getAll('after[]')).toEqual(PAGE_1.after);
    expect(new URL(calls[0].url).searchParams.getAll('after[]')).toEqual([]);
    for (const call of calls) {
      expect(call.headers.key).toBe('oa_pk_test');
      expect(call.url).not.toContain('oa_pk_test');
      expect(new URL(call.url).searchParams.getAll('relative[]')).toEqual(['current', 'upcoming']);
    }

    const expected = ALL_RAW.filter((event: { attendanceMode: number }) => event.attendanceMode !== 2).length;
    expect(result.status).toBe('ok');
    expect(result.events).toHaveLength(expected);
    // Solo l'immagine col credito riusabile viene specchiata, mai linkata.
    expect(mirrored).toEqual(['openagenda:70000001']);
    expect(result.events.every((event: { imageUrl?: string }) => !event.imageUrl || event.imageUrl.startsWith('/'))).toBe(true);

    const slice = JSON.parse(readFileSync(path.join(sliceDir, 'openagenda.json'), 'utf8'));
    expect(slice.sourceKey).toBe('openagenda');
    expect(slice.events.map((event: { id: string }) => event.id).sort())
      .toEqual(result.events.map((event: { id: string }) => event.id).sort());
    expect(slice.events.every((event: { sourceKey: string }) => event.sourceKey === 'openagenda')).toBe(true);
  });

  it('senza chiave stampa il notice, non chiama la API e non tocca lo slice', async () => {
    const sliceDir = mkdtempSync(path.join(os.tmpdir(), 'openagenda-nokey-'));
    let fetched = 0;
    const { lines, log } = silentLog();
    for (const key of [undefined, '', '   ']) {
      const result = await crawlOpenAgenda({
        key,
        fetchImpl: (async () => { fetched += 1; return jsonResponse(PAGE_1); }) as never,
        sliceDir,
        log,
      });
      expect(result.status).toBe('no-key');
      expect(result.written).toBe(false);
    }
    expect(fetched).toBe(0);
    expect(existsSync(path.join(sliceDir, 'openagenda.json'))).toBe(false);
    expect(lines.every((line) => line === MISSING_KEY_NOTICE)).toBe(true);
    expect(MISSING_KEY_NOTICE.startsWith('::notice::OPENAGENDA_PUBLIC_KEY assente')).toBe(true);
  });

  it('una chiave rifiutata (403) è un fallimento e lascia lo slice com\'era', async () => {
    const sliceDir = mkdtempSync(path.join(os.tmpdir(), 'openagenda-403-'));
    const { log } = silentLog();
    const result = await crawlOpenAgenda({
      key: 'oa_pk_revoked',
      agendas: [ACG],
      fetchImpl: (async () => jsonResponse({ error: 'forbidden' }, 403)) as never,
      sliceDir,
      delayMs: 0,
      log,
    });
    expect(result.status).toBe('failed');
    expect(result.written).toBe(false);
    expect(existsSync(path.join(sliceDir, 'openagenda.json'))).toBe(false);
  });

  it('chiede eventi correnti e futuri entro l\'orizzonte, dettagliati e con le etichette', () => {
    const url = new URL(buildEventsUrl(52853891, { horizonIso: '2027-10-05T00:00:00.000Z' }));
    expect(url.pathname).toBe('/v2/agendas/52853891/events');
    expect(url.searchParams.get('timings[lte]')).toBe('2027-10-05T00:00:00.000Z');
    expect(url.searchParams.get('size')).toBe('300');
    expect(url.searchParams.get('detailed')).toBe('1');
    expect(url.searchParams.get('includeLabels')).toBe('1');
    expect(url.searchParams.has('key')).toBe(false);
  });
});

describe('OpenAgenda: attribuzione richiesta dalla licenza', () => {
  const record = {
    ...mapOpenAgendaEvent(raw(70000001), ACG)!,
    imageUrl: '/images/events/openagenda-70000001.webp',
    sourceKey: 'openagenda',
    sourceName: EVENT_SOURCES.openagenda.label,
  };

  it('indica fonte, agenda e data di aggiornamento col link, senza loghi', () => {
    const html = renderOpenAgendaAttribution(record as never, 'it');
    expect(html).toContain('Fonte: <a class="ev-lnk" href="https://openagenda.com/fr/geneve-communes/events/exposition-de-printemps"');
    expect(html).toContain('OpenAgenda — Association des communes genevoises</a>, aggiornato il');
    expect(html).toContain('1 ottobre 2026');
    expect(html).toContain('Immagine: Commune de Carouge');
    expect(html).not.toMatch(/<img|logo|ufficiale|officiel/i);
    expect(renderOpenAgendaAttribution(record as never, 'fr')).toContain('mis à jour le');
  });

  it('compare nella pagina evento e non per le altre fonti', () => {
    const page = renderEventDetailPage({
      locale: 'it',
      event: record as never,
      comune: record.comune!,
      eventSlug: slugifyEvent(record),
      sameComuneEvents: [record] as never,
      dateStamp: '2026-10-05',
      distDir: mkdtempSync(path.join(os.tmpdir(), 'openagenda-page-')),
      detailHref: (() => null) as never,
    });
    // L'HTML della pagina è minificato: virgolette degli attributi facoltative.
    expect(page.html).toMatch(/data-event-attribution="?openagenda"?[ >]/);
    expect(page.html).toContain('aggiornato il');
    expect(renderOpenAgendaAttribution({ ...record, sourceKey: 'guidle' } as never, 'it')).toBe('');
    expect(renderOpenAgendaAttribution({ ...record, sourceUpdatedAt: undefined } as never, 'it')).toBe('');
  });

  it('attribuisce l\'immagine al suo autore nei dati strutturati', () => {
    const ld = eventLd(record as never, 'it') as { image: { creditText?: string } };
    expect(ld.image.creditText).toBe('Commune de Carouge');
  });
});

describe('OpenAgenda: deduplica contro ge-agenda in assemble', () => {
  const openagenda = {
    ...mapOpenAgendaEvent(raw(70000002), ACG)!,
    sourceKey: 'openagenda',
    sourceName: 'OpenAgenda',
  };
  // Il gemello HTML: stesso titolo, stessa data, stesso comune, ma «più
  // ricco» per il punteggio (descrizione, immagine e una tariffa letta dal
  // testo) — deve perdere lo stesso.
  const geAgenda = {
    id: 'ge-agenda:concert-du-soir',
    title: 'Concert du soir',
    startDate: openagenda.startDate,
    comune: 'Genève',
    canton: 'GE',
    url: 'https://www.geneve.ch/agenda/concert-du-soir',
    sourceKey: 'ge-agenda',
    sourceName: 'Ville de Genève Agenda',
    description: 'Un concert.',
    imageUrl: '/images/events/ge-agenda-concert.webp',
    price: { amount: 25, currency: 'CHF', isFree: false },
    endDate: '2026-10-24',
    venue: 'Salle communale',
    address: { street: 'Place du Marché 2' },
    geo: { lat: 46.2017, lng: 6.1466 },
    organizer: { '@type': 'Organization', name: 'Ville' },
    performer: { '@type': 'Organization', name: 'Ensemble' },
  };

  it('a parità di titolo, data e luogo vince sempre il record OpenAgenda', () => {
    const { events, mergedAway } = dedupeFuzzy([geAgenda, openagenda] as never);
    expect(mergedAway).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(openagenda.id);
  });

  it('assorbe il gemello datato diversamente quando l\'intervallo OpenAgenda lo copre', () => {
    const running = { ...openagenda, id: 'openagenda:1', startDate: '2026-10-01', endDate: '2026-10-25' };
    const twin = { ...geAgenda, startDate: '2026-10-05' };
    const { events, mergedAway } = dedupeSupersededTwins([running, twin] as never);
    expect(mergedAway).toBe(1);
    expect(events.map((event: { id: string }) => event.id)).toEqual(['openagenda:1']);
  });

  it('lascia stare un gemello ambiguo, di un altro comune o fuori intervallo', () => {
    const running = { ...openagenda, id: 'openagenda:1', startDate: '2026-10-01', endDate: '2026-10-25' };
    const ambiguous = [running, { ...running, id: 'openagenda:2' }, { ...geAgenda, startDate: '2026-10-05' }];
    expect(dedupeSupersededTwins(ambiguous as never).mergedAway).toBe(0);
    const elsewhere = [running, { ...geAgenda, startDate: '2026-10-05', comune: 'Onex' }];
    expect(dedupeSupersededTwins(elsewhere as never).mergedAway).toBe(0);
    const later = [running, { ...geAgenda, startDate: '2026-11-05' }];
    expect(dedupeSupersededTwins(later as never).mergedAway).toBe(0);
  });
});

describe('OpenAgenda: cablaggio di workflow e Remote Config', () => {
  const workflow = YAML.parse(readFileSync(
    path.resolve(__dirname, '../.github/workflows/crawl-events.yml'),
    'utf8',
  ));
  const steps: Array<{ id?: string; run?: string }> = workflow.jobs['crawl-events'].steps;

  it('il passo invoca il crawler e lo slice entra nella PR di refresh', () => {
    const crawl = steps.find((step) => step.id === 'crawl-openagenda');
    expect(crawl?.run).toContain('node scripts/crawl-openagenda-events.mjs');
    const publish = steps.find((step) => step.id === 'commit');
    expect(publish?.run).toMatch(/for source in [^;]*\bopenagenda\b/);
  });

  it('la chiave arriva da Remote Config col suo nome', () => {
    expect(RC_TO_ENV.OPENAGENDA_PUBLIC_KEY).toEqual(['OPENAGENDA_PUBLIC_KEY']);
  });
});
