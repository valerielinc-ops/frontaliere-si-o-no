import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords } from './constants';
import { endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { WriteCollector } from './batchWrite';
import { esc, H1_STYLE, H2_STYLE, H3_STYLE, LEDE_STYLE, BODY_STYLE, CARD_CLASS } from './shared/seoContentTokens';
import { TICINO_CITIES, TICINO_PHARMACIES, pharmacyCitySlug, pharmaciesForCity } from '../services/pharmacies/data';
import { buildPharmacyPath, type PharmacyPageKind } from '../services/pharmacies/paths';
import { publicDutiesForRegion } from '../services/pharmacies/duties';
import type { Locale } from '../services/i18n';
import type { Pharmacy, PharmacyDuty, PharmacyDutiesDataset } from '../services/pharmacies/types';
import dutiesJson from '../data/pharmacy-duties-ticino.json';

const LOCALES: readonly Locale[] = ['it', 'en', 'de', 'fr'];
const registrySource = 'https://www.ofct.ch/farmacieturno/';
const pharmacies = TICINO_PHARMACIES as Pharmacy[];
const dutiesDataset = dutiesJson as PharmacyDutiesDataset;

type Copy = {
  hubTitle: string;
  cantonTitle: string;
  dutyHubTitle: string;
  dutyCityTitle: (city: string) => string;
  cityTitle: (city: string) => string;
  hubLede: string;
  cantonLede: string;
  dutyHubLede: string;
  dutyCityLede: string;
  directoryHeading: string;
  dutyHeading: string;
  source: string;
  lastVerified: string;
  phone: string;
  address: string;
  viewCity: string;
  viewDuty: string;
  viewDirectory: string;
  sourceLink: string;
  coverage: string;
  locarneseNote: string;
  disclaimerHeading: string;
  disclaimer: string;
  noDuty: string;
  nextDuty: string;
  dutyArea: string;
  dutyEnds: string;
  dutySourceNote: string;
};

const COPY: Record<Locale, Copy> = {
  it: {
    hubTitle: 'Farmacie in Ticino: elenco e fonti ufficiali', cantonTitle: 'Farmacie in Ticino', dutyHubTitle: 'Farmacie di turno in Ticino',
    dutyCityTitle: (city) => `Farmacia di turno: informazioni per ${city}`, cityTitle: (city) => `Farmacie a ${city}, Ticino`,
    hubLede: 'Elenco delle farmacie del Ticino, con città, indirizzo, telefono e fonte dell’ultimo controllo. Per i turni regionali trovi una sezione separata con fonte ufficiale e data di acquisizione.',
    cantonLede: 'Anagrafica delle farmacie ticinesi rilevate nelle quattro regioni OFCT coperte dal connettore. Cerca per nome, località o CAP nella pagina interattiva; i dati riportano soltanto campi pubblicati dalla fonte.',
    dutyHubLede: 'Turni regionali pubblicati dall’Ordine dei Farmacisti del Cantone Ticino. La pagina mostra intervalli verificati, area coperta e fonte: non implica apertura continua né sostituisce una conferma telefonica.',
    dutyCityLede: 'Questa pagina collega la città alla relativa area regionale di turno. La copertura è regionale, non una promessa di servizio per ogni comune: verifica sempre farmacia, orario e accesso direttamente.',
    directoryHeading: 'Elenco verificato', dutyHeading: 'Turno regionale pubblicato', source: 'Fonte', lastVerified: 'Ultimo controllo', phone: 'Telefono', address: 'Indirizzo', viewCity: 'Vedi farmacie della città', viewDuty: 'Vedi turni regionali', viewDirectory: 'Vedi elenco Ticino', sourceLink: 'Apri fonte ufficiale', coverage: 'Copertura regionale', locarneseNote: 'Locarnese: fonte separata non inclusa nel dataset verificato perché non pubblica un’anagrafica completa compatibile; non viene inventata una scheda.', disclaimerHeading: 'Verifica prima di partire', disclaimer: 'Gli intervalli possono cambiare e una farmacia di turno non è necessariamente aperta 24 ore su 24. Chiama la farmacia o controlla la fonte ufficiale prima di spostarti, soprattutto in caso di urgenza.', noDuty: 'Non c’è un intervallo verificato pubblicabile per questa area nel dataset corrente.', nextDuty: 'Prossimo intervallo pubblicato', dutyArea: 'Area', dutyEnds: 'Fine intervallo', dutySourceNote: 'Il turno è associato dalla fonte a una regione; la pagina non deduce orari, servizi o apertura continua.',
  },
  en: {
    hubTitle: 'Pharmacies in Ticino: directory and official sources', cantonTitle: 'Pharmacies in Ticino', dutyHubTitle: 'On-duty pharmacies in Ticino',
    dutyCityTitle: (city) => `On-duty pharmacy information for ${city}`, cityTitle: (city) => `Pharmacies in ${city}, Ticino`,
    hubLede: 'Ticino pharmacy directory with city, address, phone and the source of the latest check. Regional duty schedules live in a separate section with their official source and fetch date.', cantonLede: 'Directory of pharmacies found in the four OFCT regions covered by the connector. Search the interactive page by name, locality or postal code; only fields published by the source are shown.', dutyHubLede: 'Regional duty schedules published by the Ticino Pharmacists’ Association. We show verified intervals, coverage area and source: this does not imply continuous opening and does not replace a phone confirmation.', dutyCityLede: 'This page links a city to its regional duty area. Coverage is regional, not a promise of service in every municipality: confirm the pharmacy, time and access directly.', directoryHeading: 'Verified directory', dutyHeading: 'Published regional duty', source: 'Source', lastVerified: 'Last checked', phone: 'Phone', address: 'Address', viewCity: 'View city pharmacies', viewDuty: 'View regional duties', viewDirectory: 'View Ticino directory', sourceLink: 'Open official source', coverage: 'Regional coverage', locarneseNote: 'Locarnese: the separate source is not included in the verified dataset because it does not publish a compatible full directory; no pharmacy card is invented.', disclaimerHeading: 'Check before travelling', disclaimer: 'Intervals can change and an on-duty pharmacy is not necessarily open 24 hours. Call the pharmacy or check the official source before travelling, especially in an emergency.', noDuty: 'There is no verified interval publishable for this area in the current dataset.', nextDuty: 'Next published interval', dutyArea: 'Area', dutyEnds: 'Interval ends', dutySourceNote: 'The source associates the duty with a region; this page does not infer opening hours, services or continuous access.',
  },
  de: {
    hubTitle: 'Apotheken im Tessin: Verzeichnis und offizielle Quellen', cantonTitle: 'Apotheken im Tessin', dutyHubTitle: 'Notdienst-Apotheken im Tessin',
    dutyCityTitle: (city) => `Informationen zum Apotheken-Notdienst in ${city}`, cityTitle: (city) => `Apotheken in ${city}, Tessin`,
    hubLede: 'Verzeichnis der Apotheken im Tessin mit Ort, Adresse, Telefon und Quelle der letzten Prüfung. Regionale Notdienstpläne stehen separat mit offizieller Quelle und Abrufdatum.', cantonLede: 'Verzeichnis der Apotheken in den vier vom OFCT-Anschluss abgedeckten Regionen. Die interaktive Seite kann nach Name, Ort oder Postleitzahl durchsucht werden; angezeigt werden nur Quellenfelder.', dutyHubLede: 'Regionale Notdienstpläne des Tessiner Apothekerverbands. Wir zeigen verifizierte Zeiträume, Gebiet und Quelle; das bedeutet keine durchgehende Öffnung und ersetzt keine telefonische Bestätigung.', dutyCityLede: 'Diese Seite ordnet eine Stadt dem regionalen Notdienstgebiet zu. Die Abdeckung ist regional und keine Zusage für jede Gemeinde: Apotheke, Zeit und Zugang direkt bestätigen.', directoryHeading: 'Verifiziertes Verzeichnis', dutyHeading: 'Veröffentlichter regionaler Notdienst', source: 'Quelle', lastVerified: 'Zuletzt geprüft', phone: 'Telefon', address: 'Adresse', viewCity: 'Apotheken der Stadt', viewDuty: 'Regionale Notdienste', viewDirectory: 'Tessiner Verzeichnis', sourceLink: 'Offizielle Quelle öffnen', coverage: 'Regionale Abdeckung', locarneseNote: 'Locarnese: Die separate Quelle ist nicht im verifizierten Datensatz enthalten, da sie kein kompatibles vollständiges Verzeichnis veröffentlicht; es wird keine Karte erfunden.', disclaimerHeading: 'Vor der Fahrt prüfen', disclaimer: 'Zeiträume können sich ändern, und eine Notdienst-Apotheke ist nicht zwingend 24 Stunden geöffnet. Vor der Fahrt telefonisch oder bei der offiziellen Quelle prüfen, besonders im Notfall.', noDuty: 'Für dieses Gebiet gibt es im aktuellen Datensatz keinen verifizierten veröffentlichbaren Zeitraum.', nextDuty: 'Nächster veröffentlichter Zeitraum', dutyArea: 'Gebiet', dutyEnds: 'Ende des Zeitraums', dutySourceNote: 'Die Quelle ordnet den Notdienst einer Region zu; Öffnungszeiten, Leistungen oder durchgehender Zugang werden nicht abgeleitet.',
  },
  fr: {
    hubTitle: 'Pharmacies au Tessin : répertoire et sources officielles', cantonTitle: 'Pharmacies au Tessin', dutyHubTitle: 'Pharmacies de garde au Tessin',
    dutyCityTitle: (city) => `Informations de garde pour ${city}`, cityTitle: (city) => `Pharmacies à ${city}, Tessin`,
    hubLede: 'Répertoire des pharmacies du Tessin avec ville, adresse, téléphone et source du dernier contrôle. Les gardes régionales sont présentées à part, avec leur source officielle et la date de collecte.', cantonLede: 'Répertoire des pharmacies relevées dans les quatre régions OFCT couvertes par le connecteur. La page interactive permet une recherche par nom, localité ou code postal; seuls les champs publiés par la source sont affichés.', dutyHubLede: 'Gardes régionales publiées par l’association des pharmaciens du Tessin. Nous indiquons les intervalles vérifiés, la zone et la source; cela ne signifie pas une ouverture continue et ne remplace pas une confirmation téléphonique.', dutyCityLede: 'Cette page relie une ville à sa zone régionale de garde. La couverture est régionale et ne garantit pas un service dans chaque commune : confirmez directement la pharmacie, l’horaire et l’accès.', directoryHeading: 'Répertoire vérifié', dutyHeading: 'Garde régionale publiée', source: 'Source', lastVerified: 'Dernier contrôle', phone: 'Téléphone', address: 'Adresse', viewCity: 'Pharmacies de la ville', viewDuty: 'Gardes régionales', viewDirectory: 'Répertoire du Tessin', sourceLink: 'Ouvrir la source officielle', coverage: 'Couverture régionale', locarneseNote: 'Locarnese : la source séparée n’est pas incluse dans le jeu vérifié car elle ne publie pas de répertoire complet compatible; aucune fiche n’est inventée.', disclaimerHeading: 'Vérifiez avant de partir', disclaimer: 'Les intervalles peuvent changer et une pharmacie de garde n’est pas forcément ouverte 24 heures sur 24. Appelez la pharmacie ou consultez la source officielle avant de vous déplacer, surtout en cas d’urgence.', noDuty: 'Aucun intervalle vérifié publiable pour cette zone dans le jeu de données actuel.', nextDuty: 'Prochain intervalle publié', dutyArea: 'Zone', dutyEnds: 'Fin de l’intervalle', dutySourceNote: 'La source associe la garde à une région; cette page ne déduit ni horaires, ni services, ni accès continu.',
  },
};

function formatDate(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-CH' : locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Zurich' }).format(date);
}

function absolutePath(kind: PharmacyPageKind, locale: Locale, citySlug?: string): string {
  return buildPharmacyPath({ kind, locale, citySlug }, locale);
}

function pageUrl(kind: PharmacyPageKind, locale: Locale, citySlug?: string): string {
  return `${BASE_URL}${absolutePath(kind, locale, citySlug)}`;
}

function href(kind: PharmacyPageKind, locale: Locale, citySlug?: string, label?: string): string {
  return `<a href="${esc(absolutePath(kind, locale, citySlug))}">${esc(label || absolutePath(kind, locale, citySlug))}</a>`;
}

function sourceBlock(pharmacy: Pharmacy, locale: Locale): string {
  const copy = COPY[locale];
  return `<p style="${BODY_STYLE}"><strong>${esc(copy.source)}:</strong> <a href="${esc(pharmacy.sourceUrl)}" rel="nofollow noopener">${esc(copy.sourceLink)}</a><br><strong>${esc(copy.lastVerified)}:</strong> ${esc(formatDate(pharmacy.lastVerifiedAt, locale))}</p>`;
}

function renderPharmacyCard(pharmacy: Pharmacy, locale: Locale): string {
  const copy = COPY[locale];
  return `<article class="${CARD_CLASS}"><h3 style="${H3_STYLE}">${esc(pharmacy.name)}</h3><p style="${BODY_STYLE}"><strong>${esc(copy.address)}:</strong> ${esc(pharmacy.address)}, <a href="${esc(absolutePath('city', locale, pharmacyCitySlug(pharmacy.city)))}">${esc(pharmacy.postalCode)} ${esc(pharmacy.city)}</a>${pharmacy.phone ? `<br><strong>${esc(copy.phone)}:</strong> <a href="tel:${esc(pharmacy.phone)}">${esc(pharmacy.phone)}</a>` : ''}</p>${sourceBlock(pharmacy, locale)}</article>`;
}

function pharmacyById(id: string): Pharmacy | undefined { return pharmacies.find((pharmacy) => pharmacy.id === id); }

function dutyBlock(duty: PharmacyDuty | undefined, locale: Locale): string {
  const copy = COPY[locale];
  if (!duty) return `<p style="${BODY_STYLE}">${esc(copy.noDuty)}</p>`;
  const pharmacy = pharmacyById(duty.pharmacyId);
  return `<article class="${CARD_CLASS}"><h3 style="${H3_STYLE}">${esc(pharmacy?.name || duty.pharmacyId)}</h3><p style="${BODY_STYLE}"><strong>${esc(copy.dutyArea)}:</strong> ${esc(duty.coverageName)}<br><strong>${esc(copy.nextDuty)}:</strong> ${esc(formatDate(duty.startsAt, locale))}<br><strong>${esc(copy.dutyEnds)}:</strong> ${esc(formatDate(duty.endsAt, locale))}<br><strong>${esc(copy.lastVerified)}:</strong> ${esc(formatDate(duty.fetchedAt, locale))}</p>${pharmacy ? `<p style="${BODY_STYLE}">${esc(pharmacy.address)}, ${esc(pharmacy.postalCode)} ${esc(pharmacy.city)}${pharmacy.phone ? ` · <a href="tel:${esc(pharmacy.phone)}">${esc(pharmacy.phone)}</a>` : ''}</p>` : ''}<p style="${BODY_STYLE}"><a href="${esc(duty.sourceUrl)}" rel="nofollow noopener">${esc(copy.sourceLink)}</a></p></article>`;
}

function dutiesForRegion(region: string): PharmacyDuty[] {
  return publicDutiesForRegion(dutiesDataset, region, new Date());
}

function regionForCity(city: string): string | undefined {
  const pharmacy = pharmacies.find((candidate) => candidate.city === city && dutiesDataset.duties.some((duty) => duty.pharmacyId === candidate.id));
  return pharmacy ? dutiesDataset.duties.find((duty) => duty.pharmacyId === pharmacy.id)?.coverageName : undefined;
}

function renderBody(kind: PharmacyPageKind, locale: Locale, city?: string): string {
  const copy = COPY[locale];
  const citySlug = city ? pharmacyCitySlug(city) : undefined;
  const title = kind === 'hub' ? copy.hubTitle : kind === 'canton' ? copy.cantonTitle : kind === 'duty-hub' ? copy.dutyHubTitle : kind === 'city' ? copy.cityTitle(city || '') : copy.dutyCityTitle(city || '');
  const lede = kind === 'hub' ? copy.hubLede : kind === 'canton' ? copy.cantonLede : kind === 'duty-hub' ? copy.dutyHubLede : kind === 'city' ? `${copy.cityTitle(city || '')}. ${copy.cantonLede}` : copy.dutyCityLede;
  let sections = '';
  if (kind === 'hub') {
    sections = `<section><h2 style="${H2_STYLE}">${esc(copy.directoryHeading)}</h2><p style="${BODY_STYLE}">${href('canton', locale, undefined, copy.viewDirectory)}</p><p style="${BODY_STYLE}">${href('duty-hub', locale, undefined, copy.viewDuty)}</p><p style="${BODY_STYLE}">${esc(copy.locarneseNote)}</p></section>`;
  } else if (kind === 'canton') {
    sections = `<section><h2 style="${H2_STYLE}">${esc(copy.directoryHeading)}</h2><div class="s-XENO3U">${pharmacies.map((pharmacy) => renderPharmacyCard(pharmacy, locale)).join('')}</div></section>`;
  } else if (kind === 'city') {
    const cityPharmacies = pharmaciesForCity(city || '');
    sections = `<section><h2 style="${H2_STYLE}">${esc(copy.directoryHeading)}</h2><div class="s-XENO3U">${cityPharmacies.map((pharmacy) => renderPharmacyCard(pharmacy, locale)).join('')}</div><p style="${BODY_STYLE}">${href('duty-city', locale, citySlug, copy.viewDuty)}</p></section>`;
  } else if (kind === 'duty-hub') {
    const regions = [...new Set(dutiesDataset.duties.map((duty) => duty.coverageName))];
    sections = `<section><h2 style="${H2_STYLE}">${esc(copy.dutyHeading)}</h2><div class="s-XENO3U">${regions.map((region) => dutyBlock(dutiesForRegion(region)[0], locale)).join('')}</div><p style="${BODY_STYLE}">${esc(copy.locarneseNote)}</p></section>`;
  } else {
    const region = regionForCity(city || '');
    const next = region ? dutiesForRegion(region)[0] : undefined;
    sections = `<section><h2 style="${H2_STYLE}">${esc(copy.dutyHeading)}</h2><p style="${BODY_STYLE}">${esc(copy.coverage)}: ${esc(region || 'Ticino')}</p>${dutyBlock(next, locale)}<p style="${BODY_STYLE}">${esc(copy.dutySourceNote)}</p></section>`;
  }
  return `<header><h1 style="${H1_STYLE}">${esc(title)}</h1><p style="${LEDE_STYLE}">${esc(lede)}</p></header>${sections}<section><h2 style="${H2_STYLE}">${esc(copy.disclaimerHeading)}</h2><p style="${BODY_STYLE}">${esc(copy.disclaimer)}</p><p style="${BODY_STYLE}"><a href="${esc(registrySource)}" rel="nofollow noopener">${esc(copy.sourceLink)}</a></p></section>`;
}

function jsonLd(kind: PharmacyPageKind, locale: Locale, city?: string): string[] {
  const title = kind === 'hub' ? COPY[locale].hubTitle : kind === 'canton' ? COPY[locale].cantonTitle : kind === 'duty-hub' ? COPY[locale].dutyHubTitle : kind === 'city' ? COPY[locale].cityTitle(city || '') : COPY[locale].dutyCityTitle(city || '');
  const url = pageUrl(kind, locale, city ? pharmacyCitySlug(city) : undefined);
  return [JSON.stringify({ '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, url, isPartOf: { '@type': 'WebSite', name: 'Frontaliere Ticino', url: `${BASE_URL}/` } })];
}

function hreflang(kind: PharmacyPageKind, city?: string): string {
  return [...LOCALES.map((locale) => `<link rel="alternate" hreflang="${locale}" href="${esc(pageUrl(kind, locale, city ? pharmacyCitySlug(city) : undefined))}" />`), `<link rel="alternate" hreflang="x-default" href="${esc(pageUrl(kind, 'it', city ? pharmacyCitySlug(city) : undefined))}" />`].join('\n');
}

function buildPage(kind: PharmacyPageKind, locale: Locale, city: string | undefined, distDir: string): { html: string; path: string; wordCount: number } {
  const body = renderBody(kind, locale, city);
  const wordCount = countHtmlBodyWords(body);
  const indexable = wordCount >= MIN_INDEXABLE_WORDS;
  const bodyHtml = `<main class="seo-static-content">${body}${endOfContentMultiplexHtml({ indexable: true })}</main>`;
  const pathName = absolutePath(kind, locale, city ? pharmacyCitySlug(city) : undefined);
  const title = kind === 'hub' ? COPY[locale].hubTitle : kind === 'canton' ? COPY[locale].cantonTitle : kind === 'duty-hub' ? COPY[locale].dutyHubTitle : kind === 'city' ? COPY[locale].cityTitle(city || '') : COPY[locale].dutyCityTitle(city || '');
  const description = kind === 'duty-hub' ? COPY[locale].dutyHubLede : kind === 'duty-city' ? COPY[locale].dutyCityLede : kind === 'city' ? COPY[locale].cantonLede : COPY[locale].hubLede;
  return { path: pathName, wordCount, html: buildSeoPageHtml({ locale, title: `${title} | Frontaliere Ticino`, description, canonicalUrl: `${BASE_URL}${pathName}`, hreflangHtml: hreflang(kind, city), robots: indexable ? 'index,follow' : 'noindex,follow', jsonLdScripts: jsonLd(kind, locale, city), bodyHtml, skipMainWrap: true, distDir }) };
}

export function pharmacyDirectoryPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'pharmacy-directory-pages',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const distDir = path.resolve(rootDir, 'dist');
      const collector = new WriteCollector({ distDir, pluginName: 'pharmacyDirectoryPagesPlugin' });
      const urls: string[] = [];
      let excludedNoindexRoutes = 0;
      const pageKinds: Array<{ kind: PharmacyPageKind; city?: string }> = [
        { kind: 'hub' }, { kind: 'canton' }, { kind: 'duty-hub' },
        ...TICINO_CITIES.map((city) => ({ kind: 'city' as const, city: city.name })),
        ...TICINO_CITIES.map((city) => ({ kind: 'duty-city' as const, city: city.name })),
      ];
      for (const locale of LOCALES) {
        for (const page of pageKinds) {
          const built = buildPage(page.kind, locale, page.city, distDir);
          collector.add(path.join(distDir, `${built.path.replace(/^\/+/, '').replace(/\/+$/, '')}/index.html`), built.html);
          // Every locale/route still gets its HTML bridge; only the sitemap
          // excludes below-floor pages that deliberately carry noindex.
          if (built.wordCount >= MIN_INDEXABLE_WORDS) urls.push(built.path);
          else excludedNoindexRoutes += 1;
        }
      }
      const dateStamp = new Date().toISOString().slice(0, 10);
      const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${BASE_URL}${url}</loc><lastmod>${dateStamp}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>\n`).join('')}</urlset>\n`;
      const written = await collector.flush();
      fs.writeFileSync(path.join(distDir, 'sitemap-farmacie.xml'), sitemap, 'utf8');
      const master = path.join(distDir, 'sitemap.xml');
      if (fs.existsSync(master)) {
        let xml = fs.readFileSync(master, 'utf8');
        if (!xml.includes('sitemap-farmacie.xml')) xml = xml.replace('</sitemapindex>', `  <sitemap><loc>${BASE_URL}/sitemap-farmacie.xml</loc><lastmod>${dateStamp}</lastmod></sitemap>\n</sitemapindex>`);
        fs.writeFileSync(master, xml, 'utf8');
      }
      console.log(`\x1b[36m[pharmacy-directory-pages]\x1b[0m Emitted ${written} pages and ${urls.length} sitemap URLs (${excludedNoindexRoutes} noindex routes excluded from sitemap)`);
    },
  };
}
