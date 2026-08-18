import { describe, expect, it } from 'vitest';

import {
  isTrackingParam,
  legacyNewsUrlKey,
  newsUrlKey,
} from '../../scripts/lib/news-url-key.mjs';

/**
 * `newsUrlKey` — l'identita' di un URL di fonte news.
 *
 * Gemello sul sito di `generator/scripts/lib/source-url-ledger.mjs` del corpus
 * (nanakokyobashi-rgb/frontaliere-articles#427).
 *
 * IL DIFETTO. `normalizeNewsUrl` buttava via l'intera query. Su una fonte che
 * identifica il documento SOLO li' ogni item del feed collassava sulla stessa
 * chiave: il primo articolo veniva registrato e tutti i successivi risultavano
 * «gia' usati», quindi scartati senza nessun segnale.
 *
 * PERCHE' IL TEST STA SU UN MODULO E NON SU create-article.mjs. Quel file e'
 * 11.675 righe e importarlo tira dentro mezza pipeline; queste funzioni sono
 * pure. E' anche la ragione per cui la logica e' stata estratta invece che
 * corretta sul posto.
 */
describe('newsUrlKey — la query che identifica il documento non si butta', () => {
  it('due comunicati ti.ch che differiscono SOLO per NEWS_ID sono due chiavi', () => {
    // IL CASO DEL DIFETTO, nella sua forma reale. Prima della fix entrambi
    // normalizzavano a `https://www4.ti.ch/it/dettaglio-comunicato`.
    const a = newsUrlKey('https://www4.ti.ch/it/dettaglio-comunicato/?NEWS_ID=101');
    const b = newsUrlKey('https://www4.ti.ch/it/dettaglio-comunicato/?NEWS_ID=102');
    expect(a).not.toBe(b);
    // E la vecchia forma li fondeva davvero: e' la riga che dimostra che il
    // difetto esisteva, non che il nuovo codice e' autocoerente.
    expect(legacyNewsUrlKey('https://www4.ti.ch/it/dettaglio-comunicato/?NEWS_ID=101'))
      .toBe(legacyNewsUrlKey('https://www4.ti.ch/it/dettaglio-comunicato/?NEWS_ID=102'));
  });

  it('uil.it: lo stesso id con nome-parametro di casing diverso e una chiave sola', () => {
    // Il NOME si minuscolizza (`ID_News` e `ID_NEWS` sono lo stesso feed)...
    expect(newsUrlKey('https://www.uil.it/newssx.asp?ID_News=55'))
      .toBe(newsUrlKey('https://www.uil.it/newssx.asp?ID_NEWS=55'));
  });

  it('il VALORE non si minuscolizza: un id base64 non va fuso col suo omonimo', () => {
    // ...il VALORE no: un id puo' essere base64 o un hashid, e appiattirlo
    // fonderebbe due documenti diversi — la stessa direzione di rischio che
    // questa fix esiste per togliere.
    expect(newsUrlKey('https://ex.com/n?id=AbC')).not.toBe(newsUrlKey('https://ex.com/n?id=abc'));
  });

  it('i marcatori di tracciamento spariscono, e la chiave torna quella storica', () => {
    // LA PROPRIETA' DI COMPATIBILITA', che e' cio' che rende la fix non
    // distruttiva: se dopo il filtro non resta nessun parametro identificante,
    // il risultato e' IDENTICO a `legacyNewsUrlKey`. Le voci gia' scritte per
    // URL senza query — la stragrande maggioranza — non si spostano affatto.
    const sporco = 'https://ex.com/a/b/?utm_source=nl&fbclid=xyz&ref=twitter';
    expect(newsUrlKey(sporco)).toBe('https://ex.com/a/b');
    expect(newsUrlKey(sporco)).toBe(legacyNewsUrlKey(sporco));
    expect(newsUrlKey('https://ex.com/a/b/')).toBe(legacyNewsUrlKey('https://ex.com/a/b/'));
  });

  it('un parametro senza valore non identifica niente e non entra nella chiave', () => {
    // Tenerlo renderebbe `?id=` diverso dallo stesso URL senza il parametro,
    // cioe' romperebbe il dedup senza guadagnare identita'.
    expect(newsUrlKey('https://ex.com/a/b?id=')).toBe(newsUrlKey('https://ex.com/a/b'));
  });

  it('l ordine dei parametri nella query non cambia la chiave', () => {
    expect(newsUrlKey('https://ex.com/n?b=2&a=1')).toBe(newsUrlKey('https://ex.com/n?a=1&b=2'));
  });

  it('la query XML-escapata degli item RSS viene decodificata prima di parsare', () => {
    // Senza il passaggio `&amp;` → `&` il secondo parametro si chiamerebbe
    // `amp;p` e la chiave divergerebbe da quella dello stesso URL non escapato.
    expect(newsUrlKey('https://ex.com/n?id=7&amp;p=2')).toBe(newsUrlKey('https://ex.com/n?id=7&p=2'));
  });

  it('un input non parsabile come URL non esplode e resta stabile', () => {
    expect(newsUrlKey('non-un-url/')).toBe('non-un-url');
    // Nullish → stringa vuota, non la parola "undefined" e non un throw. La
    // vecchia `normalizeNewsUrl` faceva `rawUrl.toLowerCase()` nel catch e su
    // un input nullo lanciava un TypeError dentro il ramo di recupero.
    expect(newsUrlKey(undefined as unknown as string)).toBe('');
    expect(legacyNewsUrlKey(undefined as unknown as string)).toBe('');
  });

  it('isTrackingParam copre le famiglie a prefisso, non solo i nomi esatti', () => {
    for (const n of ['utm_campaign', 'at_medium', 'pk_source', 'mtm_kwd', '_ga', '_gl']) {
      expect(isTrackingParam(n)).toBe(true);
    }
    for (const n of ['news_id', 'id_news', 'articleid', 'p']) {
      expect(isTrackingParam(n)).toBe(false);
    }
  });

  it('Google News: il locale non frammenta, perche l identita e tutta nel path', () => {
    // L ERRORE SPECULARE, che una fix sulla query rischia di introdurre mentre
    // ne toglie un altro. Gli URL del feed Google News portano
    // `?oc=5&hl=<locale>&gl=<paese>&ceid=<...>`, ma l articolo e' identificato
    // per intero dall id base64 nel path. Senza `hl`/`gl`/`ceid`/`oc` fra i
    // parametri da scartare, lo stesso pezzo ripreso con un locale diverso
    // darebbe due chiavi e potrebbe essere consumato due volte.
    const it = 'https://news.google.com/rss/articles/CBMiXYZ?oc=5&hl=it-IT&gl=IT&ceid=IT:it';
    const de = 'https://news.google.com/rss/articles/CBMiXYZ?oc=5&hl=de-CH&gl=CH&ceid=CH:de';
    expect(newsUrlKey(it)).toBe(newsUrlKey(de));
    // E la chiave coincide con quella storica, quindi le 27 voci
    // `news.google.com` gia' nei ledger continuano a corrispondere senza
    // passare dal ponte di compatibilita'.
    expect(newsUrlKey(it)).toBe(legacyNewsUrlKey(it));
  });

  it('un separatore codificato nel valore non collassa due documenti', () => {
    // `searchParams` consegna i valori DECODIFICATI. Re-inserirli grezzi
    // farebbe rientrare un `%26` come separatore vero, e questi due URL —
    // che sono due documenti — finirebbero sulla stessa chiave.
    const uno = newsUrlKey('https://ex.com/n?id=1%26p%3D2');
    const due = newsUrlKey('https://ex.com/n?id=1&p=2');
    expect(uno).not.toBe(due);
    expect(uno).toBe('https://ex.com/n?id=1%26p%3D2');
    expect(due).toBe('https://ex.com/n?id=1&p=2');
  });

  it('le due forme trattano allo stesso modo un input malformato', () => {
    // Il pre-decode di `&amp;` sta in entrambe: sul ramo catch la stringa
    // grezza entra nella chiave, e una sola delle due che decodifica
    // produrrebbe chiavi diverse per lo stesso input.
    const rotto = 'non-un-url?a=1&amp;b=2';
    expect(newsUrlKey(rotto)).toBe(legacyNewsUrlKey(rotto));
    expect(newsUrlKey(rotto)).not.toContain('&amp;');
  });
});
