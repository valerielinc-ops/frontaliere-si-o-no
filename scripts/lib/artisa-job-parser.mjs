import { JSDOM } from 'jsdom';
import { isTargetSwissLocation } from './target-swiss-locations.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeText(value = '') {
  return normalizeSpace(value).toLowerCase();
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

const NON_JOB_TITLES = new Set(['carriera', 'le nostre sedi']);

function isCandidateTitle(value = '') {
  const text = normalizeText(value);
  return Boolean(text) && !NON_JOB_TITLES.has(text);
}

export function parseArtisaCareerPage(html = '') {
  const document = new JSDOM(html).window.document;
  const nodes = [...document.querySelectorAll('h2, h4, a[href*="app.smartsheet.com/b/form/"]')];
  const jobs = [];
  let current = null;
  let pendingLocation = '';

  const flush = () => {
    if (current?.title && current.location) {
      jobs.push({
        title: current.title,
        location: current.location,
        applyUrl: current.applyUrl || current.sourceUrl,
        sourceUrl: `https://artisagroup.com/carriera#${slugify(current.title)}`,
      });
    }
    current = null;
  };

  for (const node of nodes) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'h2') {
      const title = normalizeSpace(node.textContent || '');
      if (!isCandidateTitle(title)) continue;
      flush();
      current = { title, location: pendingLocation, applyUrl: '', sourceUrl: `https://artisagroup.com/carriera#${slugify(title)}` };
      pendingLocation = '';
      continue;
    }
    if (tag === 'h4') {
      const location = normalizeSpace(node.textContent || '');
      if (current && !current.location) {
        current.location = location;
      } else if (!current) {
        pendingLocation = location;
      }
      continue;
    }
    if (!current) continue;
    if (tag === 'a' && !current.applyUrl) {
      current.applyUrl = String(node.getAttribute('href') || '').trim();
      flush();
    }
  }

  flush();
  return jobs.filter((job) => isTargetSwissLocation(job.location));
}

export function buildArtisaLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const location = String(job.location || '').trim() || 'Lugano';
  const titleByLocale = {
    it: title,
    en: title,
    de: title,
    fr: title,
  };
  return {
    titleByLocale,
    descriptionByLocale: {
      it: `## Posizione aperta\nArtisa Group ha aperto una selezione per il ruolo ${title} con base ${location}. La vacancy fa parte delle opportunità attive pubblicate nella pagina carriera del gruppo in Ticino.\n\n## Candidatura\nPer candidarti utilizza il modulo ufficiale Artisa Group e verifica direttamente dal form eventuali requisiti o dettagli aggiuntivi sul processo di selezione.`,
      en: `## Open position\nArtisa Group is currently hiring for the ${title} role based in ${location}. This vacancy is part of the active opportunities published on the group's careers page for Southern Switzerland.\n\n## Application\nApply through the official Artisa Group form and review the form carefully for any additional requirements or hiring process details.`,
      de: `## Offene Stelle\nArtisa Group rekrutiert derzeit für die Position ${title} am Standort ${location}. Diese Stelle gehört zu den aktuell veröffentlichten Karrieremöglichkeiten der Gruppe in der Südschweiz.\n\n## Bewerbung\nBewirb dich über das offizielle Formular von Artisa Group und prüfe dort die zusätzlichen Anforderungen sowie die nächsten Schritte im Auswahlprozess.`,
      fr: `## Poste ouvert\nArtisa Group recrute actuellement pour le poste ${title} basé à ${location}. Cette offre fait partie des opportunités actives publiées sur la page carrière du groupe pour la Suisse italienne.\n\n## Candidature\nPostulez via le formulaire officiel Artisa Group et consultez le formulaire pour vérifier les éventuelles conditions supplémentaires ainsi que les étapes du recrutement.`,
    },
    slugByLocale: {
      it: slugify(`${titleByLocale.it} Artisa Group ${location}`),
      en: slugify(`${titleByLocale.en} Artisa Group ${location}`),
      de: slugify(`${titleByLocale.de} Artisa Group ${location}`),
      fr: slugify(`${titleByLocale.fr} Artisa Group ${location}`),
    },
  };
}
