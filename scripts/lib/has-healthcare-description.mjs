/**
 * Description of an HAS Healthcare Advanced Synthesis posting (e-lavoro.ch
 * detail page), and repair of the text the old builder wrote itself
 * (issue 5253). Kept out of `update-has-healthcare-jobs.mjs` because that
 * runner starts crawling on import.
 */

// Sections of the posting published under the page's own headings.
const HAS_DESCRIPTION_SECTIONS = [
  'competenze richieste',
  'saranno richiesti i seguenti compiti',
  'che cosa offriamo',
];

/**
 * The posting's own text (issue 5253): its sections under the page's
 * headings, then the "Lingue richieste" / "Titolo di studio" fields the page
 * shows. The crawler no longer writes a presentation line ("HAS Healthcare
 * Advanced Synthesis, con sede a Biasca (TI), è alla ricerca di: …"), emoji
 * labels of its own, or the "Settore:" / "Sede:" lines; sector and address
 * stay in their structured fields. Returns '' when the page has no section.
 */
export function buildHasDescription(detail) {
  const parts = [];
  for (const key of HAS_DESCRIPTION_SECTIONS) {
    const content = detail.sections?.[key];
    if (content) parts.push([detail.headings?.[key], content].filter(Boolean).join('\n'));
  }
  if (parts.length === 0) return '';
  if (detail.language) parts.push(`Lingue richieste: ${detail.language}`);
  if (detail.education) parts.push(`Titolo di studio: ${detail.education}`);
  return parts.join('\n\n').trim();
}

// Text the old builder wrote itself. A stored job whose source slot carries it
// keeps translations of it through the locale-preserving merge.
const HAS_FABRICATED_LINE_RE = /^(?:.*, con sede a Biasca \(TI\), è alla ricerca di: .*|Settore: Farmaceutico \/ API \(Active Pharmaceutical Ingredients\)|Sede: Via Industria 24, Biasca \(TI\), Svizzera)$/;
const HAS_EMOJI_LABEL_RE = /^(?:📋|🎯|🎁|🗣️|🎓)\s*/;

/**
 * Repair a STORED job written by the old builder before the merge: drop its
 * translations, keep only the page's text in the source slot, and flag it for
 * retranslation. Returns `null` when nothing of the posting's own sections is
 * left (the job never had a source body and is not published), otherwise the
 * job (repaired or untouched).
 *
 * @param {object} job
 * @returns {object|null}
 */
export function dropHasFabricatedText(job) {
  const sourceLang = job?.sourceLang || 'it';
  const source = String(job?.descriptionByLocale?.[sourceLang] || job?.description || '');
  const lines = source.split('\n');
  if (!lines.some((line) => HAS_FABRICATED_LINE_RE.test(line.trim()))) return job;
  const kept = lines
    .filter((line) => !HAS_FABRICATED_LINE_RE.test(line.trim()))
    .map((line) => line.replace(HAS_EMOJI_LABEL_RE, ''));
  const hadSection = lines.some((line) => /^(?:📋|🎯|🎁)/.test(line.trim()));
  if (!hadSection) return null;
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    ...job,
    description: text,
    descriptionByLocale: { [sourceLang]: text },
    needsRetranslation: true,
  };
}
