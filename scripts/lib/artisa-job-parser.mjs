import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
import { JSDOM } from 'jsdom';
import { inferAnyCanton } from './target-swiss-locations.mjs';
import { isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { sourceLocaleDescription } from './source-locale-description.mjs';
import { dropFabricatedDescription } from './drop-fabricated-description.mjs';

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
// fetch). For a zero, the page must also have no candidate vacancy headings;
// for a non-empty result, every candidate heading must produce a parsed row.
// These checks allow a single real vacancy without using a numeric floor.
const LANDMARK_TITLES = ['carriera', 'le nostre sedi'];

function isCandidateTitle(value = '') {
  const text = normalizeText(value);
  return Boolean(text) && !NON_JOB_TITLES.has(text);
}

function classifyArtisaLocation(value = '') {
  const location = normalizeSpace(value);
  if (!location) return 'unrecognised';
  if (isLocationExplicitlyForeign(location)) return 'foreign';
  if (inferAnyCanton(location)) return 'swiss';
  return 'unrecognised';
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
  // Vacancy `h2` headings and orphan Smartsheet form anchors seen before any
  // downstream gate: neither the `title && location` flush gate nor the
  // Swiss-location filter can shrink the source-side candidate count.
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
    if (!current) {
      // A form anchor without a current vacancy heading is still source
      // evidence that the vacancy parser missed something. Do not let the two
      // surrounding landmarks turn that selector drift into an authoritative
      // zero.
      if (tag === 'a') candidateVacancies += 1;
      continue;
    }
    if (tag === 'a' && !current.applyUrl) {
      current.applyUrl = String(node.getAttribute('href') || '').trim();
      flush();
    }
  }

  flush();
  const targetJobs = jobs.filter((job) => classifyArtisaLocation(job.location) === 'swiss');
  const landmarksComplete = LANDMARK_TITLES.every((title) => landmarks.has(title));
  const locationClassifications = jobs.map((job) => classifyArtisaLocation(job.location));
  const unrecognisedLocations = locationClassifications
    .filter((classification) => classification === 'unrecognised').length;
  // A zero is authoritative only when the page rendered in full AND listed no
  // vacancy at all. A non-empty snapshot is authoritative only when every
  // candidate vacancy heading became a parsed row. Qualifying on
  // `targetJobs.length === 0` alone would make selector drift indistinguishable
  // from a real zero: if Squarespace moves the location out of `h4`, or changes
  // its wording so `isTargetSwissLocation()` stops matching, vacancies could be
  // silently discarded while both landmarks still render.
  const parsedVacancies = jobs.length;
  const completeLocationClassification = unrecognisedLocations === 0;
  const completeCandidateSnapshot = (
    landmarksComplete
    && candidateVacancies === parsedVacancies
    && completeLocationClassification
  );
  Object.defineProperties(targetJobs, {
    artisaSnapshotState: {
      value: completeCandidateSnapshot
        ? candidateVacancies === 0 ? 'authoritative-site-zero' : 'authoritative-site-snapshot'
        : 'unverified',
      enumerable: false,
    },
    artisaCandidateVacancies: { value: candidateVacancies, enumerable: false },
    artisaParsedVacancies: { value: parsedVacancies, enumerable: false },
    artisaLocationClassificationComplete: {
      value: completeLocationClassification,
      enumerable: false,
    },
    artisaUnrecognisedLocationCount: { value: unrecognisedLocations, enumerable: false },
  });
  // Why the state is `unverified`, in the words of what the page actually
  // rendered (issue #7425 item 3). Without it the crawler's only signal reads
  // "landmarks missing" even when both landmarks are there and the page simply
  // listed an opening — so a Squarespace re-wording of `carriera` / `le nostre
  // sedi` and a partial vacancy parse produce the SAME red. Naming the cause
  // costs a string; guessing it costs a fixer run per occurrence.
  const missingLandmarks = LANDMARK_TITLES.filter((title) => !landmarks.has(title));
  Object.defineProperty(targetJobs, 'artisaSnapshotReason', {
    value: missingLandmarks.length > 0
      ? `landmark h2 not found: ${missingLandmarks.join(', ')} — h2 rendered: ${headingsSeen.join(' | ') || '(none)'}`
      : `${candidateVacancies} candidate vacancy h2 present, ${jobs.length} row(s) parsed, `
        + `${unrecognisedLocations} location(s) unrecognised — h2 rendered: ${headingsSeen.join(' | ')}`,
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
 * Verify that a non-empty snapshot contains every vacancy heading the source
 * rendered. The parser records the source-DOM heading total and the parsed-row
 * total, so this is a structural completeness check, not a minimum-count gate:
 * one fully parsed vacancy is as valid as any larger complete snapshot.
 *
 * @param {object[]|undefined|null} jobs
 * @returns {true}
 */
export function assertCompleteArtisaListingSnapshot(jobs) {
  const candidateVacancies = Array.isArray(jobs)
    ? Number(Reflect.get(jobs, 'artisaCandidateVacancies'))
    : Number.NaN;
  const parsedVacancies = Array.isArray(jobs)
    ? Number(Reflect.get(jobs, 'artisaParsedVacancies'))
    : Number.NaN;
  const locationClassificationComplete = Array.isArray(jobs)
    && Reflect.get(jobs, 'artisaLocationClassificationComplete') === true;
  if (
    !Array.isArray(jobs)
    || jobs.length === 0
    || Reflect.get(jobs, 'artisaSnapshotState') !== 'authoritative-site-snapshot'
    || !Number.isInteger(candidateVacancies)
    || candidateVacancies === 0
    || candidateVacancies !== parsedVacancies
    || !locationClassificationComplete
  ) {
    const reason = Array.isArray(jobs)
      ? Reflect.get(jobs, 'artisaSnapshotReason') || `${jobs.length} row(s) parsed`
      : 'parser returned no array';
    throw new Error(`Artisa Group snapshot is not a complete non-empty state: ${reason}`);
  }
  return true;
}

/**
 * Verify a complete source snapshot whose target-location filter produced no
 * rows. A full DOM and a candidate/row count are not enough: every candidate
 * location must also be classified as Swiss or explicitly foreign, otherwise
 * an unrecognised location could hide a Swiss vacancy behind the empty target.
 *
 * @param {object[]|undefined|null} jobs
 * @returns {true}
 */
export function assertCompleteArtisaTargetSnapshot(jobs) {
  const candidateVacancies = Array.isArray(jobs)
    ? Number(Reflect.get(jobs, 'artisaCandidateVacancies'))
    : Number.NaN;
  const parsedVacancies = Array.isArray(jobs)
    ? Number(Reflect.get(jobs, 'artisaParsedVacancies'))
    : Number.NaN;
  const isCompleteFilteredSnapshot = (
    Array.isArray(jobs)
    && jobs.length === 0
    && Reflect.get(jobs, 'artisaSnapshotState') === 'authoritative-site-snapshot'
    && Number.isInteger(candidateVacancies)
    && candidateVacancies > 0
    && candidateVacancies === parsedVacancies
    && Reflect.get(jobs, 'artisaLocationClassificationComplete') === true
  );
  if (isCompleteFilteredSnapshot) return true;
  if (
    Array.isArray(jobs)
    && Reflect.get(jobs, 'artisaUnrecognisedLocationCount') > 0
  ) {
    throw new Error(
      `Artisa Group snapshot contains ${Reflect.get(jobs, 'artisaUnrecognisedLocationCount')} unrecognised location(s)`,
    );
  }
  return assertCompleteArtisaSnapshot(jobs);
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

  // The Smartsheet form text is the posting: it is published in its own
  // language slot and the translation step fills the others. Without it there
  // is no description — this used to return "## Posizione aperta / Artisa
  // Group ha aperto una selezione per il ruolo …" (and English, German and
  // French twins in the other slots), text Artisa never published, which the
  // runner also wrote into every locale the translation step had not filled.
  const source = sourceLocaleDescription(detailDescription, { defaultLang: 'it' });

  return {
    titleByLocale,
    description: source.description,
    sourceLang: source.sourceLang,
    descriptionByLocale: source.description ? source.descriptionByLocale : {},
    slugByLocale: {
      it: slugify(`${titleByLocale.it} Artisa Group ${location}`),
      en: slugify(`${titleByLocale.en} Artisa Group ${location}`),
      de: slugify(`${titleByLocale.de} Artisa Group ${location}`),
      fr: slugify(`${titleByLocale.fr} Artisa Group ${location}`),
    },
  };
}

// The text this crawler used to write itself: the four templates the builder (and the locale repair) wrote ("## Posizione aperta / Artisa Group ha aperto una selezione…", "## Open position…", "## Offene Stelle…", "## Poste ouvert…").
// Only ever recognised, to be removed from stored records (issue 5253).
export const ARTISA_FABRICATED_RE = /Artisa Group (?:ha aperto una selezione per il ruolo |is currently hiring for the |rekrutiert derzeit für die Position |recrute actuellement pour le poste )/;

/**
 * Remove that text from a stored job before the locale-preserving merge: the
 * slots and flat `description` that carry it and the translations made from
 * it (`dropFabricatedDescription`); the job is flagged for retranslation.
 *
 * @returns {boolean} true when the job changed.
 */
export function dropArtisaFabricatedText(job) {
  return dropFabricatedDescription(job, ARTISA_FABRICATED_RE);
}
