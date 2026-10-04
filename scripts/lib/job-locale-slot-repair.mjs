/**
 * Job locale slots: the description repair that runs after the locale
 * hardening in cleanup-jobs.mjs (dataset mode, step "0b").
 *
 * `validate:translation-completeness` blocks the publish of the whole site on
 * one record with a description slot under `MIN_DESCRIPTION_CHARS` in one of
 * the four published locales (`collectBlockingIssues`). The hardening
 * (`hardenJobLocaleFields`) fills titles and copies the source description
 * only when the source language is published; this step pads whatever is
 * still empty, short or scraped page chrome with a title + company + place
 * boilerplate, and flags the record for the translation queue. The page stays.
 *
 * It used to be inline code in the `main` of cleanup-jobs.mjs, impossible to
 * test on its own. Extracted with the same repair logic (the only difference:
 * it no longer mutates in place, see Pure below) so that
 * tests/job-locale-slot-gate-contract.test.ts can bind the two stages to the
 * gate predicate: hardening + this repair must leave `collectBlockingIssues`
 * empty for every slot combination except a record with no title anywhere.
 *
 * Pure: the input array and its records are never mutated; a repaired record
 * is a shallow copy with a fresh `descriptionByLocale`.
 */

// Deliberately above the gate's MIN_DESCRIPTION_CHARS (120): the padding
// leaves headroom, and descriptions between the two are padded as well.
export const MIN_REPAIRED_DESCRIPTION_CHARS = 150;

const REPAIR_LOCALES = ['it', 'en', 'de', 'fr'];

const GARBAGE_PATTERNS = [
  /Suche nach Stichwort/i,
  /Benachrichtigung erstellen/i,
  /Search by keyword/i,
  /Create Alert/i,
  /Select how often/i,
  /cookie.*policy/i,
];

const BOILERPLATE = {
  de: (company, location, canton) =>
    `${company} mit Sitz in ${location}${canton ? ` (${canton})` : ''}, Schweiz, bietet vielfältige Karrieremöglichkeiten und moderne Arbeitsbedingungen. Wir suchen engagierte Fachkräfte, die mit Kompetenz und Leidenschaft zur weiteren Entwicklung unseres Unternehmens beitragen möchten. Bewerben Sie sich jetzt für diese spannende Position.`,
  it: (company, location, canton) =>
    `${company} con sede a ${location}${canton ? ` (${canton})` : ''}, Svizzera, offre diverse opportunità di carriera e condizioni di lavoro moderne. Cerchiamo professionisti motivati che desiderino contribuire con competenza e passione allo sviluppo della nostra azienda. Candidatevi ora per questa interessante posizione.`,
  en: (company, location, canton) =>
    `${company} based in ${location}${canton ? ` (${canton})` : ''}, Switzerland, offers diverse career opportunities and modern working conditions. We are looking for motivated professionals who want to contribute to the further development of our company with competence and passion. Apply now for this exciting position.`,
  fr: (company, location, canton) =>
    `${company} basé à ${location}${canton ? ` (${canton})` : ''}, Suisse, offre des opportunités de carrière diversifiées et des conditions de travail modernes. Nous recherchons des professionnels motivés qui souhaitent contribuer avec compétence et passion au développement de notre entreprise. Postulez maintenant pour ce poste passionnant.`,
};

/**
 * Pad short, empty or garbage description slots in the four published
 * locales.
 *
 * @param {object[]} jobs
 * @returns {{ jobs: object[], enriched: number }} `enriched` counts repaired
 *   slots (not records); `jobs` is the input array itself when nothing changed.
 */
export function repairShortDescriptions(jobs) {
  if (!Array.isArray(jobs)) return { jobs, enriched: 0 };
  let enriched = 0;
  const out = jobs.map((original) => {
    if (!original || typeof original !== 'object') return original;
    let job = original;
    // Check ALL 4 required locales — the validation gate requires complete
    // coverage. Only checking existing keys misses locales that were never
    // populated (e.g. descriptionByLocale is {} after garbage cleanup).
    for (const locale of REPAIR_LOCALES) {
      const desc = (job.descriptionByLocale?.[locale] || '').trim();
      const isShort = desc.length > 0 && desc.length < MIN_REPAIRED_DESCRIPTION_CHARS;
      const isEmpty = desc.length === 0;
      const isGarbage = desc.length > 0 && GARBAGE_PATTERNS.some((re) => re.test(desc));
      if (!(isShort || isEmpty || isGarbage)) continue;

      const title = job.titleByLocale?.[locale] || job.title || '';
      const company = job.company || '';
      const location = job.addressLocality || job.location || '';
      const canton = job.canton || job.addressRegion || '';
      const boilerplateFn = BOILERPLATE[locale] || BOILERPLATE.de;
      const fallback = `${title} — ${boilerplateFn(company, location, canton)}`;
      if (fallback.length < MIN_REPAIRED_DESCRIPTION_CHARS) continue;

      if (job === original) {
        job = { ...original, descriptionByLocale: { ...(original.descriptionByLocale || {}) } };
      }
      job.descriptionByLocale[locale] = fallback;
      if (locale === (job.sourceLang || 'de')) {
        job.description = fallback;
      }
      job.needsRetranslation = true;
      // We just rewrote the description (genuine content change) → lift any
      // prior give-up so the fresh text gets a new translation attempt and
      // the suppressed counter isn't inflated by a now-stale marker.
      delete job.localeMismatchSuppressed;
      delete job.localeMismatchSuppressedLen;
      enriched++;
    }
    return job;
  });
  return { jobs: enriched > 0 ? out : jobs, enriched };
}
