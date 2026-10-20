import type { Locale } from '../i18n';
import type { Pharmacy } from './types';

export interface PharmacyFaqItem {
  question: string;
  answer: string;
}

const DAY_LABELS: Record<Locale, Record<string, string>> = {
  it: {
    monday: 'lunedì', tuesday: 'martedì', wednesday: 'mercoledì', thursday: 'giovedì',
    friday: 'venerdì', saturday: 'sabato', sunday: 'domenica',
  },
  en: {
    monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday',
    friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
  },
  de: {
    monday: 'Montag', tuesday: 'Dienstag', wednesday: 'Mittwoch', thursday: 'Donnerstag',
    friday: 'Freitag', saturday: 'Samstag', sunday: 'Sonntag',
  },
  fr: {
    monday: 'lundi', tuesday: 'mardi', wednesday: 'mercredi', thursday: 'jeudi',
    friday: 'vendredi', saturday: 'samedi', sunday: 'dimanche',
  },
};

function hoursSummary(pharmacy: Pharmacy, locale: Locale): string {
  if (!pharmacy.openingHours?.length) {
    return locale === 'it'
      ? 'La fonte non pubblica orari verificabili per questa sede.'
      : locale === 'de'
        ? 'Die Quelle veröffentlicht für diesen Standort keine überprüfbaren Öffnungszeiten.'
        : locale === 'fr'
          ? 'La source ne publie pas d’horaires vérifiables pour ce site.'
          : 'The source does not publish verifiable hours for this location.';
  }
  return pharmacy.openingHours.map((hour) => {
    const day = DAY_LABELS[locale][hour.dayOfWeek] || hour.dayOfWeek;
    const interval = hour.isClosed
      ? locale === 'it' ? 'chiusa' : locale === 'de' ? 'geschlossen' : locale === 'fr' ? 'fermée' : 'closed'
      : `${hour.opens}–${hour.closes}`;
    return `${day}: ${interval}`;
  }).join('; ');
}

function faqCopy(pharmacy: Pharmacy, locale: Locale): PharmacyFaqItem[] {
  const location = `${pharmacy.address}, ${pharmacy.postalCode} ${pharmacy.city}`;
  const phone = pharmacy.phone;
  const services = pharmacy.services?.length ? pharmacy.services.join(', ') : undefined;
  if (locale === 'it') {
    return [
      { question: `Dove si trova ${pharmacy.name}?`, answer: `${pharmacy.name} si trova in ${location}.` },
      { question: `Qual è il numero di telefono di ${pharmacy.name}?`, answer: phone ? `Il numero pubblicato per ${pharmacy.name} è ${phone}.` : 'La fonte indicata non pubblica un numero di telefono verificabile.' },
      { question: `Quali sono gli orari pubblicati di ${pharmacy.name}?`, answer: hoursSummary(pharmacy, locale) },
      { question: `Quali servizi sono pubblicati per ${pharmacy.name}?`, answer: services ? `I servizi pubblicati sono: ${services}.` : 'La fonte indicata non pubblica servizi verificabili per questa sede.' },
      { question: `Come posso verificare le informazioni su ${pharmacy.name}?`, answer: 'Controlla la fonte e la data di recupero mostrate nella scheda e contatta direttamente la farmacia: orari, turni e disponibilità possono cambiare.' },
    ];
  }
  if (locale === 'de') {
    return [
      { question: `Wo befindet sich ${pharmacy.name}?`, answer: `${pharmacy.name} befindet sich in ${location}.` },
      { question: `Wie lautet die Telefonnummer von ${pharmacy.name}?`, answer: phone ? `Die veröffentlichte Telefonnummer von ${pharmacy.name} ist ${phone}.` : 'Die angegebene Quelle veröffentlicht keine überprüfbare Telefonnummer.' },
      { question: `Welche Öffnungszeiten sind für ${pharmacy.name} veröffentlicht?`, answer: hoursSummary(pharmacy, locale) },
      { question: `Welche Leistungen sind für ${pharmacy.name} veröffentlicht?`, answer: services ? `Veröffentlicht sind: ${services}.` : 'Die angegebene Quelle veröffentlicht für diesen Standort keine überprüfbaren Leistungen.' },
      { question: `Wie kann ich die Angaben zu ${pharmacy.name} prüfen?`, answer: 'Prüfe die in der Seite angegebene Quelle und das Abrufdatum und kontaktiere die Apotheke direkt: Zeiten, Notdienst und Verfügbarkeit können sich ändern.' },
    ];
  }
  if (locale === 'fr') {
    return [
      { question: `Où se trouve ${pharmacy.name} ?`, answer: `${pharmacy.name} se trouve à ${location}.` },
      { question: `Quel est le numéro de téléphone de ${pharmacy.name} ?`, answer: phone ? `Le numéro publié de ${pharmacy.name} est ${phone}.` : 'La source indiquée ne publie pas de numéro de téléphone vérifiable.' },
      { question: `Quels sont les horaires publiés de ${pharmacy.name} ?`, answer: hoursSummary(pharmacy, locale) },
      { question: `Quels services sont publiés pour ${pharmacy.name} ?`, answer: services ? `Les services publiés sont : ${services}.` : 'La source indiquée ne publie pas de services vérifiables pour ce site.' },
      { question: `Comment vérifier les informations sur ${pharmacy.name} ?`, answer: 'Consultez la source et la date de collecte affichées sur la fiche et contactez directement la pharmacie : horaires, gardes et disponibilité peuvent changer.' },
    ];
  }
  return [
    { question: `Where is ${pharmacy.name} located?`, answer: `${pharmacy.name} is located at ${location}.` },
    { question: `What is the phone number for ${pharmacy.name}?`, answer: phone ? `The published phone number for ${pharmacy.name} is ${phone}.` : 'The cited source does not publish a verifiable phone number.' },
    { question: `What hours are published for ${pharmacy.name}?`, answer: hoursSummary(pharmacy, locale) },
    { question: `What services are published for ${pharmacy.name}?`, answer: services ? `The published services are: ${services}.` : 'The cited source does not publish verifiable services for this location.' },
    { question: `How can I verify information about ${pharmacy.name}?`, answer: 'Check the source and retrieval date shown on the page and contact the pharmacy directly: hours, duties and availability can change.' },
  ];
}

export function pharmacyFaqHeading(locale: Locale): string {
  return locale === 'it' ? 'Domande frequenti'
    : locale === 'de' ? 'Häufige Fragen'
      : locale === 'fr' ? 'Questions fréquentes'
        : 'Frequently asked questions';
}

export function pharmacyFaqItems(pharmacy: Pharmacy, locale: Locale): PharmacyFaqItem[] {
  return faqCopy(pharmacy, locale);
}

export function pharmacyFaqStructuredData(pharmacy: Pharmacy, locale: Locale, canonicalUrl: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${canonicalUrl}#faq`,
    mainEntity: pharmacyFaqItems(pharmacy, locale).map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}
