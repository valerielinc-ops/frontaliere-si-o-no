/**
 * The candidate's browser checks that an uploaded file looks like the
 * document the posting asks for (school reports, the EVA test results…).
 * Owner decision 2026-10-02: a warning, never a block — the candidate may
 * upload it anyway, it is their responsibility — and the verdict is recorded
 * with the file (functions/src/assistedApplicationExtraDocuments.js), never
 * checked again on the server. The text is read here only: nothing of it
 * leaves the browser.
 *
 * pdfjs-dist and mammoth are imported on demand (as in articleDocumentImport.ts),
 * so they stay out of the page's bundle until a candidate picks a file.
 */

export type DocumentCheckVerdict = 'match' | 'mismatch' | 'looks_like_cv' | 'unreadable' | 'unknown';

export interface DocumentCheck {
  verdict: DocumentCheckVerdict;
  /** The word that matched, for a match. */
  matched: string;
  version?: number;
}

export { DOCUMENT_CHECK_VERSION } from '../functions/src/lib/assistedApplicationDocumentCheckVersion.js';
import { DOCUMENT_CHECK_VERSION, DOCUMENT_CHECK_MAX_TEXT_CHARS } from '../functions/src/lib/assistedApplicationDocumentCheckVersion.js';
import { isDegreeCertificateRequirement } from '../functions/src/lib/assistedApplicationDocumentKind.js';

export interface CheckedDocument {
  label: string;
  kind: string;
  keywords: string[];
}

// Words printed on each kind of document, besides the ones the draft read for this posting.
const KIND_WORDS: Record<string, string[]> = {
  school_report: ['bulletin', 'bulletins', 'notes', 'moyenne', 'semestre', 'trimestre', 'zeugnis', 'zeugnisse', 'schulzeugnis', 'noten', 'schuljahr', 'pagella', 'scheda di valutazione', 'anno scolastico', 'voti', 'school report', 'grades', 'school year'],
  aptitude_test: ['test', 'resultats', 'resultat', 'ergebnis', 'ergebnisse', 'risultati', 'results', 'multicheck', 'basic check', 'stellwerk', 'eva', 'gri', 'aptitude', 'eignungstest'],
  diploma: ['diplome', 'diplom', 'diploma', 'cfc', 'efz', 'afp', 'eba', 'attestato', 'certificat federal', 'fahigkeitszeugnis', 'laurea', 'laureato', 'laureata', 'universita', 'universitario', 'universitaria', 'accademico', 'accademica', 'dottore', 'dottorato', 'titolo di studio', 'titolo universitario', 'maturita', 'bachelor', 'master', 'university', 'degree', 'graduation', 'abschluss', 'hochschule', 'universitat', 'baccalaureat', 'licence', 'universite'],
  certificate: ['certificat', 'certificate', 'zertifikat', 'certificato', 'attestato', 'attestation', 'bescheinigung'],
  reference: ['arbeitszeugnis', 'zwischenzeugnis', 'certificat de travail', 'lettre de recommandation', 'reference', 'referenza', 'empfehlungsschreiben', 'recommendation'],
  work_permit: ['permis', 'bewilligung', 'aufenthaltsbewilligung', 'grenzganger', 'permesso', 'frontaliere', 'ausweis', 'autorisation'],
  identity: ['passeport', 'passport', 'reisepass', 'carta d identita', 'identitatskarte', 'carte d identite', 'identity card'],
  portfolio: ['portfolio', 'projet', 'projekt', 'progetto', 'project'],
  other: [],
};

// These document titles identify the type across languages even when the
// posting supplied keywords only in its own language. A CV still takes precedence.
const KIND_TITLES: Record<string, string[]> = {
  diploma: ['diploma di laurea', 'diploma universitario', 'diploma di maturita', 'attestato di laurea', 'attestazione di laurea', 'attestazione del conseguimento della laurea', 'certificazione di laurea', 'certificazione del conseguimento della laurea', 'certificato accademico di laurea', 'certificato di laurea', 'certificato di conseguimento del titolo', 'certificato di completamento degli studi universitari', 'attestato di qualifica professionale', 'degree certificate', 'degree certificates', 'certificate of degree', 'certificates of degree', 'graduation certificate', 'bachelor of science', 'master of science', 'bachelor of arts', 'master of arts', 'bachelorzeugnis', 'masterzeugnis', 'abschlusszeugnis', 'diplomurkunde', 'hochschulabschlusszeugnis', 'hochschulabschluss', 'diplome de licence', 'diplome de master', 'certificat de reussite', 'attestation de diplome', 'certificat de diplome'],
  reference: ['attestato di lavoro', 'certificato di lavoro', 'lettera di referenza', 'lettera di raccomandazione', 'arbeitszeugnis', 'zwischenzeugnis', 'certificat de travail', 'lettre de recommandation', 'employment reference', 'reference letter'],
  school_report: ['scheda di valutazione', 'bulletin scolaire', 'schulzeugnis', 'school report'],
  aptitude_test: ['multicheck', 'basic check', 'stellwerk', 'eva test', 'gri test', 'aptitude test', 'eignungstest', 'test d aptitudes', 'test di attitudine'],
  identity: ['carta d identita', 'carte d identite', 'identity card', 'identitatskarte', 'reisepass', 'passeport', 'passport'],
  work_permit: ['work permit', 'permis de travail', 'permis de sejour', 'arbeitsbewilligung', 'permesso di lavoro'],
  portfolio: ['portfolio'],
};

// Explicit degree-document names. Generic education terms such as master,
// university, maturità and doctor are not proof that a degree was earned.
const DEGREE_CERTIFICATE_TITLES = [
  'diploma di laurea', 'diploma universitario', 'attestato di laurea', 'attestazione di laurea',
  'attestazione del conseguimento della laurea', 'certificazione di laurea',
  'certificazione del conseguimento della laurea', 'certificato accademico di laurea',
  'certificato di laurea', 'certificato di completamento degli studi universitari',
  'degree certificate', 'degree certificates', 'certificate of degree', 'certificates of degree',
  'bachelorzeugnis', 'masterzeugnis', 'hochschulabschlusszeugnis', 'hochschulabschluss',
  'diplome universitaire', 'diplome de licence', 'diplome de master',
];

// A mismatch is useful only when the readable text positively identifies a
// different document. Otherwise it is an unknown result, not evidence that
// the candidate chose the wrong file.
const CLEAR_NON_DOCUMENT_TITLES = [
  'invoice', 'invoice number', 'fattura', 'numero fattura', 'rechnung', 'rechnungsnummer', 'facture', 'numero de facture',
  'template', 'fac simile', 'facsimile', 'modello di certificato', 'modello amministrativo',
];
const CLEAR_OTHER_DOCUMENT_TITLES = [
  'certificato di residenza', 'attestazione di residenza', 'certificate of residence', 'certificat de residence', 'wohnmeldebestatigung',
];
function hasKnownOtherDocumentType(haystack: string, kind: string): boolean {
  if (!kind || kind === 'other') return false;
  const heading = haystack.slice(0, 360);
  if (kind === 'certificate') return found(heading, CLEAR_NON_DOCUMENT_TITLES).length > 0;
  const otherTitles = Object.entries(KIND_TITLES)
    .filter(([candidateKind]) => candidateKind !== kind)
    .flatMap(([, titles]) => titles)
    // Cross-kind precedence needs a specific document title, not a generic
    // word that may appear in ordinary content (for example, "reference number").
    .filter(title => normalize(title).trim().includes(' '));
  return found(heading, [...otherTitles, ...CLEAR_NON_DOCUMENT_TITLES, ...CLEAR_OTHER_DOCUMENT_TITLES]).length > 0;
}

function hasClearNonDocumentHeading(haystack: string): boolean {
  const heading = haystack.slice(0, 360);
  return CLEAR_NON_DOCUMENT_TITLES.some(title => heading.startsWith(` ${normalize(title).trim()} `));
}

function hasClearCvHeading(haystack: string): boolean {
  const heading = haystack.slice(0, 180);
  return found(heading, ['curriculum vitae', 'lebenslauf', 'resume']).length > 0
    || / cv /.test(heading);
}

// Italian registrars also certify a completed degree exam without printing a
// degree title. Require the certification and the completed exam together:
// "certificato" alone also describes residence and other unrelated documents.
const NON_ACADEMIC_CERTIFICATION_CONTEXT = [
  ...CLEAR_NON_DOCUMENT_TITLES, ...CLEAR_OTHER_DOCUMENT_TITLES,
  ...KIND_TITLES.reference,
];
const ITALIAN_DEGREE_CERTIFICATION = / (?:si certifica|si attesta) che (?:(?!\b(?:non|mai|dovra|deve)\b)[a-z0-9 ]){0,160}ha superato (?:in data [0-3]?\d [01]?\d (?:19|20)\d{2} )?(?:con (?:voti|votazione) (?:[a-z0-9]+ ){1,10})?l esame di laurea /;
const ITALIAN_DEGREE_NEGATION = / (?:non si (?:certifica|attesta)|mai si (?:certifica|attesta)|non ha(?: ancora)? superato|deve sostenere) [a-z0-9 ]{0,160}esame di laurea /;
const DEGREE_QUALIFICATION = [
  'laurea(?: (?:magistrale|triennale|specialistica))?', 'diploma universitario',
  'titolo universitario', 'titolo di dottore', 'dottorato',
  'bachelor of (?:science|arts)', 'bachelor(?: s)? degree',
  'master of (?:science|arts)', 'master(?: s)? degree', 'degree', 'licence',
  'diplome de (?:licence|master)', 'hochschulabschluss',
].join('|');
const DEGREE_AWARD = [
  'conseguit\\w*', 'conferit\\w*', 'conferis\\w*', 'ottenut\\w*', 'rilasciat\\w*',
  'awarded', 'conferred', 'earned', 'obtained', 'received', 'issued', 'granted',
  'delivre\\w*', 'obtenu\\w*', 'attribu\\w*', 'verliehen', 'erworben',
].join('|');
const DEGREE_WORD_GAP = '(?: [a-z0-9]+){0,12}';
const DEGREE_NEGATION = '(?:not|never|no|non|mai|nicht|pas)';
const DEGREE_QUALIFICATION_PATTERN = '(?:' + DEGREE_QUALIFICATION + ')';
const DEGREE_AWARD_PATTERN = '(?:' + DEGREE_AWARD + ')';
const DEGREE_NOT_AWARDED = new RegExp(
  ' (?:' + DEGREE_QUALIFICATION_PATTERN + DEGREE_WORD_GAP + ' ' + DEGREE_NEGATION + DEGREE_WORD_GAP + ' ' + DEGREE_AWARD_PATTERN
  + '|' + DEGREE_NEGATION + DEGREE_WORD_GAP + ' ' + DEGREE_AWARD_PATTERN + DEGREE_WORD_GAP + ' ' + DEGREE_QUALIFICATION_PATTERN
  + '|' + DEGREE_NEGATION + DEGREE_WORD_GAP + ' ' + DEGREE_QUALIFICATION_PATTERN + DEGREE_WORD_GAP + ' ' + DEGREE_AWARD_PATTERN
  + '|' + DEGREE_AWARD_PATTERN + DEGREE_WORD_GAP + ' ' + DEGREE_NEGATION + DEGREE_WORD_GAP + ' ' + DEGREE_QUALIFICATION_PATTERN + ') '
);
const COMPLETED_DEGREE = new RegExp(
  ' (?:' + DEGREE_QUALIFICATION_PATTERN + DEGREE_WORD_GAP + ' ' + DEGREE_AWARD_PATTERN
  + '|' + DEGREE_AWARD_PATTERN + DEGREE_WORD_GAP + ' ' + DEGREE_QUALIFICATION_PATTERN + ') '
);
function hasGermanUniversityCompletion(haystack: string): boolean {
  return found(haystack, ['universitat', 'hochschule']).length > 0
    && found(haystack, ['abschlusszeugnis']).length > 0
    && / abgeschloss\w* (?:studiengang|studium) /.test(haystack);
}

// What a CV says about itself: in a file that should be something else, the candidate picked their CV.
const CV_WORDS = [
  'curriculum vitae', 'lebenslauf', 'resume', 'esperienza professionale', 'esperienze lavorative', 'esperienze professionali',
  'berufserfahrung', 'berufliche erfahrung', 'experience professionnelle', 'experiences professionnelles', 'work experience',
  'professional experience', 'istruzione e formazione', 'formazione', 'ausbildung', 'formation', 'skills', 'competenze',
  'competences', 'kompetenzen', 'dati personali', 'personliche daten', 'donnees personnelles', 'profilo', 'sprachkenntnisse', 'conoscenze linguistiche',
];

// Fewer readable characters than this: a photo or a scan, nothing to judge.
const MIN_TEXT_CHARS = 40;

function normalize(value: string): string {
  return ` ${String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

function found(haystack: string, words: string[]): string[] {
  return words.map((word) => normalize(word).trim()).filter((word) => word.length >= 3 && haystack.includes(` ${word} `));
}

/** The verdict on a file's text for the requested document (pure: the page and the tests use it). */
export function classifyDocumentText(text: string, document: CheckedDocument): DocumentCheck {
  const haystack = normalize(String(text || '').slice(0, DOCUMENT_CHECK_MAX_TEXT_CHARS));
  if (haystack.trim().length < MIN_TEXT_CHARS) return { verdict: 'unreadable', matched: '' };
  const asked = found(haystack, document.keywords || []);
  const usual = found(haystack, KIND_WORDS[document.kind] || []);
  const cv = found(haystack, CV_WORDS);
  const degreeCertificateRequest = document.kind === 'diploma' && isDegreeCertificateRequirement(document.label);
  const titles = found(haystack, degreeCertificateRequest
    ? DEGREE_CERTIFICATE_TITLES
    : (KIND_TITLES[document.kind] || []));

  // A clear file type takes precedence over phrases that merely mention the
  // requested document in the body.
  if (cv.length >= 3 || hasClearCvHeading(haystack)) return { verdict: 'looks_like_cv', matched: '' };
  if (hasKnownOtherDocumentType(haystack, document.kind) || hasClearNonDocumentHeading(haystack)) {
    return { verdict: 'mismatch', matched: '' };
  }
  if (document.kind !== 'diploma' && (
    found(haystack.slice(0, 360), KIND_TITLES.diploma).length > 0
    || ITALIAN_DEGREE_CERTIFICATION.test(haystack)
    || COMPLETED_DEGREE.test(haystack)
    || hasGermanUniversityCompletion(haystack)
  )) return { verdict: 'mismatch', matched: '' };
  if (degreeCertificateRequest && DEGREE_NOT_AWARDED.test(haystack)) return { verdict: 'mismatch', matched: '' };
  if (document.kind === 'diploma' && ITALIAN_DEGREE_NEGATION.test(haystack)) return { verdict: 'mismatch', matched: '' };

  // A degree-certificate requirement needs either a named credential or an
  // explicit completion/award statement; broad terms and model keywords alone
  // do not establish that a university degree was earned.
  if (degreeCertificateRequest) {
    const degreeTitle = found(haystack.slice(0, 360), DEGREE_CERTIFICATE_TITLES)[0];
    if (degreeTitle) return { verdict: 'match', matched: degreeTitle };
    if (!found(haystack, NON_ACADEMIC_CERTIFICATION_CONTEXT).length
      && (ITALIAN_DEGREE_CERTIFICATION.test(haystack) || COMPLETED_DEGREE.test(haystack)
        || hasGermanUniversityCompletion(haystack))) {
      const awardedDegree = found(haystack, [
        'laurea', 'diploma universitario', 'titolo universitario', 'titolo di dottore', 'dottorato',
        'bachelor', 'master', 'degree', 'licence', 'baccalaureat', 'diplome de licence',
        'diplome de master', 'hochschulabschluss',
      ])[0];
      const matched = ITALIAN_DEGREE_CERTIFICATION.test(haystack) ? 'esame di laurea' : (awardedDegree || 'degree');
      return { verdict: 'match', matched };
    }
    return { verdict: 'unknown', matched: '' };
  }

  if (asked.length) return { verdict: 'match', matched: asked[0] };
  if (titles.length && cv.length < 2) return { verdict: 'match', matched: titles[0] };
  if (document.kind === 'diploma' && cv.length < 2
    && !/ (?:non|mai) si (?:certifica|attesta) /.test(haystack)
    && !found(haystack, NON_ACADEMIC_CERTIFICATION_CONTEXT).length
    && ITALIAN_DEGREE_CERTIFICATION.test(haystack)) return { verdict: 'match', matched: 'esame di laurea' };
  if (usual.length >= 2) return { verdict: 'match', matched: usual[0] };
  if (cv.length >= 2) return { verdict: 'looks_like_cv', matched: '' };
  if (hasKnownOtherDocumentType(haystack, document.kind)) return { verdict: 'mismatch', matched: '' };
  return { verdict: 'unknown', matched: '' };
}

async function pdfText(file: File): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;
  const loading = pdfjsLib.getDocument({ data: await file.arrayBuffer() });
  try {
    const pdf = await loading.promise;
    const pages: string[] = [];
    // The first pages say what the document is.
    for (let pageNum = 1; pageNum <= Math.min(pdf.numPages, 5); pageNum += 1) {
      const content = await (await pdf.getPage(pageNum)).getTextContent();
      pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
      if (pages.join('\n').length >= DOCUMENT_CHECK_MAX_TEXT_CHARS) break;
    }
    return pages.join('\n').slice(0, DOCUMENT_CHECK_MAX_TEXT_CHARS);
  } finally {
    await loading.destroy();
  }
}

async function docxText(file: File): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return value.slice(0, DOCUMENT_CHECK_MAX_TEXT_CHARS);
}

/** The file's readable text: PDF and Word; a photo, a scan or an old .doc has none here. */
export async function readDocumentText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  try {
    if (file.type === 'application/pdf' || name.endsWith('.pdf')) return await pdfText(file);
    if (name.endsWith('.docx')) return await docxText(file);
  } catch {
    // A file the browser cannot read is judged as unreadable, never as wrong.
  }
  return '';
}

export async function checkDocumentFile(file: File, document: CheckedDocument): Promise<DocumentCheck> {
  return { ...classifyDocumentText(await readDocumentText(file), document), version: DOCUMENT_CHECK_VERSION };
}
