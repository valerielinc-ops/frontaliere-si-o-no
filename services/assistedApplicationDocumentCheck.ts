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

export type DocumentCheckVerdict = 'match' | 'mismatch' | 'looks_like_cv' | 'unreadable';

export interface DocumentCheck {
  verdict: DocumentCheckVerdict;
  /** The word that matched, for a match. */
  matched: string;
}

export interface CheckedDocument {
  label: string;
  kind: string;
  keywords: string[];
}

// Words printed on each kind of document, besides the ones the draft read for this posting.
const KIND_WORDS: Record<string, string[]> = {
  school_report: ['bulletin', 'bulletins', 'notes', 'moyenne', 'semestre', 'trimestre', 'zeugnis', 'zeugnisse', 'schulzeugnis', 'noten', 'schuljahr', 'pagella', 'scheda di valutazione', 'anno scolastico', 'voti', 'school report', 'grades', 'school year'],
  aptitude_test: ['test', 'resultats', 'resultat', 'ergebnis', 'ergebnisse', 'risultati', 'results', 'multicheck', 'basic check', 'stellwerk', 'eva', 'gri', 'aptitude', 'eignungstest'],
  diploma: ['diplome', 'diplom', 'diploma', 'cfc', 'efz', 'afp', 'eba', 'attestato', 'certificat federal', 'fahigkeitszeugnis'],
  certificate: ['certificat', 'certificate', 'zertifikat', 'certificato', 'attestato', 'attestation', 'bescheinigung'],
  reference: ['arbeitszeugnis', 'zwischenzeugnis', 'certificat de travail', 'lettre de recommandation', 'reference', 'referenza', 'empfehlungsschreiben', 'recommendation'],
  work_permit: ['permis', 'bewilligung', 'aufenthaltsbewilligung', 'grenzganger', 'permesso', 'frontaliere', 'ausweis', 'autorisation'],
  identity: ['passeport', 'passport', 'reisepass', 'carta d identita', 'identitatskarte', 'carte d identite', 'identity card'],
  portfolio: ['portfolio', 'projet', 'projekt', 'progetto', 'project'],
  other: [],
};

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
  const haystack = normalize(text);
  if (haystack.trim().length < MIN_TEXT_CHARS) return { verdict: 'unreadable', matched: '' };
  const asked = found(haystack, document.keywords || []);
  const usual = found(haystack, KIND_WORDS[document.kind] || []);
  const cv = found(haystack, CV_WORDS);
  // Unless the CV is what the posting asked for, a file that reads as a CV is the CV.
  if (cv.length >= 3 && asked.length < 2) return { verdict: 'looks_like_cv', matched: '' };
  if (asked.length) return { verdict: 'match', matched: asked[0] };
  if (usual.length >= 2) return { verdict: 'match', matched: usual[0] };
  if (cv.length >= 2) return { verdict: 'looks_like_cv', matched: '' };
  return { verdict: 'mismatch', matched: '' };
}

async function pdfText(file: File): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages: string[] = [];
  // The first pages say what the document is.
  for (let pageNum = 1; pageNum <= Math.min(pdf.numPages, 5); pageNum += 1) {
    const content = await (await pdf.getPage(pageNum)).getTextContent();
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }
  return pages.join('\n');
}

async function docxText(file: File): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return value;
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
  return classifyDocumentText(await readDocumentText(file), document);
}
