import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
import { JSDOM } from 'jsdom';
import { isTargetSwissLocation } from './target-swiss-locations.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeText(value = '') {
  return normalizeSpace(value).toLowerCase();
}

function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
}

const NON_JOB_TITLES = new Set(['carriera', 'le nostre sedi']);

// The two non-job `h2` landmarks Squarespace renders around the vacancy list.
// Both present proves the careers page rendered in full (not a WAF/truncated
// fetch). Necessary but NOT sufficient to call a zero authoritative: the page
// can render in full and still yield zero *rows* because the location selector
// drifted. The zero must also be proven pre-filter, by the absence of candidate
// vacancy headings — see `candidateVacancies` in parseArtisaCareerPage.
const LANDMARK_TITLES = ['carriera', 'le nostre sedi'];

function isCandidateTitle(value = '') {
  const text = normalizeText(value);
  return Boolean(text) && !NON_JOB_TITLES.has(text);
}

export function parseArtisaCareerPage(html = '') {
  const document = new JSDOM(html).window.document;
  const nodes = [...document.querySelectorAll('h2, h4, a[href*="app.smartsheet.com/b/form/"]')];
  const jobs = [];
  const landmarks = new Set();
  // Every `h2` the page rendered, in order, verbatim. Only ever read to build
  // the diagnostic below: when the snapshot is not provable, this is the one
  // fact that separates "Squarespace re-worded a landmark" from "the page
  // really lists an opening" — see `artisaSnapshotReason`.
  const headingsSeen = [];
  // Vacancy `h2` headings seen before any downstream gate: neither the
  // `title && location` flush gate nor the Swiss-location filter can shrink it.
  // This is what makes a zero provable rather than merely observed.
  let candidateVacancies = 0;
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
      if (title) headingsSeen.push(title);
      if (!isCandidateTitle(title)) {
        landmarks.add(normalizeText(title));
        continue;
      }
      flush();
      candidateVacancies += 1;
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
  const targetJobs = jobs.filter((job) => isTargetSwissLocation(job.location));
  const landmarksComplete = LANDMARK_TITLES.every((title) => landmarks.has(title));
  // A zero is authoritative only when the page rendered in full AND listed no
  // vacancy at all. Qualifying on `targetJobs.length === 0` instead would make a
  // drift indistinguishable from a real zero: if Squarespace moves the location
  // out of `h4`, or changes its wording so `isTargetSwissLocation()` stops
  // matching, every vacancy is parsed and then discarded while both landmarks
  // still render — a false zero that archives live jobs and bypasses the shrink
  // guard. Counting candidates pre-filter keeps that case `unverified`, so the
  // crawler fails loudly instead of delisting.
  Object.defineProperty(targetJobs, 'artisaSnapshotState', {
    value: landmarksComplete && candidateVacancies === 0 ? 'authoritative-site-zero' : 'unverified',
    enumerable: false,
  });
  // Why the state is `unverified`, in the words of what the page actually
  // rendered (issue #7425 item 3). Without it the crawler's only signal is the
  // floor error, which reads "landmarks missing" even when both landmarks are
  // there and the page simply listed an opening — so a Squarespace re-wording
  // of `carriera` / `le nostre sedi` and a real vacancy produce the SAME red,
  // and the first is permanent while the second clears itself. Naming the
  // cause costs a string; guessing it costs a fixer run per occurrence.
  const missingLandmarks = LANDMARK_TITLES.filter((title) => !landmarks.has(title));
  Object.defineProperty(targetJobs, 'artisaSnapshotReason', {
    value: missingLandmarks.length > 0
      ? `landmark h2 not found: ${missingLandmarks.join(', ')} — h2 rendered: ${headingsSeen.join(' | ') || '(none)'}`
      : `${candidateVacancies} candidate vacancy h2 present — h2 rendered: ${headingsSeen.join(' | ')}`,
    enumerable: false,
  });
  return targetJobs;
}

/**
 * Authoritative-snapshot validator for the empty case (crawler-template
 * contract). Returns true only when the careers page rendered both landmark
 * headings and listed no candidate vacancy heading at all — i.e. Artisa itself
 * published zero openings. Anything else (WAF page, truncated fetch, or a
 * selector/wording drift that parses vacancies and then discards them) throws,
 * so the crawler still fails loudly instead of delisting live jobs.
 *
 * @param {object[]|undefined|null} jobs
 * @returns {true}
 */
export function assertCompleteArtisaSnapshot(jobs) {
  if (
    !Array.isArray(jobs)
    || jobs.length !== 0
    || Reflect.get(jobs, 'artisaSnapshotState') !== 'authoritative-site-zero'
  ) {
    const reason = Array.isArray(jobs)
      ? Reflect.get(jobs, 'artisaSnapshotReason') || `${jobs.length} row(s) parsed`
      : 'parser returned no array';
    throw new Error(`Artisa Group snapshot is not a proven authoritative empty state: ${reason}`);
  }
  return true;
}

/**
 * Parse a Smartsheet form page to extract the job title and description.
 * Smartsheet embeds form data as a base64-encoded JSON in `window.formDefinition`.
 */
export function parseSmartsheetFormPage(html = '') {
  const match = html.match(/window\.formDefinition\s*=\s*"([^"]+)"/);
  if (!match) return null;

  try {
    const json = Buffer.from(match[1], 'base64').toString('utf-8');
    const data = JSON.parse(json);
    const name = normalizeSpace(data.name || '');
    const rawDesc = normalizeSpace(data.description || '');
    if (!rawDesc || rawDesc.length < 30) return name ? { title: name, description: '' } : null;

    // Structure the flat description into markdown sections.
    // Smartsheet concatenates paragraphs without separators — split on known headings.
    const description = structureSmartsheetDescription(rawDesc);
    return { title: name, description };
  } catch {
    return null;
  }
}

/**
 * Add markdown structure to a flat Smartsheet description string.
 * Splits on Italian heading patterns commonly used in Artisa forms.
 */
function structureSmartsheetDescription(raw = '') {
  // Known section headings that Smartsheet concatenates inline
  const headings = [
    /(?:Le tue principali responsai?bilit[àa]|Principali responsabilit[àa]|Responsabilit[àa]|Mansioni principali):?/i,
    /(?:Il tuo profilo|Profilo richiesto|Requisiti|Profilo):?/i,
    /(?:Offriamo|Cosa offriamo|Noi offriamo):?/i,
    /(?:Data d['']inizio|Inizio):?/i,
    /(?:Nota per le agenzie):?/i,
  ];

  let text = raw;

  // Insert line breaks before known headings
  for (const re of headings) {
    text = text.replace(re, (m) => `\n\n## ${m.replace(/:$/, '')}\n`);
  }

  // Also break on "Artisa Architecture:" as a sub-heading
  text = text.replace(/Artisa Architecture:/g, '\n\n**Artisa Architecture:**');

  // Clean up multiple newlines
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}

export function buildArtisaLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const location = String(job.location || '').trim() || 'Lugano';
  const detailDescription = String(job.detailDescription || '').trim();
  const titleByLocale = {
    it: title,
    en: title,
    de: title,
    fr: title,
  };

  // If we have a rich description from the Smartsheet form, use it for IT
  // and provide placeholder translations that will be replaced by AI translation.
  const itDesc = detailDescription ||
    `## Posizione aperta\nArtisa Group ha aperto una selezione per il ruolo ${title} con base ${location}. La vacancy fa parte delle opportunità attive pubblicate nella pagina carriera del gruppo in Ticino.\n\n## Candidatura\nPer candidarti utilizza il modulo ufficiale Artisa Group e verifica direttamente dal form eventuali requisiti o dettagli aggiuntivi sul processo di selezione.`;

  return {
    titleByLocale,
    descriptionByLocale: {
      it: itDesc,
      en: detailDescription
        ? '' // leave empty so AI translation fills it from rich IT content
        : `## Open position\nArtisa Group is currently hiring for the ${title} role based in ${location}. This vacancy is part of the active opportunities published on the group's careers page for Southern Switzerland.\n\n## Application\nApply through the official Artisa Group form and review the form carefully for any additional requirements or hiring process details.`,
      de: detailDescription
        ? ''
        : `## Offene Stelle\nArtisa Group rekrutiert derzeit für die Position ${title} am Standort ${location}. Diese Stelle gehört zu den aktuell veröffentlichten Karrieremöglichkeiten der Gruppe in der Südschweiz.\n\n## Bewerbung\nBewirb dich über das offizielle Formular von Artisa Group und prüfe dort die zusätzlichen Anforderungen sowie die nächsten Schritte im Auswahlprozess.`,
      fr: detailDescription
        ? ''
        : `## Poste ouvert\nArtisa Group recrute actuellement pour le poste ${title} basé à ${location}. Cette offre fait partie des opportunités actives publiées sur la page carrière du groupe pour la Suisse italienne.\n\n## Candidature\nPostulez via le formulaire officiel Artisa Group et consultez le formulaire pour vérifier les éventuelles conditions supplémentaires ainsi que les étapes du recrutement.`,
    },
    slugByLocale: {
      it: slugify(`${titleByLocale.it} Artisa Group ${location}`),
      en: slugify(`${titleByLocale.en} Artisa Group ${location}`),
      de: slugify(`${titleByLocale.de} Artisa Group ${location}`),
      fr: slugify(`${titleByLocale.fr} Artisa Group ${location}`),
    },
  };
}
