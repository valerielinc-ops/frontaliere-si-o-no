import { JSDOM } from 'jsdom';
import {  inferSwissTargetCanton, inferAnyCanton, isTargetSwissLocation  } from './target-swiss-locations.mjs';

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|div|li|h[1-6]|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToBullets(html = '') {
  const dom = new JSDOM(`<body>${html || ''}</body>`);
  return [...dom.window.document.querySelectorAll('li')]
    .map((node) => normalizeSpace(stripHtml(node.innerHTML)))
    .filter((text) => text.length >= 3);
}

function sectionToMarkdown(section = {}) {
  const heading = normalizeSpace(section.text || '');
  const bullets = htmlToBullets(section.content || '');
  const prose = stripHtml(section.content || '');
  const parts = [];
  if (heading) parts.push(`## ${heading}`);
  if (bullets.length > 0) {
    parts.push(bullets.map((item) => `- ${item}`).join('\n'));
  } else if (prose) {
    parts.push(prose);
  }
  return parts.join('\n\n').trim();
}

export function isTsmgTargetLocation(rawLocation = '') {
  return isTargetSwissLocation(rawLocation);
}

export function inferTsmgRegion(rawLocation = '') {
  const canton = inferAnyCanton(rawLocation);
  if (canton) return { canton, country: 'CH' };
  return { canton: 'CH', country: 'CH' };
}

export function inferTsmgCategory(title = '') {
  const haystack = normalize(title);
  if (haystack.includes('speech tester')) return 'tech';
  if (haystack.includes('data collector') || haystack.includes('driver')) return 'logistics';
  return 'other';
}

export function localizeTsmgTitle(title = '', locale = 'en') {
  const raw = String(title || '').trim();
  if (!raw) return '';

  if (locale === 'it') {
    return raw
      .replace(/^AI Speech Tester/i, 'Tester conversazioni vocali AI')
      .replace(/^Driver\/Data Collector/i, 'Autista / Addetto raccolta dati')
      .replace(/^Driver \/ Data Collector/i, 'Autista / Addetto raccolta dati');
  }
  if (locale === 'de') {
    return raw
      .replace(/^AI Speech Tester/i, 'KI-Sprachtester')
      .replace(/^Driver\/Data Collector/i, 'Fahrer / Datenerfasser')
      .replace(/^Driver \/ Data Collector/i, 'Fahrer / Datenerfasser');
  }
  if (locale === 'fr') {
    return raw
      .replace(/^AI Speech Tester/i, 'Testeur vocal IA')
      .replace(/^Driver\/Data Collector/i, 'Chauffeur / Collecteur de donnees')
      .replace(/^Driver \/ Data Collector/i, 'Chauffeur / Collecteur de donnees');
  }
  return raw;
}

export function buildTsmgDescription(job = {}, locale = 'en') {
  const title = localizeTsmgTitle(job.text || '', locale);
  const location = normalizeSpace(job?.categories?.location || '');
  const introByLocale = {
    it: `TSMG cerca ${title} per attivita operative sul territorio in ${location}. Di seguito trovi il testo integrale dell'annuncio Lever, con responsabilita, requisiti e dettagli pratici del progetto.`,
    en: `TSMG is hiring ${title} for field operations in ${location}. Below is the full Lever job description with responsibilities, requirements and practical project details.`,
    de: `TSMG sucht ${title} fur operative Einsatze in ${location}. Unten findest du die vollstandige Lever-Stellenbeschreibung mit Aufgaben, Anforderungen und Projektinformationen.`,
    fr: `TSMG recrute ${title} pour des activites terrain a ${location}. Ci-dessous tu trouves la description complete Lever avec responsabilites, exigences et details pratiques du projet.`,
  };

  const sections = [];
  const descriptionPlain = normalizeSpace(job.descriptionPlain || stripHtml(job.description || ''));
  const openingPlain = normalizeSpace(job.openingPlain || stripHtml(job.opening || ''));
  const additionalPlain = normalizeSpace(job.additionalPlain || stripHtml(job.additional || ''));
  const projectOverviewHeading =
    locale === 'it'
      ? 'Panoramica del progetto'
      : locale === 'de'
        ? 'Projektuberblick'
        : locale === 'fr'
          ? "Vue d'ensemble du projet"
          : 'Project overview';
  if (descriptionPlain) sections.push(descriptionPlain);
  if (openingPlain) sections.push(`## ${projectOverviewHeading}\n\n${openingPlain}`);
  for (const section of Array.isArray(job.lists) ? job.lists : []) {
    const md = sectionToMarkdown(section);
    if (md) sections.push(md);
  }
  if (additionalPlain) {
    const label = locale === 'it' ? 'Informazioni aggiuntive' : locale === 'de' ? 'Zusatzliche Informationen' : locale === 'fr' ? 'Informations complementaires' : 'Additional information';
    sections.push(`## ${label}\n\n${additionalPlain}`);
  }
  return [introByLocale[locale] || introByLocale.en, ...sections].filter(Boolean).join('\n\n').trim();
}

export function buildTsmgLocalizedContent(job) {
  const location = normalizeSpace(job?.categories?.location || '');
  const localized = {};
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const title = localizeTsmgTitle(job.text || '', locale);
    localized[locale] = {
      title,
      slug: slugify(`${title} TSMG ${location}`),
      description: buildTsmgDescription(job, locale),
    };
  }
  return localized;
}
