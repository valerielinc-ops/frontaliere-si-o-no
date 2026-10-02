/**
 * Which application this is, decided in code (study 2026-10-02,
 * report-cv-lettera §4): the CV and the letter follow the template of the
 * type, the way the Swiss career services (SDBB/CSFO) and SECO describe them.
 *   apprentice  the posting is an apprenticeship (Lehrstelle, apprendistato,
 *               place d'apprentissage): school, taster placements, aptitude
 *               tests, interests and references; no professional summary;
 *   first_job   no job of the candidate yet, only placements, side jobs or
 *               volunteering: education before experience;
 *   qualified   everything else.
 * The sector (health, IT) only adds the sections such CVs need
 * (recognition of the diploma, projects).
 */

const APPRENTICESHIP = /\b(?:lehrstelle|lernende[rn]?\b|lernende\/r|lehrling|lehrbeginn|lehre als|berufslehre|apprendist\w*|tirocinio|posto di tirocinio|apprenti(?:e|s)?\b|apprentissage|place d'apprentissage|apprenticeship|trainee position)/i;
const HEALTH = /\b(?:pflege\w*|fage|fachfrau gesundheit|fachmann gesundheit|mpa\b|infermier\w*|infirmi\w*|oss\b|assc\b|ospedal\w*|spital\w*|hôpital|clinic\w*|klinik\w*|medizin\w*|médic\w*|medic\w*|nurs\w*|hebamme|sage-femme|ostetric\w*|physiotherap\w*|fisioterap\w*)/i;
// "IT" alone only in capitals: case-insensitive it would read the English and Italian word.
const IT_ACRONYM = /\bIT\b/;
const IT = /\b(?:informatik\w*|informatic\w*|informaticien\w*|software|entwickl\w*|sviluppat\w*|développeu\w*|developer|devops|ict\b|it-|data engineer|full-?stack|front-?end|back-?end|applikationsentwicklung|plattformentwicklung)/i;

const NOT_A_JOB = new Set(['internship', 'trial_apprenticeship', 'side_job', 'volunteer']);

/**
 * @param {{profile?:object, postingTitle?:string, postingText?:string}} input
 * @returns {{type:'apprentice'|'first_job'|'qualified', sector:'health'|'it'|'other'}}
 */
export function candidateType({ profile = {}, postingTitle = '', postingText = '' } = {}) {
  const posting = `${postingTitle}\n${String(postingText).slice(0, 4000)}`;
  const jobs = (profile.experience || []).filter((role) => !NOT_A_JOB.has(role.kind));
  const type = APPRENTICESHIP.test(postingTitle) || (APPRENTICESHIP.test(posting) && jobs.length === 0)
    ? 'apprentice'
    : jobs.length === 0 ? 'first_job' : 'qualified';
  const profileText = [profile.headline, ...(profile.experience || []).map((role) => role.role), ...(profile.education || []).map((item) => item.degree)].join('\n');
  const sector = HEALTH.test(postingTitle) || HEALTH.test(profileText)
    ? 'health'
    : [postingTitle, profileText].some((text) => IT.test(text) || IT_ACRONYM.test(text)) ? 'it' : 'other';
  return { type, sector };
}

const APPRENTICE_PREFIX = /^(?:lehrstelle (?:als )?|lernende\/?r?\s+|lernender\s+|lernende\s+|apprendista\s+|apprenti(?:e)?\s+|apprenti·e\s+|place d'apprentissage (?:de |d')?|posto di tirocinio (?:come )?)/i;
const TARGET = { de: 'Berufswunsch', fr: 'Objectif professionnel', it: 'Obiettivo professionale', en: 'Career goal' };

/**
 * The apprentice's headline: the trade they apply for, said as a goal ("Berufswunsch:
 * Informatiker/in EFZ Applikationsentwicklung"), never as a role they already have.
 */
export function apprenticeHeadline(title, language = 'it') {
  const trade = String(title || '').replace(APPRENTICE_PREFIX, '').replace(/\s{2,}/g, ' ').trim();
  // French puts a no-break space before the colon.
  return trade ? `${TARGET[language] || TARGET.it}${language === 'fr' ? ' :' : ':'} ${trade}` : '';
}
