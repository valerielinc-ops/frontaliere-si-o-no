import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { jsPDF } from 'jspdf';
import sharp from 'sharp';
import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { getDocumentProxy, getResolvedPDFJS } from 'unpdf';
import { JPEG_2X2, pdfPaintsImage } from './helpers/pdfImages';
import {
  MERGED_MAX_BYTES,
  adPackaging,
  checkMergedPdf,
  classifyAdPackaging,
  dossierAttachment,
  groupDocuments,
  isSignedPdf,
  jpegOrientation,
  mergeParts,
  packageAttachments,
  packagingDecision,
} from '../scripts/assisted-application/lib/dossier.mjs';
import { renderCvPdf, renderLetterPdf } from '../functions/src/assistedApplicationPdfRenderer.js';
import { applyLetterConventions, letterEnclosures, letterPdfBlocks, sanitizeProfile } from '../functions/src/assistedApplicationAiDraftCore.js';
import { buildCvDocument } from '../functions/src/assistedApplicationCvDocument.js';
import { sanitizeTailoredCv } from '../functions/src/assistedApplicationTailoredCv.js';

// How an e-mail application's files leave (lib/dossier.mjs; decisions of 2026-10-03 on the verified
// sources, docs/assisted-application/decisioni.md §5). An invented candidate (study 2026-10-02).
const NOW = Date.UTC(2026, 9, 3);
const MiB = 1024 * 1024;

const pdfOf = (text: string, pages = 1) => {
  const doc = new jsPDF();
  for (let page = 0; page < pages; page += 1) {
    if (page) doc.addPage();
    doc.text(`${text} ${page + 1}`, 20, 20);
  }
  return Buffer.from(doc.output('arraybuffer'));
};
// Incompressible bytes (SHA-256 in counter mode): pdf-lib's deflate cannot shrink them below a byte limit.
const noise = (length: number) => {
  const out = Buffer.alloc(length);
  for (let offset = 0, counter = 0; offset < length; counter += 1) offset += createHash('sha256').update(String(counter)).digest().copy(out, offset);
  return out;
};
const noiseJpg = (width: number, height: number, quality = 40) => sharp(noise(width * height * 3), { raw: { width, height, channels: 3 } }).jpeg({ quality });
const noisePng = (width: number, height: number) => sharp(noise(width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer();
const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200)]);
const encryptedPdf = () => {
  const doc = new jsPDF({ encryption: { userPassword: 'aperto', ownerPassword: 'chiuso', userPermissions: ['print'] } });
  doc.text('Zeugnis', 20, 20);
  return Buffer.from(doc.output('arraybuffer'));
};
// A scanned letter: an image and no text layer.
const imageOnlyPdf = () => {
  const doc = new jsPDF();
  doc.addImage(new Uint8Array(JPEG_2X2), 'JPEG', 10, 10, 50, 50);
  return Buffer.from(doc.output('arraybuffer'));
};
/**
 * A PDF with a signature dictionary as a signing tool writes it: uncompressed, /ByteRange and the /Contents
 * hex string, the field in the AcroForm (with /SigFlags unless left out).
 */
async function signedPdf(text: string, { byteRange = true, sigFlags = true } = {}) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([595.28, 841.89]);
  page.drawText(text, { x: 50, y: 780, size: 12 });
  const signature = doc.context.obj({
    Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached',
    ...(byteRange ? { ByteRange: [0, 0, 0, 0] } : {}),
    Contents: PDFHexString.of('00'.repeat(64)),
  });
  const field = doc.context.register(doc.context.obj({
    FT: 'Sig', T: PDFString.of('Signature1'), V: doc.context.register(signature), Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 0, 0], F: 132, P: page.ref,
  }));
  page.node.set(PDFName.of('Annots'), doc.context.obj([field]));
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [field], ...(sigFlags ? { SigFlags: 3 } : {}) }));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function pageTexts(bytes: Buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  const out: string[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    out.push((await (await pdf.getPage(number)).getTextContent()).items.map((item: any) => item.str || '').join(' ').replace(/\s+/g, ' ').trim());
  }
  return out;
}
/** The drawing matrix of each page's image (pdf.js OPS.transform, the `cm` before the image). */
async function imageMatrices(bytes: Buffer) {
  const { OPS } = await getResolvedPDFJS();
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  const out: number[][] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const operators = await (await pdf.getPage(number)).getOperatorList();
    const index = operators.fnArray.indexOf(OPS.transform);
    out.push(index >= 0 ? Array.from(operators.argsArray[index] as number[]) : []);
  }
  return out;
}
const sizes = async (bytes: Buffer) => (await PDFDocument.load(bytes, { updateMetadata: false })).getPages().map((page) => [Math.round(page.getWidth()), Math.round(page.getHeight())]);

// A letter and a tailored CV written by Typst, as the runner writes them.
const profileRaw = {
  headline: 'Pflegefachfrau HF', location: 'Como', languages: [{ language: 'Deutsch', level: 'B2' }],
  experience: [{ role: 'Pflegefachfrau', employer: 'Spital Beispiel', location: 'Lugano', start: '2018', end: '2023', kind: 'job', highlights: ['Station mit 24 Betten'] }],
  education: [], certifications: [], skills: [],
};
const identity = { name: 'Maria Rossi', email: 'candidatura-x1@frontaliereticino.ch', phone: '+41 79 000 00 00' };
async function typstLetterAndCv() {
  const profile = sanitizeProfile(profileRaw);
  const letter = await renderLetterPdf(letterPdfBlocks({
    identity, profile, posting: { contactPerson: '', streetAddress: 'Beispielstrasse 1', postalCode: '8000', location: 'Zürich' }, companyName: 'Beispiel AG', language: 'de',
    letter: applyLetterConventions({ paragraphs: ['Seit 2018 arbeite ich auf einer Station mit 24 Betten.', 'Zweiter Absatz des Schreibens.'] }, { language: 'de', contactPerson: '' }),
    title: 'Pflegefachfrau', now: new Date(NOW), enclosures: letterEnclosures('de', ['Arbeitszeugnisse']),
  }));
  const cv = await renderCvPdf(buildCvDocument(sanitizeTailoredCv(
    { headline: 'Pflegefachfrau HF', summary: 'Pflegefachfrau mit Stationserfahrung.', competencies: [], experience: [], skills: [] },
    { profile, cvText: JSON.stringify(profileRaw), language: 'de', type: 'qualified', sector: 'health', title: 'Pflegefachfrau' },
  ), { identity, profile, language: 'de', type: 'qualified', sector: 'health' }));
  expect([letter.renderer, cv.renderer]).toEqual(['typst', 'typst']);
  return { letter: letter.pdf, cv: cv.pdf };
}

const file = (fileName: string, buffer: Buffer, type: string) => ({ fileName, buffer, type, key: `assisted-application-uploads/order_PACK01/${fileName}` });
const extras = (...files: Array<ReturnType<typeof file>>) => [{ slot: 'extra_1', label: 'Arbeitszeugnisse', kind: 'reference', files }];
const input = (fixtures: { letter: Buffer, cv: Buffer }, over: Record<string, any> = {}) => ({
  language: 'de', name: 'Maria Rossi', stem: 'Maria_Rossi',
  cv: { buffer: fixtures.cv, type: 'pdf', name: 'CV_Maria_Rossi.pdf', key: 'assisted-application-uploads/order_PACK01/ai-cv-r1-1.pdf' },
  letter: { buffer: fixtures.letter, name: 'Motivationsschreiben_Maria_Rossi.pdf', key: null },
  extras: [], mode: 'separate', candidateType: 'qualified', nowMs: NOW, ...over,
});
const kinds = (packaged: any) => packaged.attachments.map((item: any) => item.kind);

// Each row: [language, the posting's instructions as the draft kept them, what they ask, the words that decided].
const TABLE: Array<[string, string, '' | 'single' | 'separate', string]> = [
  ["de", "Bitte senden Sie Ihre vollständigen Bewerbungsunterlagen in einem PDF an hr@beispiel.ch.", "single", "einem PDF"],
  ["de", "Bewerbungen bitte per E-Mail, alle Dokumente zusammengefasst in einer PDF-Datei.", "single", "einer PDF-Datei"],
  ["de", "Lebenslauf, Motivationsschreiben und Zeugnisse bitte als ein PDF.", "single", "ein PDF"],
  ["de", "Bitte senden Sie Ihre Unterlagen nicht als einzelne Dateien, sondern in einem einzigen PDF.", "single", "einem einzigen PDF"],
  ["de", "Ihre Bewerbung (eine einzige Datei, max. 5 MB) an jobs@beispiel.ch.", "single", "eine einzige Datei"],
  ["de", "Fassen Sie alle Unterlagen in einem Dokument zusammen.", "single", "in einem Dokument"],
  ["de", "Ihre Bewerbung senden Sie bitte als eine PDF-Datei mit allen Zeugnissen.", "single", "eine PDF-Datei"],
  ["de", "Bitte keine ZIP-Dateien, alle Dokumente in einem PDF.", "single", "einem PDF"],
  ["de", "Sämtliche Unterlagen bitte in einer PDF-Datei, maximal 5 MB.", "single", "einer PDF-Datei"],
  ["de", "Bitte senden Sie Ihre Bewerbung (max. 5 MB) in einem PDF.", "single", "einem PDF"],
  ["de", "Bewerbung in einer einzelnen PDF-Datei an jobs@beispiel.ch.", "single", "einer einzelnen PDF-Datei"],
  ["de", "Bitte senden Sie uns ein PDF Ihrer Bewerbungsunterlagen.", "single", "ein PDF"],
  ["de", "Ihre Bewerbung mit Foto und Zeugnissen in einem PDF.", "single", "einem PDF"],
  ["de", "Bewerbungsunterlagen: bitte in einem PDF an hr@beispiel.ch.", "single", "einem PDF"],
  ["de", "Ihre Unterlagen (z. B. Lebenslauf, Zeugnisse) bitte in einem PDF.", "single", "einem PDF"],
  ["de", "Senden Sie Ihr Dossier inkl. Zeugnissen in einem PDF.", "single", "einem PDF"],
  ["de", "Bitte senden Sie Lebenslauf, Motivationsschreiben und Zeugnisse als separate PDF-Dateien.", "separate", "separate PDF-Dateien"],
  ["de", "Die Unterlagen bitte einzeln als PDF anhängen.", "separate", "einzeln"],
  ["de", "Lebenslauf und Zeugnisse getrennt senden.", "separate", "getrennt"],
  ["de", "Bitte den Lebenslauf separat beilegen.", "separate", "separat"],
  ["de", "Bitte reichen Sie Ihre Unterlagen nicht in einem PDF ein, sondern als einzelne Dateien.", "separate", "einzelne Dateien"],
  ["de", "Lebenslauf und Motivationsschreiben bitte als zwei separate PDF.", "separate", "zwei separate PDF"],
  ["de", "Bitte senden Sie uns Ihre Unterlagen einzeln zu.", "separate", "einzeln"],
  ["de", "Ihr Motivationsschreiben als PDF; Lebenslauf und Zeugnisse bitte separat.", "separate", "separat"],
  ["de", "Bitte Motivationsschreiben und Lebenslauf in getrennten Dateien.", "separate", "getrennten Dateien"],
  ["de", "Bewerbungen bitte als PDF an hr@beispiel.ch.", "", ""],
  ["de", "Bitte laden Sie Ihren Lebenslauf als ein PDF hoch.", "", ""],
  ["de", "Lebenslauf und Zeugnisse jeweils als ein PDF.", "", ""],
  ["de", "Sie arbeiten einzeln und im Team. Bewerbung per E-Mail.", "", ""],
  ["de", "Bitte alle Unterlagen in einem PDF; Zeugnisse separat nachreichen.", "", ""],
  ["de", "Bitte keine ZIP-Dateien.", "", ""],
  ["de", "Bitte schicken Sie ein Motivationsschreiben, einen Lebenslauf sowie ein PDF mit Ihren Zeugnissen.", "", ""],
  ["de", "Bitte alle Unterlagen, für jedes Dokument ein PDF.", "", ""],
  ["de", "Bitte senden Sie für jedes Dokument ein PDF.", "", ""],
  ["de", "Senden Sie Ihren Lebenslauf sowie Zeugnisse und Diplome zusammengefasst als eine PDF-Datei.", "", ""],
  ["de", "Die Zeugnisse können Sie einzeln oder gesammelt senden.", "", ""],
  ["de", "Wir bitten um eine einzige E-Mail mit allen Unterlagen.", "", ""],
  ["de", "Bitte maximal zwei Dateien anhängen.", "", ""],
  ["de", "Lebenslauf, Zeugnisse etc. bitte in einem PDF.", "", ""],
  ["de", "Ein PDF reicht.", "", ""],
  ["de", "Sie können Ihre Unterlagen auch als separate PDF-Dateien senden.", "", ""],
  ["de", "Bitte bewerben Sie sich für jede Stelle separat und legen Sie Ihren Lebenslauf bei.", "", ""],
  ["de", "Wir freuen uns auf Ihre Bewerbung. Bitte laden Sie ein PDF Ihres Lebenslaufs hoch.", "", ""],
  ["de", "Die Bewerbung ist separat für jede Stelle einzureichen.", "", ""],
  ["de", "Bitte die Unterlagen nicht einzeln, sondern zusammen senden.", "", ""],
  ["fr", "Merci de nous faire parvenir votre dossier complet (lettre, CV, certificats) en un seul fichier PDF.", "single", "un seul fichier PDF"],
  ["fr", "Veuillez envoyer votre candidature en un seul document PDF.", "single", "un seul document PDF"],
  ["fr", "Merci de ne pas envoyer de fichiers séparés, mais tous les documents dans un fichier unique.", "single", "un fichier unique"],
  ["fr", "Lettre de motivation et CV en un seul PDF.", "single", "un seul PDF"],
  ["fr", "Envoyez votre candidature complète en un seul PDF par e-mail.", "single", "un seul PDF"],
  ["fr", "N’envoyez qu’un seul PDF avec lettre, CV et certificats.", "single", "un seul PDF"],
  ["fr", "Votre dossier complet, s’il vous plaît, en un seul PDF.", "single", "un seul PDF"],
  ["fr", "Merci d’envoyer CV, lettre et certificats en un seul PDF de 5 Mo au maximum.", "single", "un seul PDF"],
  ["fr", "Documents requis : CV, lettre de motivation et certificats, en un seul fichier PDF.", "single", "un seul fichier PDF"],
  ["fr", "Merci d’envoyer votre CV et votre lettre de motivation en fichiers séparés.", "separate", "fichiers séparés"],
  ["fr", "Les documents doivent être envoyés séparément, au format PDF.", "separate", "séparément"],
  ["fr", "CV, lettre et certificats en pièces jointes distinctes.", "separate", "pièces jointes distinctes"],
  ["fr", "Merci de ne pas envoyer votre dossier en un seul PDF mais en fichiers séparés.", "separate", "fichiers séparés"],
  ["fr", "CV et lettre de motivation dans deux fichiers distincts.", "separate", "deux fichiers"],
  ["fr", "Merci de joindre les certificats séparément.", "separate", "séparément"],
  ["fr", "Envoyez votre CV au format PDF.", "", ""],
  ["fr", "Un PDF par document, s’il vous plaît.", "", ""],
  ["fr", "Votre résumé en une page, merci.", "", ""],
  ["fr", "Les documents (certificats, diplômes) en un seul fichier PDF.", "", ""],
  ["fr", "Les candidatures peuvent aussi être envoyées en un seul PDF.", "", ""],
  ["fr", "Veuillez postuler séparément pour chaque poste, avec votre CV.", "", ""],
  ["it", "Inviare la candidatura completa (lettera, CV, certificati) in un unico file PDF.", "single", "un unico file PDF"],
  ["it", "CV e lettera di motivazione in un solo PDF a hr@esempio.ch.", "single", "un solo PDF"],
  ["it", "Non inviare file separati: tutta la documentazione in un unico documento.", "single", "un unico documento"],
  ["it", "Tutti i documenti in un file unico, formato PDF.", "single", "un file unico"],
  ["it", "Inviare CV e lettera di motivazione in un unico PDF per e-mail a hr@esempio.ch.", "single", "un unico PDF"],
  ["it", "Inviare tutto in un unico PDF, non file separati.", "single", "un unico PDF"],
  ["it", "Inviare la candidatura (lettera, CV e diplomi) in un unico PDF entro il 15 maggio.", "single", "un unico PDF"],
  ["it", "Allegare CV, lettera e certificati in file separati.", "separate", "file separati"],
  ["it", "Si prega di inviare i documenti singoli in formato PDF.", "separate", "documenti singoli"],
  ["it", "Allegare i documenti separatamente.", "separate", "separatamente"],
  ["it", "Non inviare un unico PDF: allegare CV e lettera separatamente.", "separate", "separatamente"],
  ["it", "Allegare i singoli documenti in formato PDF.", "separate", "singoli documenti"],
  ["it", "CV e lettera in due file distinti.", "separate", "due file"],
  ["it", "Documenti: CV e lettera in file separati.", "separate", "file separati"],
  ["it", "Allegare il certificato separatamente.", "separate", "separatamente"],
  ["it", "Inviare il CV in un unico PDF.", "", ""],
  ["it", "Inviare la candidatura entro il 31 ottobre, riferimento 123.", "", ""],
  ["it", "Un PDF per ogni documento.", "", ""],
  ["it", "I documenti (certificati, diplomi) vanno raggruppati in un unico PDF.", "", ""],
  ["it", "Un PDF per documento, grazie.", "", ""],
  ["it", "La candidatura completa va inviata in un unico invio.", "", ""],
  ["it", "Inviare il dossier completo; i certificati possono essere inviati separatamente.", "", ""],
  ["it", "I certificati possono essere inviati separatamente.", "", ""],
  ["it", "Candidarsi separatamente per ogni posizione, allegando il CV.", "", ""],
  ["it", "Inviare CV e certificato in un unico PDF o separatamente.", "", ""],
  ["en", "Please send your application as a single PDF to jobs@example.ch.", "single", "a single PDF"],
  ["en", "Send your CV and cover letter combined in one PDF.", "single", "one PDF"],
  ["en", "Please do not send separate files; all documents in one PDF.", "single", "one PDF"],
  ["en", "Applications must be sent as one PDF file.", "single", "one PDF file"],
  ["en", "No ZIP files, please: all documents in one PDF.", "single", "one PDF"],
  ["en", "Send everything as a single PDF, not as separate files.", "single", "a single PDF"],
  ["en", "Please submit your resume and cover letter together as one PDF.", "single", "one PDF"],
  ["en", "Please attach your CV and cover letter as separate files.", "separate", "separate files"],
  ["en", "Please send your CV, cover letter and certificates as separate PDFs.", "separate", "separate PDFs"],
  ["en", "Kindly attach CV and cover letter in separate files.", "separate", "separate files"],
  ["en", "Please send your cover letter and CV as two separate PDF files.", "separate", "two separate PDF"],
  ["en", "Upload your documents individually.", "", ""],
  ["en", "Upload one PDF per document.", "", ""],
  ["en", "Please apply via our portal.", "", ""],
  ["en", "We welcome applications from individuals with a strong CV.", "", ""],
  ["en", "Please do not combine your documents into one PDF.", "", ""],
  ["en", "We are looking for an individual with a strong CV and excellent references.", "", ""],
  ["en", "Please send one PDF per document.", "", ""],
  ["en", "Please send one PDF for each document.", "", ""],
  ["en", "Please apply separately for each position, attaching your CV.", "", ""],
  ["en", "We expect an individually tailored CV and cover letter.", "", ""],
  ["en", "You may send your documents as one PDF.", "", ""],
  ["en", "Upload your application documents (one PDF per document).", "", ""],
];

describe('the posting’s own instruction on the files (the ad wins)', () => {
  it.each(TABLE)('%s: %s → %s', (_language, text, expected, cue) => {
    expect(classifyAdPackaging(text, `Annuncio. ${text} Fine.`)).toEqual({ instruction: expected, cue });
  });

  it('counts only a sentence the posting holds, whitespace, case and apostrophes aside', () => {
    // The cue is in the posting, the sentence is not: the model's paraphrase decides nothing.
    expect(classifyAdPackaging('Bitte senden Sie Ihre vollständigen Bewerbungsunterlagen in einem PDF.', 'Wir bieten … Zeugnisse in einem PDF sind willkommen.'))
      .toEqual({ instruction: '', cue: '' });
    // No posting text kept on the draft: the default applies.
    expect(classifyAdPackaging('Please send your application as a single PDF.', '')).toEqual({ instruction: '', cue: '' });
    // Line breaks and a curly apostrophe in the posting.
    expect(classifyAdPackaging("Merci d'envoyer votre dossier complet en un seul PDF.", 'Annonce.\nMerci d’envoyer votre dossier\ncomplet en un seul PDF.\nFin.'))
      .toEqual({ instruction: 'single', cue: 'un seul PDF' });
    // The instructions cut at 400 characters still quote the posting.
    expect(classifyAdPackaging('Bitte senden Sie Ihre Bewerbungsunterlagen in einem PDF an hr@bei', 'Bitte senden Sie Ihre Bewerbungsunterlagen in einem PDF an hr@beispiel.ch.'))
      .toEqual({ instruction: 'single', cue: 'einem PDF' });
  });

  it('reads the instructions the draft kept, checked against the posting text the draft kept', () => {
    const sentence = 'Bitte alle Unterlagen in einem PDF an hr@beispiel.ch.';
    const posting = `Wir suchen eine Pflegefachfrau. ${sentence} Wir freuen uns.`;
    expect(adPackaging({ applicationInstructions: sentence, factSources: { posting } })).toEqual({ instruction: 'single', cue: 'einem PDF' });
    expect(adPackaging({ requirementsRaw: { applicationInstructions: sentence }, factSources: { posting } })).toEqual({ instruction: 'single', cue: 'einem PDF' });
    expect(adPackaging({ applicationInstructions: sentence })).toEqual({ instruction: '', cue: '' });
    expect(adPackaging(null)).toEqual({ instruction: '', cue: '' });
  });
});

describe('how the files should leave', () => {
  it('follows the ad first, then the switch for adults, else the separate files', () => {
    expect(packagingDecision({ mode: 'separate', candidateType: 'apprentice', ad: 'single' })).toMatchObject({ want: 'single', reason: 'ad_single', limits: { pages: Infinity, bytes: 3 * MiB } });
    expect(packagingDecision({ mode: 'single', candidateType: 'qualified', ad: 'separate' })).toEqual({ want: 'separate', reason: 'ad_separate' });
    expect(packagingDecision({ mode: 'single', candidateType: 'qualified', ad: '' })).toMatchObject({ want: 'single', reason: 'switch', limits: { pages: 5, bytes: 2 * MiB } });
    expect(packagingDecision({ mode: 'single', candidateType: 'first_job', ad: '' })).toMatchObject({ want: 'single', reason: 'switch' });
    expect(packagingDecision({ mode: 'single', candidateType: 'apprentice', ad: '' })).toEqual({ want: 'separate', reason: 'apprentice' });
    expect(packagingDecision({ mode: 'separate', candidateType: 'qualified', ad: '' })).toEqual({ want: 'separate', reason: 'default' });
    expect(packagingDecision({ mode: 'single', candidateType: '', ad: '' })).toEqual({ want: 'separate', reason: 'default' });
    expect(MERGED_MAX_BYTES).toBe(3 * MiB);
  });
});

describe('a photographed document inside a merged PDF', () => {
  it('reads the EXIF orientation a phone writes, and 1 for anything else', async () => {
    for (const orientation of [6, 8, 3]) {
      expect(jpegOrientation(await noiseJpg(40, 30).withMetadata({ orientation }).toBuffer()), String(orientation)).toBe(orientation);
    }
    const tagged = await noiseJpg(40, 30).withMetadata({ orientation: 6 }).toBuffer();
    expect(jpegOrientation(await noiseJpg(40, 30).toBuffer())).toBe(1);
    expect(jpegOrientation(await noisePng(4, 4))).toBe(1);
    expect(jpegOrientation(tagged.subarray(0, 20))).toBe(1);
    expect(jpegOrientation(Buffer.from('not an image at all'))).toBe(1);
  });

  it('shows it upright, a landscape image on a landscape page, and copies the image bytes as they are', async () => {
    // Stored 1600×1200, shown 1200×1600 (orientation 6, as a phone held upright writes it).
    const rotated = await noiseJpg(1600, 1200).withMetadata({ orientation: 6 }).toBuffer();
    const landscape = await noiseJpg(1600, 1200).toBuffer();
    const merged = await mergeParts([{ buffer: rotated, type: 'jpg' }, { buffer: landscape, type: 'jpg' }], { nowMs: NOW });
    expect(merged).toMatchObject({ pages: 2, expectedPages: 2 });
    expect(await sizes(merged!.pdf)).toEqual([[595, 842], [842, 595]]);
    const [upright, plain] = await imageMatrices(merged!.pdf);
    // Orientation 6: [0, -h, w, 0, x, y + h]; untagged: [w, 0, 0, h, x, y].
    expect(upright[0]).toBe(0);
    expect(upright[1]).toBeLessThan(0);
    expect(upright[2]).toBeGreaterThan(0);
    expect(upright[3]).toBe(0);
    expect(plain[0]).toBeGreaterThan(0);
    expect([plain[1], plain[2]]).toEqual([0, 0]);
    expect(plain[3]).toBeGreaterThan(0);
    expect(merged!.pdf.length).toBeLessThan(rotated.length + landscape.length + 4096);
    // A JPG cut on the way embeds without an error and prints half grey: refused.
    await expect(mergeParts([{ buffer: rotated.subarray(0, rotated.length - 2), type: 'jpg' }])).rejects.toThrow('jpeg_cut');
  }, 60_000);
});

describe('one PDF of letter, CV and documents (the dossier)', () => {
  it('carries a title and the candidate as author, never the library as producer', async () => {
    const fixtures = await typstLetterAndCv();
    const dossier: any = await dossierAttachment({ language: 'it', stem: 'Maria_Rossi', name: 'Maria Rossi', letter: fixtures.letter, cv: { buffer: fixtures.cv, type: 'pdf' }, nowMs: NOW });
    expect(dossier).toMatchObject({ ok: true, filename: 'Dossier_di_candidatura_Maria_Rossi.pdf', pages: 2, bytes: dossier.pdf.length });
    const read = await PDFDocument.load(dossier.pdf, { updateMetadata: false });
    expect(read.getTitle()).toBe('Dossier di candidatura – Maria Rossi');
    expect(read.getAuthor()).toBe('Maria Rossi');
    expect(read.getProducer()).toBeUndefined();
    expect(read.getCreator()).toBeUndefined();
    expect(dossier.pdf.toString('latin1')).not.toContain('pdf-lib');
    // Page 1 is the letter, with its own text.
    expect((await pageTexts(dossier.pdf))[0]).toBe((await pageTexts(fixtures.letter))[0]);
  }, 60_000);

  it('says why it cannot leave as one PDF', async () => {
    const letter = pdfOf('Brief');
    const cv = { buffer: pdfOf('Lebenslauf'), type: 'pdf' };
    const attachment = (over: Record<string, any>) => dossierAttachment({ language: 'de', stem: 'Maria_Rossi', name: 'Maria Rossi', letter, cv, extras: [], nowMs: NOW, ...over });
    expect(await attachment({ cv: { buffer: docx, type: 'docx' } })).toEqual({ ok: false, reason: 'cv_not_pdf' });
    expect(await attachment({ extras: extras(file('Zeugnis_Maria_Rossi.docx', docx, 'docx')) })).toEqual({ ok: false, reason: 'document_not_mergeable' });
    expect(await attachment({ extras: extras(file('Zeugnis_Maria_Rossi.pdf', encryptedPdf(), 'pdf')) })).toEqual({ ok: false, reason: 'encrypted_or_broken' });
    expect(await attachment({ extras: extras(file('Zeugnis_Maria_Rossi.pdf', Buffer.from('%PDF-1.4 x'), 'pdf')) })).toEqual({ ok: false, reason: 'encrypted_or_broken' });
    const cut = await noiseJpg(300, 200).toBuffer();
    expect(await attachment({ extras: extras(file('Zeugnis_Maria_Rossi.jpg', cut.subarray(0, cut.length - 2), 'jpg')) })).toEqual({ ok: false, reason: 'encrypted_or_broken' });
    // The switch's limits: 5 pages, 2 MB (a PNG is re-encoded, so it is counted after the merge).
    expect(await attachment({ cv: { buffer: pdfOf('Lebenslauf', 5), type: 'pdf' } })).toEqual({ ok: false, reason: 'pages' });
    const heavy = await noisePng(900, 900);
    expect(heavy.length).toBeGreaterThan(2.2 * MiB);
    expect(await attachment({ extras: extras(file('Foto_Maria_Rossi.png', heavy, 'png')) })).toEqual({ ok: false, reason: 'bytes' });
    // A letter without its text on page 1 (a scan) is never merged: the check could not tell it kept its page.
    expect(await attachment({ letter: imageOnlyPdf() })).toEqual({ ok: false, reason: 'check_failed' });
    expect(await attachment({})).toMatchObject({ ok: true, filename: 'Bewerbungsdossier_Maria_Rossi.pdf', pages: 2 });
  }, 60_000);

  it('takes the one PDF an ad asks for without a page cap, within 3 MB, refusing heavy JPGs before merging', async () => {
    const letter = pdfOf('Brief');
    const ad = { instruction: 'single', cue: 'einem PDF' };
    const six = await packageAttachments(input({ letter, cv: pdfOf('Lebenslauf', 5) }, { ad }));
    expect(six).toMatchObject({ packaging: 'single', reason: 'ad_single', pages: 6 });
    const heavy = await noiseJpg(1500, 1500, 100).toBuffer();
    expect(heavy.length * 2).toBeGreaterThan(3 * MiB);
    const check = vi.fn(checkMergedPdf);
    const over = await packageAttachments(input({ letter, cv: pdfOf('Lebenslauf') }, {
      ad, check, extras: extras(file('A_1_Maria_Rossi.jpg', heavy, 'jpg'), file('A_2_Maria_Rossi.jpg', heavy, 'jpg')),
    }));
    expect(over).toMatchObject({ packaging: 'separate', reason: 'bytes', documentsGrouped: false, documentsReason: 'bytes' });
    expect(check).not.toHaveBeenCalled();
  }, 60_000);
});

describe('the check of a merged PDF', () => {
  it('reopens it, counts its pages and finds the letter’s own text on page 1; never throws', async () => {
    const letter = pdfOf('Brief');
    const merged = (await mergeParts([{ buffer: letter, type: 'pdf' }, { buffer: pdfOf('Lebenslauf', 2), type: 'pdf' }], { nowMs: NOW }))!;
    expect(await checkMergedPdf(merged.pdf, { expectedPages: 3, letter })).toBe(true);
    expect(await checkMergedPdf(merged.pdf, { expectedPages: 3 })).toBe(true);
    expect(await checkMergedPdf(merged.pdf.subarray(0, Math.floor(merged.pdf.length / 2)), { expectedPages: 3 })).toBe(false);
    expect(await checkMergedPdf(merged.pdf, { expectedPages: 2 })).toBe(false);
    expect(await checkMergedPdf(merged.pdf, { expectedPages: 4 })).toBe(false);
    expect(await checkMergedPdf(merged.pdf, { expectedPages: 3, letter: pdfOf('Anderer Brief') })).toBe(false);
    expect(await checkMergedPdf(Buffer.from('garbage'), { expectedPages: 1, letter })).toBe(false);
  }, 60_000);
});

describe('the requested documents grouped (never one file each)', () => {
  it('names the file and its title in the letter’s language, keeps the documents’ pages, or says why not', async () => {
    const files = [file('Zeugnis_1_Maria_Rossi.pdf', pdfOf('Arbeitszeugnis Beispiel AG'), 'pdf'), file('Zeugnis_2_Maria_Rossi.jpg', await noiseJpg(300, 200).toBuffer(), 'jpg')];
    for (const [language, label] of [['de', 'Beilagen'], ['fr', 'Annexes'], ['it', 'Allegati'], ['en', 'Enclosures']]) {
      const grouped: any = await groupDocuments({ language, stem: 'Maria_Rossi', name: 'Maria Rossi', files, nowMs: NOW });
      expect(grouped).toMatchObject({ ok: true, filename: `${label}_Maria_Rossi.pdf`, pages: 2 });
      expect((await PDFDocument.load(grouped.pdf, { updateMetadata: false })).getTitle()).toBe(`${label} – Maria Rossi`);
    }
    const grouped: any = await groupDocuments({ language: 'de', stem: 'Maria_Rossi', name: 'Maria Rossi', files, nowMs: NOW });
    expect((await pageTexts(grouped.pdf))[0]).toBe('Arbeitszeugnis Beispiel AG 1');
    expect(await pdfPaintsImage(grouped.pdf)).toBe(true);
    const heavy = await noisePng(900, 900);
    expect(await groupDocuments({ language: 'de', stem: 'x', files: [file('a.png', heavy, 'png'), file('b.png', heavy, 'png')], nowMs: NOW })).toEqual({ ok: false, reason: 'bytes' });
    expect(await groupDocuments({ language: 'de', stem: 'x', files: [files[0], file('b.docx', docx, 'docx')], nowMs: NOW })).toEqual({ ok: false, reason: 'document_not_mergeable' });
    expect(await groupDocuments({ language: 'de', stem: 'x', files: [files[0], file('b.pdf', encryptedPdf(), 'pdf')], nowMs: NOW })).toEqual({ ok: false, reason: 'encrypted_or_broken' });
  }, 60_000);
});

describe('an e-mail application’s attachments', () => {
  it('leaves the CV and the letter apart and groups the documents by default; one document as it is', async () => {
    const fixtures = await typstLetterAndCv();
    const reference = file('Arbeitszeugnisse_1_Maria_Rossi.pdf', pdfOf('Arbeitszeugnis Beispiel AG'), 'pdf');
    const photo = file('Arbeitszeugnisse_2_Maria_Rossi.jpg', await noiseJpg(1600, 1200).withMetadata({ orientation: 6 }).toBuffer(), 'jpg');
    const grouped: any = await packageAttachments(input(fixtures, { extras: extras(reference, photo) }));
    expect(grouped).toMatchObject({ packaging: 'separate', reason: 'default', ad: '', adCue: '', documentsGrouped: true, documentsReason: null, pages: 2 });
    expect(kinds(grouped)).toEqual(['cv', 'letter', 'documents']);
    expect(grouped.attachments.map((item: any) => item.name)).toEqual(['CV_Maria_Rossi.pdf', 'Motivationsschreiben_Maria_Rossi.pdf', 'Beilagen_Maria_Rossi.pdf']);
    // The CV keeps its key; the grouped file is new (submit.mjs keeps it next to the order).
    expect(grouped.attachments.map((item: any) => item.key)).toEqual(['assisted-application-uploads/order_PACK01/ai-cv-r1-1.pdf', null, null]);
    const one: any = await packageAttachments(input(fixtures, { extras: extras(reference) }));
    expect(kinds(one)).toEqual(['cv', 'letter', 'document']);
    expect(one).toMatchObject({ documentsGrouped: false, documentsReason: null, pages: null, bytes: null });
    expect(one.attachments[2]).toMatchObject({ name: 'Arbeitszeugnisse_1_Maria_Rossi.pdf', key: reference.key });
  }, 60_000);

  it('merges all when the ad asks for one PDF, keeps all apart when it asks for separate files, whatever the switch', async () => {
    const fixtures = await typstLetterAndCv();
    const documents = extras(file('A_1_Maria_Rossi.pdf', pdfOf('Zeugnis'), 'pdf'), file('A_2_Maria_Rossi.pdf', pdfOf('Diplom'), 'pdf'));
    const single: any = await packageAttachments(input(fixtures, { candidateType: 'apprentice', ad: { instruction: 'single', cue: 'einem PDF' }, extras: documents }));
    expect(single).toMatchObject({ packaging: 'single', reason: 'ad_single', ad: 'single', adCue: 'einem PDF', documentsGrouped: true, pages: 4 });
    expect(kinds(single)).toEqual(['dossier']);
    expect(single.attachments[0]).toMatchObject({ name: 'Bewerbungsdossier_Maria_Rossi.pdf', key: null });
    const separate: any = await packageAttachments(input(fixtures, { mode: 'single', ad: { instruction: 'separate', cue: 'separate PDF-Dateien' }, extras: documents }));
    expect(separate).toMatchObject({ packaging: 'separate', reason: 'ad_separate', documentsGrouped: false, documentsReason: 'ad_separate' });
    expect(kinds(separate)).toEqual(['cv', 'letter', 'document', 'document']);
  }, 60_000);

  it('falls back to the separate files with the reason, grouping the documents when it can', async () => {
    const fixtures = await typstLetterAndCv();
    const word: any = await packageAttachments(input(fixtures, { mode: 'single', extras: extras(file('A_1_Maria_Rossi.pdf', pdfOf('Zeugnis'), 'pdf'), file('A_2_Maria_Rossi.docx', docx, 'docx')) }));
    expect(word).toMatchObject({ packaging: 'separate', reason: 'document_not_mergeable', documentsGrouped: false, documentsReason: 'document_not_mergeable' });
    expect(kinds(word)).toEqual(['cv', 'letter', 'document', 'document']);
    const long: any = await packageAttachments(input({ letter: fixtures.letter, cv: pdfOf('Lebenslauf', 5) }, { mode: 'single', extras: extras(file('A_1_Maria_Rossi.pdf', pdfOf('Zeugnis'), 'pdf'), file('A_2_Maria_Rossi.pdf', pdfOf('Diplom'), 'pdf')) }));
    expect(long).toMatchObject({ packaging: 'separate', reason: 'pages', documentsGrouped: true, documentsReason: null, pages: 2 });
    expect(kinds(long)).toEqual(['cv', 'letter', 'documents']);
    const heavy = await noisePng(900, 900);
    const noisy: any = await packageAttachments(input(fixtures, { extras: extras(file('A_1_Maria_Rossi.png', heavy, 'png'), file('A_2_Maria_Rossi.png', heavy, 'png')) }));
    expect(noisy).toMatchObject({ packaging: 'separate', reason: 'default', documentsGrouped: false, documentsReason: 'bytes' });
    expect(kinds(noisy)).toEqual(['cv', 'letter', 'document', 'document']);
  }, 60_000);
});

describe('a digitally signed PDF (owner decision of 2026-10-04)', () => {
  it('tells a signature dictionary, or the AcroForm’s /SigFlags, from a plain PDF', async () => {
    expect(isSignedPdf(await signedPdf('Arbeitszeugnis'))).toBe(true);
    expect(isSignedPdf(await signedPdf('Arbeitszeugnis', { sigFlags: false }))).toBe(true);
    expect(isSignedPdf(await signedPdf('Arbeitszeugnis', { byteRange: false }))).toBe(true);
    // A /Contents hex string without /ByteRange (an annotation's text) is no signature.
    expect(isSignedPdf(await signedPdf('Arbeitszeugnis', { byteRange: false, sigFlags: false }))).toBe(false);
    expect(isSignedPdf(pdfOf('Arbeitszeugnis'))).toBe(false);
  });

  it('leaves it as it is after the merged file, and still groups the others when two or more remain', async () => {
    const fixtures = await typstLetterAndCv();
    const signed = file('Arbeitszeugnisse_3_Maria_Rossi.pdf', await signedPdf('Signiertes Zeugnis'), 'pdf');
    const reference = file('Arbeitszeugnisse_1_Maria_Rossi.pdf', pdfOf('Arbeitszeugnis Beispiel AG'), 'pdf');
    const photo = file('Arbeitszeugnisse_2_Maria_Rossi.jpg', await noiseJpg(300, 200).toBuffer(), 'jpg');
    const grouped: any = await packageAttachments(input(fixtures, { extras: extras(reference, signed, photo) }));
    expect(kinds(grouped)).toEqual(['cv', 'letter', 'documents', 'document']);
    expect(grouped).toMatchObject({ packaging: 'separate', documentsGrouped: true, documentsReason: 'document_signed', pages: 2 });
    // The signed file leaves byte for byte, its signature intact; the grouped file holds the other two.
    expect(grouped.attachments[3]).toMatchObject({ name: signed.fileName, key: signed.key });
    expect(grouped.attachments[3].buffer.equals(signed.buffer)).toBe(true);
    expect(await pageTexts(grouped.attachments[2].buffer)).toEqual(['Arbeitszeugnis Beispiel AG 1', '']);
    // One file left besides it: nothing to group, each leaves as it is.
    const pair: any = await packageAttachments(input(fixtures, { extras: extras(reference, signed) }));
    expect(kinds(pair)).toEqual(['cv', 'letter', 'document', 'document']);
    expect(pair).toMatchObject({ documentsGrouped: false, documentsReason: 'document_signed' });
    // The one PDF an ad asks for holds letter, CV and the other documents; the signed one follows it.
    const single: any = await packageAttachments(input(fixtures, { ad: { instruction: 'single', cue: 'einem PDF' }, extras: extras(reference, signed) }));
    expect(kinds(single)).toEqual(['dossier', 'document']);
    expect(single).toMatchObject({ packaging: 'single', reason: 'ad_single', documentsGrouped: true, documentsReason: 'document_signed', pages: 3 });
    expect(single.attachments[1].buffer.equals(signed.buffer)).toBe(true);
  }, 60_000);
});
