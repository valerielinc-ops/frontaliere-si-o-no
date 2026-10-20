import { EVENT_DESCRIPTION_LOCALES } from './event-description-policy.mjs';

const FALLBACK_FACT_FIELDS = Object.freeze([
  'venue',
  'comune',
  'canton',
  'category',
  'organizer',
  'performer',
  'startDate',
  'startTime',
  'price',
]);

const FALLBACK_FACT_LABELS = Object.freeze({
  it: { venue: 'luogo', comune: 'comune', canton: 'cantone', category: 'categoria', organizer: 'organizzatore', performer: 'partecipante', startDate: 'data', startTime: 'ora', price: 'prezzo' },
  en: { venue: 'venue', comune: 'municipality', canton: 'canton', category: 'category', organizer: 'organiser', performer: 'participant', startDate: 'date', startTime: 'time', price: 'price' },
  de: { venue: 'ort', comune: 'gemeinde', canton: 'kanton', category: 'kategorie', organizer: 'veranstalter', performer: 'mitwirkender', startDate: 'datum', startTime: 'uhrzeit', price: 'preis' },
  fr: { venue: 'lieu', comune: 'commune', canton: 'canton', category: 'catégorie', organizer: 'organisateur', performer: 'participant', startDate: 'date', startTime: 'heure', price: 'prix' },
});

function displayFactValue(value) {
  if (typeof value === 'string') return value.replace(/\s+/gu, ' ').trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = displayFactValue(item);
      if (result) return result;
    }
    return '';
  }
  if (!value || typeof value !== 'object') return '';
  for (const key of ['name', 'label', 'title', 'value', 'street', 'locality', 'address']) {
    const result = displayFactValue(value[key]);
    if (result) return result;
  }
  for (const nested of Object.values(value)) {
    const result = displayFactValue(nested);
    if (result) return result;
  }
  return '';
}

function fallbackFactEntries(record) {
  const facts = record?.facts || {};
  const entries = [];
  const seen = new Set();
  for (const field of FALLBACK_FACT_FIELDS) {
    const raw = displayFactValue(facts[field]).replace(/[.!?]+$/u, '').trim();
    if (!raw) continue;
    const value = raw.split(/\s+/u).slice(0, 6).join(' ');
    const normalized = value.toLocaleLowerCase('und');
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    entries.push({ field, value });
  }
  return entries;
}

export function wordCount(value) {
  return typeof value === 'string' ? value.trim().split(/\s+/u).filter(Boolean).length : 0;
}

export function meetsPoorSourceWordFloor(descriptions, minimumWords = 50) {
  return EVENT_DESCRIPTION_LOCALES.every((locale) => wordCount(descriptions?.[locale]) >= minimumWords);
}

/** A source-free fallback: two structured facts, no inferred event context. */
export function buildMinimalRewriteDescriptions(record) {
  const entries = fallbackFactEntries(record);
  const uniqueValues = new Set(entries.map(({ value }) => value.toLocaleLowerCase('und')));
  if (entries.length < 2 || uniqueValues.size < 2) return null;
  return Object.fromEntries(EVENT_DESCRIPTION_LOCALES.map((locale) => {
    const labels = FALLBACK_FACT_LABELS[locale];
    const factList = entries.map(({ field, value }) => `${labels[field]}: ${value}`).join('; ');
    const descriptions = {
      it: `La registrazione descrive un evento e conserva i riferimenti strutturati disponibili: ${factList}. Questi dati identificano gli elementi dichiarati nella scheda, senza richiedere informazioni esterne o interpretazioni promozionali aggiuntive. La descrizione mantiene quindi il perimetro fattuale del record e riporta soltanto valori già presenti nei campi strutturati dell'evento, così ogni dettaglio resta verificabile nella relativa scheda pubblica.`,
      en: `The record describes an event and preserves the available structured references: ${factList}. These data identify the elements declared in the listing, without requiring external information or additional promotional interpretation. The description therefore keeps the factual scope of the record and reports only values already present in the event's structured fields, so each detail remains verifiable in the corresponding public listing.`,
      de: `Der Datensatz beschreibt eine Veranstaltung und bewahrt die verfügbaren strukturierten Angaben: ${factList}. Die Daten benennen die in der Eintragsseite erklärten Elemente, ohne externe Informationen oder zusätzliche werbliche Deutungen zu verlangen. Die Beschreibung behält daher den sachlichen Umfang des Datensatzes bei und nennt nur Werte aus den strukturierten Veranstaltungsfeldern, damit jedes Detail im zugehörigen öffentlichen Eintrag überprüfbar bleibt.`,
      fr: `La fiche décrit un événement et conserve les repères structurés disponibles : ${factList}. Ces données identifient les éléments déclarés dans la fiche, sans information externe ni interprétation promotionnelle supplémentaire. La description garde ainsi le périmètre factuel de l'enregistrement et reprend uniquement des valeurs déjà présentes dans les champs structurés de l'événement, afin que chaque détail reste vérifiable dans la fiche publique correspondante.`,
    };
    return [locale, descriptions[locale]];
  }));
}
