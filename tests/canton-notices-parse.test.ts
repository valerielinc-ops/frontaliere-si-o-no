import { describe, expect, it } from 'vitest';
import {
  cleanTitle,
  findDates,
  isUsableTitle,
  normalizePublishedAt,
  parseBeNewsApi,
  parseFeed,
  parseHtmlLinks,
  parseJsonEntities,
  parseZhNewsJson,
} from '../scripts/lib/canton-notices-parse.mjs';

// `now` esplicito: i parser confrontano le date con l'ora passata, non con
// l'orologio di sistema, quindi il test non scade col calendario.
const NOW = Date.parse('2026-10-05T08:00:00Z');

describe('date', () => {
  it('riconosce ISO, dd.mm.yyyy, dd/mm/yy e mese per esteso in de/fr/it', () => {
    expect(findDates('Publiziert 2026-09-30T10:00:00+02:00').map((d) => d.value)).toEqual(['2026-09-30T08:00:00.000Z']);
    expect(findDates('17.02.2026 14:17').map((d) => d.value)).toEqual(['2026-02-17']);
    expect(findDates('29.08.-11.10.26: Bauarbeiten').map((d) => d.value)).toEqual(['2026-10-11']);
    expect(findDates('1er octobre 2026').map((d) => d.value)).toEqual(['2026-10-01']);
    expect(findDates('24. Sep 2026').map((d) => d.value)).toEqual(['2026-09-24']);
    expect(findDates('Freitag, 2. Oktober 2026').map((d) => d.value)).toEqual(['2026-10-02']);
    expect(findDates('30 settembre 2026').map((d) => d.value)).toEqual(['2026-09-30']);
  });

  it('scarta date impossibili invece di correggerle', () => {
    expect(findDates('31.02.2026')).toEqual([]);
    expect(findDates('2026-13-01')).toEqual([]);
  });

  it('una data nel futuro non e\' una data di pubblicazione (chiusura stradale, evento)', () => {
    expect(normalizePublishedAt('15.10.2026', { now: NOW })).toBeNull();
    expect(normalizePublishedAt('04.10.2026', { now: NOW })).toBe('2026-10-04');
  });

  it('pubDate RFC 822 e dd.mm.yyyy non vengono letti all\'americana', () => {
    expect(normalizePublishedAt('Fri, 02 Oct 2026 10:00:00 +0200', { now: NOW })).toBe('2026-10-02T08:00:00.000Z');
    expect(normalizePublishedAt('04.10.2026', { now: NOW })).toBe('2026-10-04');
    expect(normalizePublishedAt('', { now: NOW })).toBeNull();
    expect(normalizePublishedAt(null, { now: NOW })).toBeNull();
  });
});

describe('titoli', () => {
  it('toglie inviti all\'azione e involucri «Lire la suite»', () => {
    expect(cleanTitle('Lire la suite de « Primes 2027 dans l’assurance-maladie »')).toBe('Primes 2027 dans l’assurance-maladie');
    expect(cleanTitle('mehr erfahren: 13. AHV-Rente ab Dezember 2026')).toBe('13. AHV-Rente ab Dezember 2026');
    expect(cleanTitle('Einteilung Steuerkreise (PDF, 10 Seiten, 363 KB)')).toBe('Einteilung Steuerkreise');
  });

  it('rifiuta CTA, date sole e testi troppo corti', () => {
    for (const t of ['Mehr erfahren', 'weiterlesen', 'En savoir plus', 'mer 30 sep', '24.09.2026', 'arrow_right_alt', 'Jetzt ansehen', 'Info']) {
      expect(isUsableTitle(cleanTitle(t)), t).toBe(false);
    }
    expect(isUsableTitle('Quellensteuertarife 2026')).toBe(true);
  });
});

describe('parseHtmlLinks', () => {
  const page = 'https://www.example-kanton.ch/aktuell/';

  it('tiene solo i link che combaciano con il pattern curato e prende titolo e data della card', () => {
    const html = `
      <nav><a href="/aktuell/detail/nav-voce">Voce di menu molto lunga che non e' un avviso</a></nav>
      <div class="card"><h3><a href="/aktuell/detail/steuern-2026">Steuern: Informationen für 2026</a></h3>
        <time datetime="2026-09-30">30.09.2026</time><a href="/aktuell/detail/steuern-2026">mehr erfahren</a></div>
      <div class="card"><h3><a href="/aktuell/detail/sperrung">Strassensperrung Walzenhausen</a></h3>
        <time>14.10.2026</time></div>
      <a href="/kontakt">Kontakt und Öffnungszeiten der Verwaltung</a>`;
    const { items } = parseHtmlLinks(html, { pageUrl: page, linkPattern: '^/aktuell/detail/[^/?#]+', now: NOW });
    expect(items.map((i) => [i.title, i.publishedAt])).toEqual([
      ['Steuern: Informationen für 2026', '2026-09-30'],
      // 14.10.2026 e' la data della chiusura, non della pubblicazione
      ['Strassensperrung Walzenhausen', null],
    ]);
    expect(items[0].url).toBe('https://www.example-kanton.ch/aktuell/detail/steuern-2026');
  });

  it('card avvolta dal link: titolo = primo blocco, non titolo + etichetta + teaser', () => {
    const html = `<a class="search-result" href="/medienmitteilungen/2026-vorschau">
      <div class="font-bold">Vorschau auf die Oktobersession des Grossen Rates</div>
      <div>Grosser Rat</div><div>Der Grosse Rat beschliesst am 14. und 21. Oktober über …</div>
      <div class="text-xs">02.10.2026 – 10:00 Uhr</div></a>`;
    const { items } = parseHtmlLinks(html, { pageUrl: 'https://www.bs.ch/medien/', linkPattern: '^/medienmitteilungen/20\\d\\d-', now: NOW });
    expect(items).toEqual([{ title: 'Vorschau auf die Oktobersession des Grossen Rates', url: 'https://www.bs.ch/medienmitteilungen/2026-vorschau', publishedAt: '2026-10-02' }]);
  });

  it('link con solo «mehr erfahren»: il titolo arriva dall\'heading della card', () => {
    const html = `<div class="news"><h4>Einmalige zusätzliche Rentenzahlung 2026</h4><p>Teaser</p>
      <a href="/aktuelles/detail/rentenzahlung">mehr erfahren</a></div>`;
    const { items } = parseHtmlLinks(html, { pageUrl: 'https://www.pkar.ch/', linkPattern: '^/aktuelles/detail/', now: NOW });
    expect(items[0].title).toBe('Einmalige zusätzliche Rentenzahlung 2026');
  });

  it('rispetta <base href>, attributi con «>» e parametri di sola navigazione', () => {
    const html = `<head><base href="https://www.ostwind.ch/"></head>
      <a class="[&_>div]:aspect-h-2" href="about/news/neue-partnerschaft">Neue Partnerschaft im Ostwind</a>`;
    const a = parseHtmlLinks(html, { pageUrl: 'https://www.ostwind.ch/about/news/uebersicht/', linkPattern: '^/about/news/', now: NOW });
    expect(a.items[0].url).toBe('https://www.ostwind.ch/about/news/neue-partnerschaft');
    const vs = '<a href="/web/communication/detail?groupId=1&articleId=2&redirect=%2Fweb%2Fscc">Délai de traitement rallongé</a>';
    const b = parseHtmlLinks(vs, { pageUrl: 'https://www.vs.ch/web/scc/news', linkPattern: '^/web/communication/detail', dropParams: ['redirect'], now: NOW });
    expect(b.items[0].url).toBe('https://www.vs.ch/web/communication/detail?groupId=1&articleId=2');
  });

  it('altri host solo se dichiarati in linkHosts', () => {
    const html = '<a href="https://news.lu.ch/html_mail.jsp?id=0&mailref=abc">Ausgleich der kalten Progression 2027</a>';
    const opts = { pageUrl: 'https://steuern.lu.ch/', linkPattern: '^/html_mail\\.jsp', now: NOW };
    expect(parseHtmlLinks(html, opts).items).toEqual([]);
    expect(parseHtmlLinks(html, { ...opts, linkHosts: ['news.lu.ch'] }).items).toHaveLength(1);
  });

  it('senza pattern non estrae niente (fonte non curata)', () => {
    expect(parseHtmlLinks('<a href="/x/y">Titolo abbastanza lungo</a>', { pageUrl: page, now: NOW })).toMatchObject({ items: [], error: 'config' });
  });
});

describe('parseFeed', () => {
  it('RSS: titolo, link e pubDate; `<description/>` autochiuso non si mangia il primo item', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><description/>
      <item><title>Nouveau chef pour le Service des sports</title><link>https://www.ville-fribourg.ch/actualites/nouveau-chef</link>
      <description>&lt;p&gt;${'&amp;'.repeat(1200)}&lt;/p&gt;</description><pubDate>Fri, 02 Oct 2026 10:00:00 +0200</pubDate></item>
      <item><title>Fermeture des guichets</title><link>https://www.ville-fribourg.ch/actualites/fermeture</link><pubDate/></item>
      </channel></rss>`;
    const { items, error } = parseFeed(xml, { pageUrl: 'https://www.ville-fribourg.ch/actualites.rss', now: NOW });
    expect(error).toBeUndefined();
    expect(items).toEqual([
      { title: 'Nouveau chef pour le Service des sports', url: 'https://www.ville-fribourg.ch/actualites/nouveau-chef', publishedAt: '2026-10-02T08:00:00.000Z' },
      { title: 'Fermeture des guichets', url: 'https://www.ville-fribourg.ch/actualites/fermeture', publishedAt: null },
    ]);
  });

  it('Atom e quirk emptyPubDate', () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Gemeinderat heisst Budget 2027 gut</title>
      <link rel="alternate" href="https://www.kreuzlingen.ch/aktuelles/budget"/><updated>2026-10-01T21:58:15Z</updated></entry></feed>`;
    expect(parseFeed(atom, { pageUrl: 'https://www.kreuzlingen.ch/news-feed/atom.xml', now: NOW }).items[0]).toEqual({
      title: 'Gemeinderat heisst Budget 2027 gut',
      url: 'https://www.kreuzlingen.ch/aktuelles/budget',
      publishedAt: '2026-10-01T21:58:15.000Z',
    });
    expect(parseFeed(atom, { pageUrl: 'https://www.kreuzlingen.ch/', emptyPubDate: true, now: NOW }).items[0].publishedAt).toBeNull();
  });

  it('una pagina HTML servita come feed e\' un errore di forma, non zero voci', () => {
    expect(parseFeed('<html><body>502</body></html>', { pageUrl: 'https://x.ch/rss', now: NOW }).error).toBe('shape');
  });
});

describe('fonti JSON', () => {
  it('data-entities (CMS i-web): titolo dal link, giorno da _datum', () => {
    const json = JSON.stringify({ data: [{ name: '<a href="/_rte/information/138682">Das Schweizerische Transparenzregister</a>', datum: '01.10.2026', _datum: '2026-10-01 07:58:00' }] });
    const html = `<table data-entities="${json.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></table>`;
    expect(parseJsonEntities(html, { pageUrl: 'https://www.nw.ch/aktuellesinformationen', now: NOW }).items).toEqual([
      { title: 'Das Schweizerische Transparenzregister', url: 'https://www.nw.ch/_rte/information/138682', publishedAt: '2026-10-01' },
    ]);
  });

  it('zh.ch: link relativo e data dd.mm.yyyy', () => {
    const body = JSON.stringify({ news: [{ title: 'Kanton rüstet sich für Trümmerrettung', date: '02.10.2026', type: 'Medienmitteilung', link: '/de/news-uebersicht/medienmitteilungen/2026/10/x.html' }] });
    expect(parseZhNewsJson(body, { pageUrl: 'https://www.zh.ch/de/news-uebersicht/_jcr_content.json', now: NOW }).items[0]).toMatchObject({
      url: 'https://www.zh.ch/de/news-uebersicht/medienmitteilungen/2026/10/x.html',
      publishedAt: '2026-10-02',
      meta: { type: 'Medienmitteilung' },
    });
  });

  it('be.ch: URL pubblico con newsID, topicTags, e le voci non ancora pubblicate restano fuori', () => {
    const item = (id: string, publishOn: string, title: string) =>
      `<item><id>${id}</id><publishOn>${publishOn}</publishOn><contentList><contentList><title>${title}</title><languageCode>de</languageCode></contentList></contentList><topicTags><topicTags>be-themen:strassen</topicTags></topicTags></item>`;
    const xml = `<Collection>${item('0e6dd467-0f85-4ee0-8bbc-cd178d272110', '2026-10-05T08:30:00', 'Neue Fahrzeugstrategie für die Verwaltung')}${item('a442dc99-e2f3-4858-bf5b-9c0dac0acf84', '2026-10-09T08:30:00', 'Embargo bis Freitag')}</Collection>`;
    const r = parseBeNewsApi(xml, { now: NOW });
    expect(r.items).toEqual([
      {
        title: 'Neue Fahrzeugstrategie für die Verwaltung',
        url: 'https://www.be.ch/de/start.html?newsID=0e6dd467-0f85-4ee0-8bbc-cd178d272110',
        publishedAt: '2026-10-05',
        meta: { topicTags: ['be-themen:strassen'] },
      },
    ]);
    expect(r.warnings[0]).toMatch(/non ancora pubblicate/);
  });
});
