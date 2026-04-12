import { JSDOM } from 'jsdom';
import { inferSwissTargetCanton, isTargetSwissLocation } from './target-swiss-locations.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

const HQ = getCompanyDefaults('bosch');

function normalize(value = '') {
  return String(value || '').trim();
}

function normalizeSpace(value = '') {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

function markdownFromRichText(node) {
  if (!node) return '';
  const parts = [];
  for (const child of Array.from(node.children)) {
    const tag = child.tagName?.toLowerCase() || '';
    if (tag === 'ul' || tag === 'ol') {
      const bullets = Array.from(child.querySelectorAll('li'))
        .map((li) => normalizeSpace(li.textContent || ''))
        .filter(Boolean)
        .map((text) => `- ${text}`);
      if (bullets.length) parts.push(bullets.join('\n'));
      continue;
    }
    const text = normalizeSpace(child.textContent || '');
    if (text) parts.push(text);
  }
  return parts.join('\n\n').trim();
}

function toMarkdownSection(title, body) {
  const heading = normalizeSpace(title || '');
  const content = normalizeSpace(body || '');
  if (!heading || !content) return '';
  return `## ${heading}\n\n${content}`;
}

function extractTextBySelector(document, selector) {
  return normalizeSpace(document.querySelector(selector)?.textContent || '');
}

export function parseBoschListingsPage(html = '') {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const cards = Array.from(document.querySelectorAll('.A-JobPanel'));
  const seen = new Set();
  const rows = [];

  for (const card of cards) {
    const link = card.querySelector('a[href*="/job/"]');
    const url = normalize(link?.href || '');
    const title = normalizeSpace(card.querySelector('h2')?.textContent || '');
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);

    const dtNodes = Array.from(card.querySelectorAll('dt'));
    const getFact = (label) => {
      const dt = dtNodes.find((node) => normalizeSpace(node.textContent || '').toLowerCase() === label.toLowerCase());
      return normalizeSpace(dt?.nextElementSibling?.textContent || '');
    };

    rows.push({
      title,
      url,
      location: getFact('Bosch Location'),
      field: getFact('Fields of work'),
      postedDate: getFact('Job posted:'),
    });
  }

  return rows;
}

export function isBoschTargetListing(listing = {}) {
  return isTargetSwissLocation(`${listing.title || ''} ${listing.location || ''}`);
}

export function parseBoschJobDetail(html = '') {
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const title = extractTextBySelector(document, 'h1');
  const termWrappers = Array.from(document.querySelectorAll('.M-JobKeyFacts__termWrapper'));
  const factFor = (label) => {
    const wrapper = termWrappers.find((node) => normalizeSpace(node.querySelector('.M-JobKeyFacts__term')?.textContent || '') === label);
    return normalizeSpace(wrapper?.querySelector('.M-JobKeyFacts__fact')?.textContent || '');
  };

  // The apply button is a div.ApplyButton with a data-apply-button-href attribute,
  // NOT a regular anchor tag. The only <a> with smartrecruiters.com is the privacy
  // policy footer link — so we must read the data attribute instead.
  const applyUrl =
    normalize(document.querySelector('[data-apply-button-href]')?.getAttribute('data-apply-button-href') || '') ||
    normalize(document.querySelector('a[href*="smartrecruiters.com/BoschGroup"]')?.href || '') ||
    normalize(document.querySelector('a[href*="/apply"]')?.href || '');

  const sections = [];
  for (const heading of Array.from(document.querySelectorAll('main h2'))) {
    const headingText = normalizeSpace(heading.textContent || '');
    if (!headingText) continue;
    const rich = heading.parentElement?.querySelector('.A-Text-RichText');
    if (!rich) continue;
    const body = markdownFromRichText(rich);
    const section = toMarkdownSection(headingText, body);
    if (section) sections.push(section);
  }

  const location = factFor('Bosch Location').replace(/\(.*?\)/g, '').trim();
  const employmentType = factFor('Working time');
  const legalEntity = factFor('Legal entity');
  const field = factFor('Fields of work');

  return {
    title,
    location,
    employmentType,
    legalEntity,
    field,
    applyUrl,
    description: sections.join('\n\n').trim(),
    canton: inferSwissTargetCanton(`${title} ${location}`) || HQ.canton,
  };
}

export function inferBoschCategory(detail = {}) {
  const haystack = `${detail.field || ''} ${detail.title || ''} ${detail.description || ''}`.toLowerCase();
  if (/(customer service|kundendienst|assistenza clienti|service)/.test(haystack)) return 'sales';
  if (/(technik|technician|tecnico|heating|fossile|gas|oil)/.test(haystack)) return 'engineering';
  if (/(apprentice|lehrstelle|apprendist)/.test(haystack)) return 'apprenticeship';
  return 'other';
}

export function buildBoschLocalizedContent(detail = {}) {
  const title = normalize(detail.title);
  const locationLabel = normalize(detail.location || 'Ticino');
  const lowerTitle = title.toLowerCase();
  const baseDescription = detail.description || '';
  const titleByLocale = {
    it: title,
    en: title,
    de: title,
    fr: title,
  };
  const descriptionByLocale = {
    it: baseDescription,
    en: baseDescription,
    de: baseDescription,
    fr: baseDescription,
  };

  if (lowerTitle.includes('tecnico di servizio fossile regione ticino')) {
    titleByLocale.en = 'Fossil Service Technician Ticino Region (m/f/div.)';
    titleByLocale.de = 'Servicetechniker Fossil Region Tessin (w/m/div.)';
    titleByLocale.fr = 'Technicien de service fossile région Tessin (h/f/div.)';
    descriptionByLocale.en = [
      '## Your tasks',
      '',
      '- Commission oil and gas heating systems, hot-water installations and control systems professionally.',
      '- Carry out preventive maintenance in line with Buderus quality standards.',
      '- Diagnose faults independently and resolve them quickly on site.',
      '- Advise customers on the best system settings for their home or building.',
      '- Present optional Buderus maintenance contracts and their benefits.',
      '- Plan your service visits reliably and coordinate them with customers and dispatch.',
      '- Join the on-call rota together with the Ticino service team.',
      '',
      '## Your profile',
      '',
      '- Completed vocational training, ideally in electrical work, heating, mechanics or automotive technology.',
      '- Reliable, autonomous, service-oriented and comfortable working under pressure.',
      '- Prior field-service experience is welcome, but curiosity and willingness to learn matter most.',
      '- Italian is required; German is an advantage.',
      '',
      '## Contact & additional information',
      '',
      'You can expect a varied role with a modern employer built on trust and mutual respect. Bosch offers structured onboarding, professional development, a company vehicle for use in Switzerland, flat-rate expenses, attractive social benefits and five weeks of holiday. HR contact: Dajana Levarda. Hiring contact: Silvio Ponti.',
      '',
      '## Do you need technical support?',
      '',
      'We look forward to your inquiry.',
    ].join('\n');
    descriptionByLocale.de = [
      '## Ihre Aufgaben',
      '',
      '- Sie nehmen Öl- und Gasheizungen, Warmwassersysteme und Regelungen fachgerecht in Betrieb.',
      '- Sie führen Wartungen nach den hohen Buderus-Qualitätsstandards durch.',
      '- Sie analysieren Störungen selbstständig und beheben diese rasch vor Ort.',
      '- Sie beraten Kundinnen und Kunden zu den optimalen Einstellungen ihrer Anlagen.',
      '- Sie erklären die Vorteile optionaler Buderus-Wartungsverträge.',
      '- Sie planen Ihre Serviceeinsätze zuverlässig und stimmen sie mit Kundschaft und Disposition ab.',
      '- Sie beteiligen sich am Pikettdienst im Tessiner Serviceteam.',
      '',
      '## Ihr Profil',
      '',
      '- Abgeschlossene EFZ-Ausbildung, idealerweise in Elektro, Heizung, Mechanik oder Automobiltechnik.',
      '- Zuverlässige, selbstständige und serviceorientierte Persönlichkeit mit Belastbarkeit.',
      '- Berufserfahrung im Aussendienst ist willkommen, wichtiger sind Lernbereitschaft und Interesse am Fachgebiet.',
      '- Italienisch ist erforderlich, Deutschkenntnisse sind von Vorteil.',
      '',
      '## Kontakt & Zusatzinformationen',
      '',
      'Sie erwartet eine verantwortungsvolle und abwechslungsreiche Aufgabe in einem modernen Unternehmen mit Wertschätzung und Respekt. Bosch bietet strukturiertes Onboarding, Entwicklungsmöglichkeiten, ein Firmenfahrzeug zur Nutzung in der Schweiz, Pauschalspesen, attraktive Sozialleistungen und fünf Wochen Ferien. HR-Kontakt: Dajana Levarda. Fachkontakt: Silvio Ponti.',
      '',
      '## Benötigen Sie technische Unterstützung?',
      '',
      'Wir freuen uns auf Ihre Anfrage.',
    ].join('\n');
    descriptionByLocale.fr = [
      '## Vos missions',
      '',
      '- Mettre en service des installations de chauffage au fioul et au gaz, des systèmes d’eau chaude et des régulations.',
      '- Réaliser la maintenance préventive selon les standards qualité Buderus.',
      '- Diagnostiquer les pannes de manière autonome et les résoudre rapidement sur site.',
      '- Conseiller les clientes et clients sur les réglages idéaux de leurs installations.',
      '- Présenter les avantages des contrats de maintenance Buderus en option.',
      '- Organiser les visites de service et les coordonner avec les clients et le dispatch.',
      '- Participer au service de piquet avec l’équipe de service du Tessin.',
      '',
      '## Votre profil',
      '',
      '- Formation professionnelle achevée, idéalement en électricité, chauffage, mécanique ou automobile.',
      '- Personnalité fiable, autonome, orientée service et capable de travailler sous pression.',
      '- Une expérience terrain est un atout, mais la motivation à apprendre reste essentielle.',
      '- L’italien est indispensable; l’allemand est un plus.',
      '',
      '## Contact et informations complémentaires',
      '',
      'Vous rejoignez une entreprise moderne qui valorise la confiance et le respect. Bosch propose un onboarding structuré, des possibilités de développement, un véhicule de service utilisable en Suisse, des forfaits de frais, des prestations sociales attractives et cinq semaines de vacances. Contact RH: Dajana Levarda. Contact métier: Silvio Ponti.',
      '',
      '## Besoin d’un support technique ?',
      '',
      'Nous nous réjouissons de votre prise de contact.',
    ].join('\n');
  }

  return {
    titleByLocale,
    slugByLocale: {
      it: slugify(`${titleByLocale.it} Bosch ${locationLabel}`),
      en: slugify(`${titleByLocale.en} Bosch ${locationLabel}`),
      de: slugify(`${titleByLocale.de} Bosch ${locationLabel}`),
      fr: slugify(`${titleByLocale.fr} Bosch ${locationLabel}`),
    },
    descriptionByLocale,
  };
}
