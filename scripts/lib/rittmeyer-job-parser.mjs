import { JSDOM } from 'jsdom';
import { isTargetSwissLocation } from './target-swiss-locations.mjs';

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
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

function listFromSection(document, headingText) {
  const heading = [...document.querySelectorAll('h2')].find(
    (node) => normalizeSpace(node.textContent || '') === headingText
  );
  if (!heading) return [];
  const container = heading.closest('.specificPrintColumn');
  if (!container) return [];
  return [...container.querySelectorAll('li')]
    .map((item) => normalizeSpace(item.textContent || ''))
    .filter(Boolean);
}

export function parseRittmeyerListingsPage(html = '') {
  const document = new JSDOM(html).window.document;
  const byHref = new Map();
  for (const anchor of document.querySelectorAll('a[href^="/offene-stellen/"]')) {
    const href = String(anchor.getAttribute('href') || '').trim();
    if (!href || href === '/offene-stellen/') continue;
    const text = normalizeSpace(anchor.textContent || '');
    if (!text) continue;
    const prev = byHref.get(href);
    if (!prev || text.length > prev.snippet.length) {
      byHref.set(href, {
        href,
        title: text.split(/\s{2,}|\n/)[0].trim(),
        snippet: text,
      });
    }
  }
  return [...byHref.values()];
}

export function isRittmeyerTicinoListing(listing = {}) {
  const haystack = normalize([listing.href, listing.title, listing.snippet].filter(Boolean).join(' '));
  return isTargetSwissLocation(haystack);
}

export function parseRittmeyerJobDetail(html = '') {
  const document = new JSDOM(html).window.document;
  const title = normalizeSpace(document.querySelector('h1')?.textContent || '');
  const summary = normalizeSpace(document.querySelector('meta[name="description"]')?.getAttribute('content') || '');
  const applyUrl =
    [...document.querySelectorAll('a[href*="onlyfy.jobs/job/"]')].map((link) => link.href).find(Boolean) || '';

  const facts = {};
  const paragraphs = [...document.querySelectorAll('p')].map((node) => normalizeSpace(node.textContent || '')).filter(Boolean);
  for (let i = 0; i < paragraphs.length - 1; i += 1) {
    const value = paragraphs[i];
    const label = paragraphs[i + 1];
    if (['Bereich', 'Schweiz', 'Pensum'].includes(label)) {
      facts[label] = value;
    }
  }

  const responsibilities = listFromSection(document, 'La tua area di competenza');
  const requirements = listFromSection(document, 'Ciò che porti con te');
  const benefits = [...document.querySelectorAll('.CardIcon__item')]
    .map((card) => {
      const texts = [...card.querySelectorAll('p')]
        .map((node) => normalizeSpace(node.textContent || ''))
        .filter(Boolean);
      if (texts.length >= 2) {
        return `${texts[0]}: ${texts.slice(1).join(' ')}`;
      }
      return texts[0] || '';
    })
    .filter(Boolean);

  return {
    title,
    summary,
    applyUrl,
    area: facts.Bereich || '',
    location: facts.Schweiz || '',
    workload: facts.Pensum || '',
    responsibilities,
    requirements,
    benefits,
  };
}

function renderLocale(detail, locale) {
  const isItalian = locale === 'it';
  const headings = {
    it: {
      intro: 'Panoramica',
      facts: 'Dettagli principali',
      responsibilities: 'La tua area di competenza',
      requirements: 'Ciò che porti con te',
      benefits: 'Cosa ti offriamo',
      area: 'Area',
      location: 'Località',
      workload: 'Percentuale',
      apply: 'Candidatura',
      applyBody: 'Candidati tramite il portale ufficiale Rittmeyer/Onlyfy.',
    },
    en: {
      intro: 'Overview',
      facts: 'Key details',
      responsibilities: 'Main responsibilities',
      requirements: 'What you bring',
      benefits: 'What Rittmeyer offers',
      area: 'Team',
      location: 'Location',
      workload: 'Workload',
      apply: 'Application',
      applyBody: 'Apply through the official Rittmeyer/Onlyfy portal.',
    },
    de: {
      intro: 'Überblick',
      facts: 'Wichtige Eckdaten',
      responsibilities: 'Dein Verantwortungsbereich',
      requirements: 'Das bringst du mit',
      benefits: 'Was Rittmeyer bietet',
      area: 'Bereich',
      location: 'Standort',
      workload: 'Pensum',
      apply: 'Bewerbung',
      applyBody: 'Bewirb dich über das offizielle Rittmeyer-/Onlyfy-Portal.',
    },
    fr: {
      intro: 'Aperçu',
      facts: 'Points clés',
      responsibilities: 'Vos responsabilités',
      requirements: 'Votre profil',
      benefits: 'Ce que propose Rittmeyer',
      area: 'Domaine',
      location: 'Lieu',
      workload: 'Taux',
      apply: 'Candidature',
      applyBody: 'Postulez via le portail officiel Rittmeyer/Onlyfy.',
    },
  }[locale];

  const sections = [];
  if (detail.summary) {
    sections.push(`## ${headings.intro}\n${detail.summary}`);
  }

  const facts = [
    detail.area ? `- ${headings.area}: ${detail.area}` : '',
    detail.location ? `- ${headings.location}: ${detail.location}` : '',
    detail.workload ? `- ${headings.workload}: ${detail.workload}` : '',
  ].filter(Boolean);
  if (facts.length > 0) {
    sections.push(`## ${headings.facts}\n${facts.join('\n')}`);
  }

  if (detail.responsibilities.length > 0) {
    sections.push(`## ${headings.responsibilities}\n${detail.responsibilities.map((item) => `- ${item}`).join('\n')}`);
  }
  if (detail.requirements.length > 0) {
    sections.push(`## ${headings.requirements}\n${detail.requirements.map((item) => `- ${item}`).join('\n')}`);
  }
  if (detail.benefits.length > 0) {
    sections.push(`## ${headings.benefits}\n${detail.benefits.map((item) => `- ${item}`).join('\n')}`);
  }
  if (detail.applyUrl) {
    sections.push(`## ${headings.apply}\n${headings.applyBody}`);
  }

  return sections.join('\n\n').trim();
}

export function buildRittmeyerLocalizedContent(detail = {}) {
  const title = String(detail.title || '').trim();
  const locationLabel = detail.location || 'Ticino';
  const localizedTitles = {
    it: title,
    en: 'Sales Project Engineer (m/f/x) Ticino',
    de: 'Verkaufsprojektingenieur:in Tessin',
    fr: 'Ingenieur commercial projets Tessin',
  };
  return {
    titleByLocale: localizedTitles,
    slugByLocale: {
      it: slugify(`${localizedTitles.it} Rittmeyer AG ${locationLabel}`),
      en: slugify(`${localizedTitles.en} Rittmeyer AG Ticino`),
      de: slugify(`${localizedTitles.de} Rittmeyer AG Tessin`),
      fr: slugify(`${localizedTitles.fr} Rittmeyer AG Tessin`),
    },
    descriptionByLocale: {
      it: renderLocale(detail, 'it'),
      en: renderLocale(detail, 'en'),
      de: renderLocale(detail, 'de'),
      fr: renderLocale(detail, 'fr'),
    },
  };
}
