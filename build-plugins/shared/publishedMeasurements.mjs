const FRONTALIERE_DETAIL_PATH_RX = /^\/articoli-frontaliere\/[^/]+\/?$/;

const NUMBER_LOCALE = Object.freeze({
  it: 'it-IT',
  en: 'en-GB',
  de: 'de-DE',
  fr: 'fr-FR',
});

const ARTICLE_COUNT_SCOPE = Object.freeze({
  it: 'URL italiane canoniche di dettaglio nella sezione Frontaliere; hub escluso',
  en: 'canonical Italian-language article detail URLs in the Frontaliere section; hub excluded',
  de: 'kanonische italienischsprachige Artikeldetail-URLs im Bereich Frontaliere; Hub ausgeschlossen',
  fr: 'URL canoniques des pages d’articles italiennes de la section Frontaliere ; hub exclu',
});

/** Count canonical Italian Frontaliere article detail paths, excluding hubs and archives. */
export function countItalianFrontaliereArticleDetails(values) {
  const paths = new Set();
  for (const value of values ?? []) {
    const raw = String(value ?? '').trim();
    if (!raw) continue;
    let pathname;
    try {
      pathname = raw.startsWith('/') ? raw.split(/[?#]/, 1)[0] : new URL(raw).pathname;
    } catch {
      continue;
    }
    if (FRONTALIERE_DETAIL_PATH_RX.test(pathname)) paths.add(pathname.replace(/\/$/, ''));
  }
  return paths.size;
}

/** Build the shared article-count measurement used by the page and llms family. */
export function articleCountMeasurement(values, now = new Date()) {
  return {
    count: countItalianFrontaliereArticleDetails(values),
    date: now.toISOString().slice(0, 10),
  };
}

/** Human-readable count, scope and measurement day for an article index. */
export function formatArticleCountEvidence(count, date, locale = 'it') {
  const number = Number(count).toLocaleString(NUMBER_LOCALE[locale] ?? NUMBER_LOCALE.it);
  const scope = ARTICLE_COUNT_SCOPE[locale] ?? ARTICLE_COUNT_SCOPE.it;
  const dayLabel = locale === 'it' ? 'conteggio al' : locale === 'fr' ? 'comptage au' : locale === 'de' ? 'gezählt am' : 'counted on';
  return `${number} — ${scope}; ${dayLabel} ${date}`;
}

/** Source and observation day to display next to a rate without repeating its value. */
export function formatExchangeRateAttribution(date, locale = 'it') {
  const labels = {
    it: `fonte TwelveData, snapshot Firestore · rilevato il ${date}`,
    en: `TwelveData source, Firestore snapshot · observed ${date}`,
    de: `Quelle TwelveData, Firestore-Snapshot · Stand ${date}`,
    fr: `source TwelveData, instantané Firestore · relevé le ${date}`,
  };
  return labels[locale] ?? labels.it;
}

/** Dated spot-rate evidence shared by rendered comparison copy and llms files. */
export function formatExchangeRateEvidence(rate, date, locale = 'it') {
  const number = Number(rate).toLocaleString(NUMBER_LOCALE[locale] ?? NUMBER_LOCALE.it, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
  return `1 CHF = ${number} EUR · ${formatExchangeRateAttribution(date, locale)}`;
}
