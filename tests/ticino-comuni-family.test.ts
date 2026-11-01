// @vitest-environment node
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyNoticeTitle,
  dropAttachmentsOfPublishedNotices,
  extractDeadline,
  extractNoticeDate,
  isNoticeOpen,
  resolveNoticeIssuer,
  roleTitleFromNotice,
} from '../scripts/lib/ticino-comuni-notice.mjs';
import {
  RobotsDisallowedError,
  createPoliteClient,
} from '../scripts/lib/ticino-comuni-polite-client.mjs';
import {
  assoloListingUrl,
  isPdfHref,
  parseAssoloListing,
  parseCityOsDetail,
  parseCityOsList,
  parseDedicatedPage,
} from '../scripts/lib/ticino-comuni-sources.mjs';
import {
  TICINO_COMUNI_KEY,
  coveredTicinoComuni,
  dropExpiredStoredJobs,
  fetchAllTicinoComuniJobs,
  fetchTicinoComuneJobs,
  isTrustedComuneUrl,
  loadTicinoComuniRegistry,
} from '../scripts/lib/ticino-comuni-crawler.mjs';
import { isAuthoritativeEmptySnapshot } from '../scripts/lib/authoritative-empty-snapshot.mjs';
import { extractPdfJobContentFromUrl } from '../scripts/lib/pdf-job-content.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const NOW = new Date();

function daysFromNow(days: number) {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}
function italianDate(iso: string) {
  const [year, month, day] = iso.split('-');
  const names = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  return `${Number(day)} ${names[Number(month) - 1]} ${year}`;
}
function numericDate(iso: string) {
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year.slice(2)}`;
}

const ESEMPIO = {
  key: 'comune-di-esempio',
  company: 'Comune di Esempio',
  municipality: 'Esempio',
  domain: 'esempio.ch',
  postalCode: '6900',
  streetAddress: 'Via Municipio 1',
  addressLocality: 'Esempio',
  listing: {
    type: 'assolo',
    url: 'https://www.esempio.ch/Albo-comunale-c3dfab00',
    fric: '4925',
    catParam: 'param_cat0',
    catId: '72',
    catLabel: 'Concorsi',
  },
};

const bando = (issuer: string, deadline: string) => `COMUNE DI ESEMPIO
${issuer} apre il concorso per l'assunzione a tempo pieno di un/a impiegato/a amministrativo/a.
Requisiti: cittadinanza svizzera o permesso valido, attestato federale di capacita, ottime conoscenze
della lingua italiana, buone capacita relazionali, predisposizione al lavoro in team e autonomia.
Mansioni: gestione della corrispondenza, sportello alla popolazione, archivio, supporto alla Cancelleria,
tenuta dei registri comunali, collaborazione con gli uffici dell'amministrazione e con il Municipio.
Le candidature devono pervenire alla Cancelleria comunale, in busta chiusa, entro le ore 16:00 di ${deadline}.
Il Municipio si riserva la facolta di annullare il presente concorso senza indicarne i motivi.`;

describe('classifyNoticeTitle — che cosa sta nella categoria Concorsi', () => {
  it.each([
    ["Concorso per l'assunzione di un/a collaboratore/trice tecnico comunale", 'job'],
    ['Concorso per la nomina di un/a funzionario/a amministrativo - contabile a tempo pieno', 'job'],
    ['Assunzione stagista 52 settimane - Percorso MP1 3+1', 'job'],
    ['Concorso operaio comunale', 'job'],
    ['Concorso permanente Centro Anziani', 'job'],
    ['Capitolato di concorso per la nomina di un montatore idraulico', 'attachment'],
    ['Mansionario concorso assunzione operaio comunale con indirizzo selvicoltore', 'attachment'],
    ['Concorso impiegato amministrativo - capitolato', 'attachment'],
    ['Autocertificazione sullo stato di salute per concorso', 'form'],
    ['Questionario relativo al casellario giudiziale', 'form'],
    ['Concorso pubblico per opere da idraulico per la sostituzione dell\'acquedotto', 'not-a-job'],
    ['Concorso prestazioni da ingegnere civile - opere PGS', 'not-a-job'],
    ['Concorso servizio raccolta rifiuti solidi urbani RSU', 'not-a-job'],
    ['Concorso locazione "Esercizio con cucina"', 'not-a-job'],
    ['Bando di concorso per l\'affitto di due locali commerciali', 'not-a-job'],
    ['Concorso fotografico 2026', 'not-a-job'],
    ['Cercasi famiglie ospitanti per studenti/esse e stagisti/e', 'not-a-job'],
    ['Concorso per l\'assegnazione di borse di studio', 'not-a-job'],
    ['Comunicazione esito concorsi', 'not-a-job'],
  ])('%s -> %s', (title, expected) => {
    expect(classifyNoticeTitle(title)).toBe(expected);
  });
});

describe('roleTitleFromNotice', () => {
  it.each([
    ["Concorso per l'assunzione di una/un direttrice/ore", 'Direttrice/ore'],
    ['Avviso di concorso per l\'assunzione di due operai/e comunali qualificati', 'Operai/e comunali qualificati'],
    ['Concorso impiegato amministrativo per servizi amministrazione comunale - bando', 'Impiegato amministrativo per servizi amministrazione comunale'],
    ['Concorso pubblico per l\'assunzione, a titolo di incarico, di un/a Direttore/trice scolastico/a al 50%', 'Direttore/trice scolastico/a al 50%'],
    ['Capitolato di concorso per l\'incarico al 50% di un/a responsabile dell\'Ufficio energia', "Responsabile dell'Ufficio energia"],
    ['Assunzione stagista 52 settimane', 'Stagista 52 settimane'],
    ['Concorso permanente Istituti sociali 2026', 'Concorso permanente Istituti sociali 2026'],
    ['Concorso generale 2026/2027 per l\'assunzione di ausiliari/e di cucina supplenti', 'Ausiliari/e di cucina supplenti'],
  ])('%s', (raw, expected) => {
    expect(roleTitleFromNotice(raw)).toBe(expected);
  });
});

describe('resolveNoticeIssuer — il datore corretto', () => {
  const entry = { municipality: 'Esempio' };

  it('riconosce il bando del Comune dalla frase d\'apertura', () => {
    expect(resolveNoticeIssuer({ text: 'Il Municipio di Esempio apre il concorso', entry }))
      .toMatchObject({ own: true, reason: 'municipio-del-comune' });
    expect(resolveNoticeIssuer({ text: 'Il MUNICIPIO DI ESEMPIO apre il concorso', entry }).own).toBe(true);
  });

  it.each([
    ['La Delegazione consortile del CONSORZIO DEPURAZIONE ACQUE, comunica di aver aperto il concorso'],
    ["L'Associazione Centro giovani apre il concorso per l'assunzione di un/a animatore/trice"],
    ['Il Municipio di Altrove apre il concorso per un tecnico'],
  ])('non attribuisce al Comune un bando ripubblicato: %s', (text) => {
    expect(resolveNoticeIssuer({ text, entry }).own).toBe(false);
  });

  it('in mancanza della frase, un ente nel titolo basta a escludere', () => {
    expect(resolveNoticeIssuer({
      title: 'CDALED - Bando di concorso apprendista',
      text: 'Comune di Esempio. Apprendista in automazione.',
      entry,
    })).toMatchObject({ own: false, reason: 'altro-ente-nel-titolo' });
  });

  it('un testo che non nomina il Comune resta fuori: l\'emittente non e\' provato', () => {
    expect(resolveNoticeIssuer({
      title: "Concorso per l'assunzione di una/un direttrice/ore",
      text: 'CERCA UNA DIRETTRICE O UN DIRETTORE. Informazioni sul sito del nido.',
      entry,
    })).toMatchObject({ own: false, reason: 'emittente-non-verificato' });
  });

  it('usa gli alias dichiarati dal registro', () => {
    expect(resolveNoticeIssuer({
      text: 'Il Municipio di Sant’Esempio apre il concorso',
      entry: { municipality: 'Sant\'Esempio' },
    }).own).toBe(true);
    expect(resolveNoticeIssuer({
      text: 'Il Municipio di S. Esempio apre il concorso',
      entry: { municipality: "Sant'Esempio", issuerAliases: ['S. Esempio'] },
    }).own).toBe(true);
  });
});

describe('extractDeadline — i concorsi scaduti restano fuori', () => {
  const future = daysFromNow(20);
  const year = future.slice(0, 4);

  it.each([
    [`entro le ore 16:00 di giovedì ${italianDate(future)}.`, future],
    [`entro le ore 11. 30. di lunedì ${italianDate(future)}.`, future],
    [`entro e non oltre (fa stato il timbro postale) Lunedì ${italianDate(future)}, alle ore 12.00`, future],
    [`Scadenza del concorso ${italianDate(future)}, ore 17.00`, future],
    [`entro lunedì ${Number(future.slice(8))}.${Number(future.slice(5, 7))}.${year}, in busta chiusa`, future],
  ])('%s', (text, expected) => {
    expect(extractDeadline(text)).toBe(expected);
  });

  it('completa l\'anno mancante con quello di pubblicazione', () => {
    const [, month, day] = future.split('-');
    const monthName = italianDate(future).split(' ')[1];
    expect(extractDeadline(`entro il ${Number(day)} ${monthName}`, { publishedIso: `${year}-01-01` }))
      .toBe(`${year}-${month}-${day.padStart(2, '0')}`);
  });

  it('non scambia l\'entrata in funzione o il contratto per la scadenza', () => {
    expect(extractDeadline(`Entrata in funzione prevista ${italianDate(future)}`)).toBe('');
    expect(extractDeadline(`entro breve: il contratto dura fino al ${italianDate(future)}`)).toBe('');
  });

  it('salta una data anteriore alla pubblicazione', () => {
    const past = daysFromNow(-90);
    expect(extractDeadline(`entro il ${italianDate(past)} e poi entro il ${italianDate(future)}`, { publishedIso: daysFromNow(-5) }))
      .toBe(future);
  });

  it('legge la data di testa e la formula di pubblicazione', () => {
    const published = daysFromNow(-3);
    expect(extractNoticeDate(`Esempio, ${italianDate(published)} Avviso di concorso`)).toBe(published);
    expect(extractNoticeDate(`testo. Pubblicazione all'albo a decorrere dal ${italianDate(published)}.`)).toBe(published);
  });
});

describe('isNoticeOpen', () => {
  it('scadenza futura o di oggi: aperto; passata: chiuso', () => {
    expect(isNoticeOpen({ deadline: daysFromNow(1) }, NOW)).toBe(true);
    expect(isNoticeOpen({ deadline: daysFromNow(0) }, NOW)).toBe(true);
    expect(isNoticeOpen({ deadline: daysFromNow(-1) }, NOW)).toBe(false);
  });

  it('senza scadenza vale la soglia dei 60 giorni, senza alcuna data e\' chiuso', () => {
    expect(isNoticeOpen({ publishedIso: daysFromNow(-30) }, NOW)).toBe(true);
    expect(isNoticeOpen({ publishedIso: daysFromNow(-90) }, NOW)).toBe(false);
    expect(isNoticeOpen({}, NOW)).toBe(false);
  });
});

describe('dropAttachmentsOfPublishedNotices', () => {
  it('tiene il bando e scarta capitolato e mansionari dello stesso giro', () => {
    const date = daysFromNow(-10);
    const kept = dropAttachmentsOfPublishedNotices([
      { title: 'Concorso per l\'assunzione di due operai/e comunali', kind: 'job', date },
      { title: 'Mansionario concorso assunzione operaio comunale', kind: 'attachment', date },
      { title: 'Concorso impiegato - capitolato', kind: 'attachment', date: daysFromNow(-9) },
    ]);
    expect(kept.map((notice) => notice.kind)).toEqual(['job']);
  });

  it('senza date un bando basta a scartare gli allegati', () => {
    const kept = dropAttachmentsOfPublishedNotices([
      { title: 'Concorso generale per ausiliari/e di pulizia', kind: 'job', date: '' },
      { title: 'Capitolato di concorso generale addetti di pulizia', kind: 'attachment', date: '' },
    ]);
    expect(kept).toHaveLength(1);
  });

  it('tiene il capitolato quando e\' l\'unico documento pubblicato', () => {
    const notices = [{ title: 'Capitolato di concorso per la nomina di un montatore', kind: 'attachment', date: daysFromNow(-10) }];
    expect(dropAttachmentsOfPublishedNotices(notices)).toEqual(notices);
  });
});

describe('parseAssoloListing — le skin reali', () => {
  const view = { baseUrl: ESEMPIO.listing.url, fric: '4925', catParam: 'param_cat0', catId: '72' };
  const form = (inner: string, selected = '72') => `<html><body><form name="fric_4925">
    <select name="fric_4925_cat0"><option value="0">Tutte</option>
    <option value="${selected}" selected="selected">Concorsi</option></select>${inner}</form></body></html>`;

  it('skin ogg_liste_data: la data non si fonde col peso del file', () => {
    const date = numericDate(daysFromNow(-10));
    const parsed = parseAssoloListing(form(`<div class="liste_div"><table><tr><td colspan="2">
      <a href="Concorso-impiegato-bando-14e5fc00?i=1" target="_blank">Concorso impiegato - bando</a></td></tr>
      <tr><td><div class="ogg_liste_data">${date}</div></td><td><div class="ogg_doc_peso">98 kB</div></td></tr></table></div>`), view);
    expect(parsed.recognized).toBe(true);
    expect(parsed.rows).toEqual([{
      title: 'Concorso impiegato - bando',
      url: 'https://www.esempio.ch/Concorso-impiegato-bando-14e5fc00?i=1',
      date: daysFromNow(-10),
    }]);
  });

  it('skin ObjListData con data sopra il link', () => {
    const date = numericDate(daysFromNow(-3));
    const parsed = parseAssoloListing(form(`<div class="Item1Col ItemDoc"><table><tr><td><div class="ObjListData">${date}</div></td></tr>
      <tr><td><a href="Concorso-operaio-bd7dd800?i=1" class="ObjListDocLink">Concorso operaio comunale</a></td></tr></table></div>`), view);
    expect(parsed.rows[0]).toMatchObject({ title: 'Concorso operaio comunale', date: daysFromNow(-3) });
  });

  it('skin a scheda: titolo nell\'h3 e link vuoto', () => {
    const date = numericDate(daysFromNow(-3));
    const parsed = parseAssoloListing(form(`<div class="ItemDoc"><table><tr><td><h3>Concorso per l'assunzione di un tecnico</h3></td></tr>
      <tr><td><div>${date}</div></td></tr><tr><td class="LinkOverAll"><a href="Concorso-tecnico-c250ac00?i=1"><img src="x.gif"/></a></td></tr></table></div>`), view);
    expect(parsed.rows[0].title).toBe("Concorso per l'assunzione di un tecnico");
  });

  it('skin con data in lettere', () => {
    const date = daysFromNow(-3);
    const parsed = parseAssoloListing(form(`<div class="Item3Col"><div>Avvisi, Concorsi</div><div>${italianDate(date)}</div>
      <a href="Capitolato-di-concorso-5b559300?i=1">Capitolato di concorso per un tecnico</a></div>`), view);
    expect(parsed.rows[0].date).toBe(date);
  });

  it('downdoc.php conta come documento, la paginazione no', () => {
    const parsed = parseAssoloListing(form(`<a href="downdoc.php?id_doc=4527&amp;lng=1&amp;i=1&amp;vis=2">Concorso per la nomina di un tecnico</a>
      <a href="Albo-comunale-c3dfab00?ris_pg=2&amp;i=1">2</a>`), view);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.hasNextPage).toBe(true);
  });

  it.each([
    'Nessun documento trovato...', 'Nessun documento attualmente', 'Nessun documento trvato',
    'Documenti presenti: 0', 'Documenti: 0', '0 documenti trovati', 'Nessun concorso attualmente.',
  ])('riconosce lo stato vuoto: %s', (marker) => {
    expect(parseAssoloListing(form(`<div>${marker}</div>`), view)).toMatchObject({ recognized: true, empty: true, rows: [] });
  });

  it('una categoria confermata senza righe e\' vuota anche senza scritta', () => {
    expect(parseAssoloListing(form('<div>Concorsi</div>'), view)).toMatchObject({ recognized: true, empty: true });
  });

  it('una pagina irriconoscibile non e\' un albo vuoto', () => {
    expect(parseAssoloListing('<html><body>manutenzione</body></html>', view).recognized).toBe(false);
    const { catParam, catId, ...withoutFilter } = view;
    expect(parseAssoloListing(form('<div>layout nuovo</div>'), withoutFilter).recognized).toBe(false);
  });

  it('un filtro ignorato dal sito non passa per la categoria', () => {
    const parsed = parseAssoloListing(form('<a href="Doc-14e5fc00?i=1">Concorso operaio</a>', '71'), view);
    expect(parsed.recognized).toBe(false);
  });

  it('costruisce le due viste GET', () => {
    const category = new URL(assoloListingUrl(ESEMPIO.listing, { category: true }));
    expect(category.searchParams.get('param_cat0')).toBe('72');
    expect(category.searchParams.get('fric')).toBe('4925');
    const menu = new URL(assoloListingUrl({ url: ESEMPIO.listing.url, fric: '6342', catinv: '72' }, { category: true }));
    expect(menu.searchParams.get('catinv')).toBe('72');
    const search = new URL(assoloListingUrl(ESEMPIO.listing, { text: 'concorso' }));
    expect(search.searchParams.get('param_textsearch')).toBe('concorso');
    expect(search.searchParams.get('param_cat0')).toBe('0');
  });
});

describe('parseDedicatedPage e rendered-cityos', () => {
  it('legge i PDF del contenitore dichiarato', () => {
    const html = `<html><body><main><h1>Concorsi</h1><a href="/wp-content/uploads/concorso.pdf">Concorso per l'assunzione di un tecnico</a></main>
      <footer><a href="/privacy.pdf">Privacy</a></footer></body></html>`;
    const parsed = parseDedicatedPage(html, { baseUrl: 'https://esempio.ch/concorsi/', containerSelector: 'main', marker: 'Concorsi' });
    expect(parsed.rows.map((row) => row.url)).toEqual(['https://esempio.ch/wp-content/uploads/concorso.pdf']);
  });

  it('senza contenitore o marcatore la pagina non e\' riconosciuta', () => {
    expect(parseDedicatedPage('<body><main>altro</main></body>', { baseUrl: 'https://esempio.ch/', containerSelector: 'main', marker: 'Concorsi' }).recognized).toBe(false);
    expect(parseDedicatedPage('<body></body>', { baseUrl: 'https://esempio.ch/', containerSelector: 'main' }).recognized).toBe(false);
  });

  it('legge lista e scheda renderizzate da CityOS', () => {
    const date = daysFromNow(-5);
    const list = parseCityOsList(`<section id="dataSmartAppConcorsi" class="entry-content"><div class="news-item">
      <div class="news-date">${date.split('-').reverse().join('/')}</div><h3>Concorso permanente Istituti sociali</h3>
      <a href="/concorsi-singolo?concorsi=SICNT-1">Continua a leggere</a></div></section>`, { baseUrl: 'https://www.esempio.ch/concorsi/' });
    expect(list.rows).toEqual([{ title: 'Concorso permanente Istituti sociali', date, url: 'https://www.esempio.ch/concorsi-singolo?concorsi=SICNT-1' }]);
    expect(parseCityOsDetail('<main><a href="https://cdn.esempio.ch/a.pdf">Concorso permanente.pdf</a></main>', { baseUrl: 'https://www.esempio.ch/' }))
      .toEqual([{ title: 'Concorso permanente', url: 'https://cdn.esempio.ch/a.pdf' }]);
  });

  it('riconosce un PDF col percorso: maiuscole e query string comprese', () => {
    expect(parseCityOsDetail('<main><a href="/bando.PDF?download=1">Bando</a><a href="/altro.html">Altro</a></main>', { baseUrl: 'https://www.esempio.ch/' }))
      .toEqual([{ title: 'Bando', url: 'https://www.esempio.ch/bando.PDF?download=1' }]);
    expect(isPdfHref('/bando.pdf#pagina', 'https://esempio.ch/')).toBe(true);
    expect(isPdfHref('/pdf/indice.html', 'https://esempio.ch/')).toBe(false);
  });

  it('un elenco ancora in caricamento non e\' un elenco vuoto', () => {
    expect(parseCityOsList('<section id="dataSmartAppConcorsi" class="loading"></section>', { baseUrl: 'https://esempio.ch/' }).recognized).toBe(false);
  });
});

describe('createPoliteClient — robots.txt e Crawl-delay', () => {
  function harness(robots: string, { robotsStatus = 200 } = {}) {
    const calls: string[] = [];
    const sleeps: number[] = [];
    let clockMs = 1_000_000;
    const fetchImpl = async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith('/robots.txt')) return new Response(robots, { status: robotsStatus });
      return new Response('ok', { status: 200 });
    };
    const client = createPoliteClient({
      fetchImpl: fetchImpl as typeof fetch,
      clock: () => clockMs,
      sleep: async (ms: number) => { sleeps.push(ms); clockMs += ms; },
    });
    return { client, calls, sleeps };
  }

  it('non tocca un path vietato e non lo ritenta', async () => {
    const { client, calls } = harness('User-agent: *\nDisallow: /files/\n');
    await expect(client.fetch('https://esempio.ch/files/bando.pdf')).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(calls).toEqual(['https://esempio.ch/robots.txt']);
  });

  it('rispetta il divieto per estensione', async () => {
    const { client } = harness('User-agent: *\nDisallow: /*.pdf$\n');
    expect((await client.canFetch('https://esempio.ch/a.pdf')).allowed).toBe(false);
    expect((await client.canFetch('https://esempio.ch/a.html')).allowed).toBe(true);
  });

  it('distanzia le richieste secondo il Crawl-delay dichiarato', async () => {
    const { client, sleeps } = harness('User-agent: *\nDisallow: /pleaseDontIndex/\nCrawl-delay: 30\n');
    await client.fetch('https://esempio.ch/uno');
    await client.fetch('https://esempio.ch/due');
    await client.fetch('https://esempio.ch/tre');
    expect(sleeps.filter((ms) => ms >= 30_000)).toEqual([30_000, 30_000]);
  });

  it('senza Crawl-delay applica comunque una pausa per host', async () => {
    const { client, sleeps } = harness('User-agent: *\nDisallow: /x/\n');
    await client.fetch('https://esempio.ch/uno');
    await client.fetch('https://esempio.ch/due');
    expect(sleeps.at(-1)).toBeGreaterThanOrEqual(5_000);
  });

  it('robots.txt irraggiungibile: nessuna lettura in questo giro', async () => {
    const { client, calls } = harness('', { robotsStatus: 503 });
    await expect(client.fetch('https://esempio.ch/uno')).rejects.toThrow(/irraggiungibile/);
    expect(calls).toEqual(['https://esempio.ch/robots.txt']);
  });

  it('due letture contemporanee chiedono robots.txt una volta sola', async () => {
    const { client, calls } = harness('User-agent: *\nDisallow: /x/\n');
    await Promise.all([client.canFetch('https://esempio.ch/uno'), client.canFetch('https://esempio.ch/due')]);
    expect(calls).toEqual(['https://esempio.ch/robots.txt']);
  });

  it('robots.txt assente (404): nessuna restrizione', async () => {
    const { client } = harness('', { robotsStatus: 404 });
    await expect(client.fetch('https://esempio.ch/uno')).resolves.toBeInstanceOf(Response);
  });
});

describe('extractPdfJobContentFromUrl con proxyRescue:false', () => {
  it('un 403 resta un 403: nessun tentativo verso il proxy', async () => {
    let proxied = 0;
    const result = await extractPdfJobContentFromUrl('https://esempio.ch/a.pdf', {
      fetchImpl: (async () => new Response('', { status: 403 })) as unknown as typeof fetch,
      jinaFetchImpl: (async () => { proxied += 1; return new Response('testo'); }) as unknown as typeof fetch,
      proxyRescue: false,
    });
    expect(result.extractionFailed).toBe(true);
    expect(result.error).toMatch(/HTTP 403/);
    expect(proxied).toBe(0);
  });
});

describe('fetchTicinoComuneJobs — dal listino agli annunci', () => {
  type Doc = { text?: string; pdf?: Record<string, unknown> };

  function run({
    rows,
    docs,
    existingJobs = [],
    listingStatus = 200,
    disallowed = [] as string[],
    searchBroken = false,
    nextPageLink = '',
  }: {
    rows: string;
    docs: Record<string, Doc>;
    existingJobs?: unknown[];
    listingStatus?: number;
    disallowed?: string[];
    searchBroken?: boolean;
    nextPageLink?: string;
  }) {
    const opened: string[] = [];
    const client = {
      reserve: async () => 0,
      canFetch: async (url: string) => ({
        allowed: !disallowed.some((path) => url.includes(path)),
        rule: null,
        crawlDelay: null,
      }),
      fetch: async (url: string) => new Response(
        searchBroken && url.includes('param_textsearch=concorso')
          ? '<html><body>formato inatteso</body></html>'
          : `<html><body>${nextPageLink}<form name="fric_4925"><select name="fric_4925_cat0"><option value="72" selected="selected">Concorsi</option></select>${rows}${nextPageLink ? `<a href="Albo?ris_pg=${new URL(url).searchParams.get('ris_pg') === '1' ? 2 : Number(new URL(url).searchParams.get('ris_pg')) + 1}">oltre</a>` : ''}</form></body></html>`,
        { status: listingStatus },
      ),
    };
    const extractPdf = async (url: string) => {
      opened.push(url);
      const doc = Object.entries(docs).find(([name]) => url.includes(name))?.[1];
      if (doc?.pdf) return doc.pdf;
      return { text: doc?.text ?? '', rawText: doc?.text ?? '', totalPages: 2, httpStatus: 200 };
    };
    return fetchTicinoComuneJobs(ESEMPIO, {
      client: client as never,
      extractPdf: extractPdf as never,
      existingJobs: existingJobs as never,
      now: NOW,
    }).then((result) => ({ result, opened }));
  }

  const row = (slug: string, title: string, iso = daysFromNow(-5)) => `<div class="liste_div"><table><tr><td>
    <a href="${slug}?i=1">${title}</a></td></tr><tr><td><div class="ogg_liste_data">${numericDate(iso)}</div></td></tr></table></div>`;

  it('pubblica il bando aperto con i campi strutturati e il link ufficiale', async () => {
    const deadline = daysFromNow(15);
    const { result } = await run({
      rows: row('Concorso-impiegato-14e5fc00', "Concorso per l'assunzione di un/a impiegato/a amministrativo/a"),
      docs: { 'Concorso-impiegato': { text: bando('Il Municipio di Esempio', italianDate(deadline)) } },
    });
    const { jobs } = result as { jobs: Record<string, unknown>[] };
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: 'Impiegato/a amministrativo/a',
      company: 'Comune di Esempio',
      companyKey: 'comuni-ticino',
      municipalityKey: 'comune-di-esempio',
      location: 'Esempio',
      canton: 'TI',
      postalCode: '6900',
      streetAddress: 'Via Municipio 1',
      addressCountry: 'CH',
      employmentType: 'FULL_TIME',
      datePosted: daysFromNow(-5),
      validThrough: deadline,
      url: 'https://www.esempio.ch/Concorso-impiegato-14e5fc00?i=1',
      applyUrl: 'https://www.esempio.ch/Concorso-impiegato-14e5fc00?i=1',
    });
    expect(String(jobs[0].description).split(/\s+/).length).toBeGreaterThanOrEqual(50);
    expect(jobs[0].description).toContain('Il Municipio di Esempio apre il concorso');
  });

  it('esclude il bando scaduto, quello di un altro ente e gli appalti', async () => {
    const { result, opened } = await run({
      rows: [
        row('Scaduto-14e5fc00', 'Concorso per un operaio comunale'),
        row('Consorzio-14e5fd00', "Concorso per l'assunzione di un apprendista"),
        row('Opere-14e5fe00', 'Concorso pubblico per opere da idraulico'),
      ].join(''),
      docs: {
        'Scaduto-14e5fc00': { text: bando('Il Municipio di Esempio', italianDate(daysFromNow(-2))) },
        'Consorzio-14e5fd00': { text: bando('La Delegazione consortile del Consorzio Acque', italianDate(daysFromNow(40))) },
      },
    });
    expect(isAuthoritativeEmptySnapshot(result)).toBe(true);
    expect(opened.some((url) => url.includes('Opere'))).toBe(false);
  });

  it('un PDF scansionato non si pubblica e non vale come albo vuoto', async () => {
    const { result } = await run({
      rows: row('Scan-14e5fc00', 'Concorso per un operaio comunale'),
      docs: { 'Scan-14e5fc00': { pdf: { extractionFailed: true, httpStatus: 200, error: 'PDF extraction failed: no text extracted' } } },
    });
    expect(result).toMatchObject({ jobs: [], fetchOutcome: 'filtered_empty', discoveredCount: 1 });
    expect(isAuthoritativeEmptySnapshot((result as { jobs: unknown[] }).jobs)).toBe(false);
  });

  it('un bando vietato da robots.txt non si scarica', async () => {
    const { result, opened } = await run({
      rows: row('Vietato-14e5fc00', 'Concorso per un operaio comunale'),
      docs: {},
      disallowed: ['Vietato'],
    });
    expect(opened).toEqual([]);
    expect(result).toMatchObject({ jobs: [], fetchOutcome: 'filtered_empty' });
  });

  it('un 403 sul listino resta un blocco: niente zero autorevole, niente aggiramento', async () => {
    const { result } = await run({ rows: '', docs: {}, listingStatus: 403 });
    expect(result).toEqual({ jobs: [], fetchOutcome: 'anti_bot_block' });
  });

  it('un albo vuoto dichiarato dal sito e\' uno zero autorevole', async () => {
    const { result } = await run({ rows: '<div>Nessun documento trovato...</div>', docs: {} });
    expect(isAuthoritativeEmptySnapshot(result)).toBe(true);
  });

  it('tredici bandi aperti entrano tutti', async () => {
    const slugs = Array.from({ length: 13 }, (_, index) => `Bando-${index}-14e5fc0${index.toString(16)}`);
    const { result } = await run({
      rows: slugs.map((slug, index) => row(slug, `Concorso per un operaio comunale numero ${index}`)).join(''),
      docs: Object.fromEntries(slugs.map((slug) => [slug, { text: bando('Il Municipio di Esempio', italianDate(daysFromNow(15))) }])),
    });
    expect((result as { jobs: unknown[] }).jobs).toHaveLength(13);
  });

  it('un albo che continua oltre l\'ultima pagina letta non e\' un esito pieno', async () => {
    const { result } = await run({
      rows: row('Bando-14e5fc00', 'Concorso per un operaio comunale'),
      docs: { 'Bando-14e5fc00': { text: bando('Il Municipio di Esempio', italianDate(daysFromNow(15))) } },
      nextPageLink: ' ',
    });
    expect(result).toMatchObject({ fetchOutcome: 'selector_miss' });
    expect((result as { jobs: unknown[] }).jobs).toHaveLength(1);
  });

  it('una ricerca illeggibile non invalida una categoria confermata', async () => {
    const { result } = await run({ rows: '<div>Nessun documento trvato</div>', docs: {}, searchBroken: true });
    expect(isAuthoritativeEmptySnapshot(result)).toBe(true);
  });

  it('un bando gia\' letto non si riscarica', async () => {
    const url = 'https://www.esempio.ch/Noto-14e5fc00?i=1';
    const { opened, result } = await run({
      rows: row('Noto-14e5fc00', 'Concorso per un operaio comunale'),
      docs: {},
      existingJobs: [{ url, description: bando('Il Municipio di Esempio', italianDate(daysFromNow(15))) }],
    });
    expect(opened).toEqual([]);
    expect((result as { jobs: unknown[] }).jobs).toHaveLength(1);
  });
});

describe('fetchAllTicinoComuniJobs — un Comune guasto non ferma gli altri', () => {
  const comuni = ['uno', 'due', 'tre'].map((slug) => ({ ...ESEMPIO, key: `comune-di-${slug}`, company: `Comune di ${slug}` }));
  const job = (key: string) => ({ id: key, company: key });

  function fetchComuneFrom(results: Record<string, unknown>) {
    return async (entry: { key: string }) => {
      const result = results[entry.key];
      if (result instanceof Error) throw result;
      return result;
    };
  }
  const provenEmpty = () => {
    const jobs: unknown[] = [];
    Object.defineProperties(jobs, {
      authoritativeEmptyState: { value: 'authoritative-source-zero' },
      authoritativeEmptyEvidence: { value: 'albo vuoto' },
    });
    return jobs;
  };
  const run = (results: Record<string, unknown>, existingJobs: unknown[] = []) => fetchAllTicinoComuniJobs({
    existingJobs: existingJobs as never,
    comuni: comuni as never,
    fetchComune: fetchComuneFrom(results) as never,
    client: {} as never,
    extractPdf: (async () => ({})) as never,
    renderer: {} as never,
    now: NOW,
  });

  it('somma gli annunci quando tutti i Comuni sono letti', async () => {
    const result = await run({
      'comune-di-uno': { jobs: [job('a')], fetchOutcome: 'ok', discoveredCount: 1 },
      'comune-di-due': provenEmpty(),
      'comune-di-tre': { jobs: [job('b')], fetchOutcome: 'ok', discoveredCount: 1 },
    });
    expect(result).toMatchObject({ fetchOutcome: 'ok' });
    expect((result as { jobs: unknown[] }).jobs).toHaveLength(2);
  });

  it('un Comune guasto rende l\'esito non pieno e conserva i suoi annunci', async () => {
    const stored = { url: 'https://esempio.ch/due.pdf', municipalityKey: 'comune-di-due' };
    const other = { url: 'https://esempio.ch/uno.pdf', municipalityKey: 'comune-di-uno' };
    const result = await run({
      'comune-di-uno': { jobs: [job('a')], fetchOutcome: 'ok', discoveredCount: 1 },
      'comune-di-due': { jobs: [], fetchOutcome: 'connection_error' },
      'comune-di-tre': new Error('rete'),
    }, [stored, other]);
    expect(result).toMatchObject({ fetchOutcome: 'connection_error' });
    const { jobs } = result as { jobs: unknown[] };
    expect(jobs).toContainEqual(stored);
    expect(jobs).not.toContainEqual(other);
  });

  it('lo zero della famiglia e\' autorevole solo se ogni Comune ha provato il proprio', async () => {
    expect(isAuthoritativeEmptySnapshot(await run({
      'comune-di-uno': provenEmpty(), 'comune-di-due': provenEmpty(), 'comune-di-tre': provenEmpty(),
    }))).toBe(true);

    const partial = await run({
      'comune-di-uno': provenEmpty(),
      'comune-di-due': { jobs: [], fetchOutcome: 'anti_bot_block' },
      'comune-di-tre': provenEmpty(),
    });
    expect(isAuthoritativeEmptySnapshot(partial)).toBe(false);
    expect(partial).toMatchObject({ jobs: [], fetchOutcome: 'anti_bot_block' });
  });

  it('tutti i Comuni guasti non sono un albo vuoto', async () => {
    const result = await run({
      'comune-di-uno': new Error('rete'), 'comune-di-due': new Error('rete'), 'comune-di-tre': new Error('rete'),
    });
    expect(result).toMatchObject({ jobs: [], fetchOutcome: 'connection_error' });
  });
});

describe('dropExpiredStoredJobs', () => {
  it('toglie i concorsi scaduti dai job memorizzati', () => {
    const jobs = [
      { id: 'a', validThrough: daysFromNow(-1) },
      { id: 'b', validThrough: daysFromNow(1) },
      { id: 'c' },
    ];
    expect(dropExpiredStoredJobs(jobs, NOW).map((job) => job.id)).toEqual(['b', 'c']);
  });
});

describe('registro dei Comuni — copertura dichiarata', () => {
  const registry = loadTicinoComuniRegistry();
  const municipalities: string[] = JSON.parse(
    readFileSync(resolve(ROOT, 'data/canton-municipalities.json'), 'utf8'),
  ).cantons.TI.municipalities;
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'data/crawler-manifest.json'), 'utf8')).manifest;
  const covered = coveredTicinoComuni(registry);

  it('ogni Comune ticinese ha una riga, nessuna di troppo', () => {
    expect(registry.comuni.map((entry: { municipality: string }) => entry.municipality).sort())
      .toEqual([...municipalities].sort());
  });

  it('ogni riga dichiara uno stato, e chi non e\' coperto dice perche\'', () => {
    for (const entry of registry.comuni) {
      expect(['covered', 'existing', 'missing'], entry.municipality).toContain(entry.status);
      if (entry.status === 'existing') {
        expect(manifest.some((item: { slug: string }) => item.slug === entry.crawler), entry.municipality).toBe(true);
      }
      if (entry.status === 'missing') {
        expect(String(entry.reason || '').length, entry.municipality).toBeGreaterThan(15);
      }
    }
  });

  it('la famiglia e\' una sola voce del manifest, senza validatore URL fuori dal Crawl-delay', () => {
    const entry = manifest.find((item: { slug: string }) => item.slug === TICINO_COMUNI_KEY);
    expect(entry).toBeTruthy();
    expect(existsSync(resolve(ROOT, `scripts/update-${TICINO_COMUNI_KEY}-jobs.mjs`))).toBe(true);
    const housekeeping = entry.postSteps.find((step: { name: string }) => step.name.startsWith('Housekeeping'));
    expect(housekeeping.env.JOBS_SKIP_URL_VALIDATION).toBe('1');
    expect(entry.prepSteps.some((step: { run?: string }) => /playwright install/.test(step.run || ''))).toBe(true);
  });

  it('ogni Comune coperto ha sede e datore completi', () => {
    for (const entry of covered) {
      expect(entry.key, entry.municipality).toMatch(/^comune-di-[a-z0-9-]+$/);
      expect(entry.company, entry.key).toBe(`Comune di ${entry.municipality}`);
      expect(entry.postalCode, entry.key).toMatch(/^6\d{3}$/);
      expect(entry.streetAddress, entry.key).toBeTruthy();
      expect(entry.listing.url, entry.key).toMatch(/^https:\/\//);
      expect(['assolo', 'page', 'rendered-cityos'], entry.key).toContain(entry.listing.type);
      expect(isTrustedComuneUrl(entry, entry.listing.url), entry.key).toBe(true);
    }
  });

  it('nessun doppione con i crawler comunali dedicati', () => {
    const existing = registry.comuni.filter((entry: { status: string }) => entry.status === 'existing');
    const names = new Set(covered.map((entry: { municipality: string }) => entry.municipality));
    for (const entry of existing) expect(names.has(entry.municipality), entry.municipality).toBe(false);
    expect(existing.map((entry: { crawler: string }) => entry.crawler).sort())
      .toEqual(['citta-di-bellinzona', 'citta-di-locarno', 'citta-di-lugano', 'mendrisio']);
  });

  it('il dominio affidabile non accetta sosia ne\' http', () => {
    const entry = { domain: 'esempio.ch' };
    expect(isTrustedComuneUrl(entry, 'https://www.esempio.ch/a.pdf')).toBe(true);
    expect(isTrustedComuneUrl(entry, 'https://esempio.ch.evil.test/a.pdf')).toBe(false);
    expect(isTrustedComuneUrl(entry, 'http://www.esempio.ch/a.pdf')).toBe(false);
  });
});
