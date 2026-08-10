/**
 * Self-certification forms — Vite build plugin.
 *
 * Emits a static IT-only landing page explaining self-certification for job
 * applications, plus four ready-to-fill legally-formatted PDF templates
 * generated with pdfkit:
 *   - autocertificazione-stato-di-salute.pdf (Italian, art. 47 DPR 445/2000)
 *   - autocertificazione-casellario-giudiziario.pdf (Italian, art. 46 c.1 lett. z DPR 445/2000)
 *   - questionario-salute-svizzero.pdf (Swiss-style, art. 328b CO / LORD artt. 13-40)
 *   - autocertificazione-casellario-giudiziario-svizzero.pdf (Swiss-style, art. 369 CP)
 *
 * The Italian pair follows the DPR 445/2000 self-certification instrument
 * (dichiarazione sostitutiva). The Swiss-style pair mirrors the questionnaire
 * format used by Ticino employers (cantonal model inspired by the SESCO
 * gennaio 2018 health questionnaire and Lugano-LIS criminal-record template),
 * scoped by Swiss law instead: art. 328b CO (Codice delle obbligazioni) caps
 * what an employer may ask to what is relevant for job suitability, LORD
 * artt. 13 e 40 covers cantonal public employment, and art. 369 CP (why the
 * newer criminal-record questionnaires only ask about pending proceedings,
 * not past convictions) explains the narrower 2025 scope. All four PDFs are
 * original wording, not verbatim copies of any official form.
 *
 * IT-only: target audience is Italian frontalieri, same precedent as
 * pdfWhitepapersPlugin.ts (only sources services/locales/blog-body/it/).
 *
 * Download gate: all four PDF links carry data-pdf-gate attributes; the
 * global PdfDownloadGate component (components/shared/PdfDownloadGate.tsx)
 * intercepts the click and requires a free email/social registration before
 * triggering the actual download. Links keep a real crawlable href+download
 * so search engines and no-JS visitors still see valid PDF links.
 *
 * URLs:
 *   /moduli/autocertificazione-candidatura/
 *   /moduli/autocertificazione-stato-di-salute.pdf
 *   /moduli/autocertificazione-casellario-giudiziario.pdf
 *   /moduli/questionario-salute-svizzero.pdf
 *   /moduli/autocertificazione-casellario-giudiziario-svizzero.pdf
 *
 * Gate: SKIP_SELF_CERTIFICATION_FORMS=1 fast-path exits without generating
 * pages (used by local fast builds alongside other SKIP_* gates in CLAUDE.md).
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords, DRIVEBY_AD_SNIPPET } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { WriteCollector } from './batchWrite';
import { adSlotHtml } from './lib/adSlotHtml';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { guardArticleJsonLdDescription } from './shared/safeTruncate';
import { imageObjectLd } from '../services/seo/imageObjectLd';
import { PDF_PAGE_A4, PDF_MARGIN_DEFAULT, PDF_BASE_PALETTE, collectPdfBuffer } from './shared/pdfKitTheme';
import {
  esc,
  renderBreadcrumb,
  HERO_EYEBROW_STYLE,
  H1_STYLE,
  LEDE_STYLE,
  BODY_STYLE,
  H2_STYLE,
  H3_STYLE,
  LINK_ACCENT_STYLE,
} from './shared/seoContentTokens';

export const LANDING_URL_PATH = '/moduli/autocertificazione-candidatura/';
const CANONICAL_URL = `${BASE_URL}${LANDING_URL_PATH}`;
export const HEALTH_PDF_PATH = '/moduli/autocertificazione-stato-di-salute.pdf';
export const CRIMINAL_RECORD_PDF_PATH = '/moduli/autocertificazione-casellario-giudiziario.pdf';
export const CH_HEALTH_PDF_PATH = '/moduli/questionario-salute-svizzero.pdf';
export const CH_CRIMINAL_RECORD_PDF_PATH = '/moduli/autocertificazione-casellario-giudiziario-svizzero.pdf';

const TITLE = 'Autocertificazione stato di salute e casellario giudiziario | Frontaliere Ticino';
const H1 = 'Autocertificazione stato di salute e casellario giudiziario: moduli italiani e svizzeri';
const DESCRIPTION = 'Moduli di autocertificazione dello stato di salute e del casellario giudiziario per candidarti a un lavoro in Ticino: quattro PDF gratis, versione italiana (DPR 445/2000) e versione in uso presso i datori di lavoro svizzeri.';
const LEDE = 'Quattro PDF pronti da compilare per autocertificare stato di salute e casellario giudiziario in una candidatura di lavoro: versione italiana e versione in uso in Svizzera.';

interface SelfCertFormMeta {
  slug: string;
  urlPath: string;
  pdfTitle: string;
  pdfSubtitle: string;
  legalBasis: string;
  declarationParagraphs: string[];
}

export const HEALTH_FORM: SelfCertFormMeta = {
  slug: 'stato-di-salute',
  urlPath: HEALTH_PDF_PATH,
  pdfTitle: 'DICHIARAZIONE SOSTITUTIVA DI ATTO DI NOTORIETA’',
  pdfSubtitle: 'Stato di salute — Art. 47, D.P.R. 28 dicembre 2000, n. 445',
  legalBasis: 'artt. 47 e 76, D.P.R. 445/2000',
  declarationParagraphs: [
    'consapevole delle responsabilità penali cui può andare incontro in caso di dichiarazioni mendaci, ai sensi dell’art. 76 del D.P.R. 445/2000, e ai sensi e per gli effetti dell’art. 47 del medesimo decreto,',
    'DICHIARA',
    'sotto la propria responsabilità, di godere di buona salute generale e di non essere affetto/a da patologie che possano pregiudicare lo svolgimento delle mansioni proprie della posizione per cui presenta la propria candidatura presso il seguente destinatario:',
    'La presente dichiarazione è resa in sostituzione di certificazione medica, ai soli fini della candidatura lavorativa sopra indicata.',
  ],
};

export const CRIMINAL_RECORD_FORM: SelfCertFormMeta = {
  slug: 'casellario-giudiziario',
  urlPath: CRIMINAL_RECORD_PDF_PATH,
  pdfTitle: 'DICHIARAZIONE SOSTITUTIVA DI CERTIFICAZIONE',
  pdfSubtitle: 'Casellario giudiziale — Art. 46, comma 1, lett. z), D.P.R. 28 dicembre 2000, n. 445',
  legalBasis: 'art. 46 c.1 lett. z) e art. 76, D.P.R. 445/2000',
  declarationParagraphs: [
    'consapevole delle responsabilità penali cui può andare incontro in caso di dichiarazioni mendaci, ai sensi dell’art. 76 del D.P.R. 445/2000, e ai sensi e per gli effetti dell’art. 46, comma 1, lett. z), del medesimo decreto,',
    'DICHIARA',
    'di non aver riportato condanne penali e di non essere destinatario/a di provvedimenti che riguardano l’applicazione di misure di sicurezza e di misure di prevenzione, di decisioni civili e di provvedimenti amministrativi iscritti nel casellario giudiziale ai sensi della vigente normativa (art. 3, comma 1, D.P.R. 14 novembre 2002, n. 313), ai fini della propria candidatura presso il seguente destinatario:',
  ],
};

interface SwissSelfCertFormMeta {
  slug: string;
  urlPath: string;
  pdfTitle: string;
  pdfSubtitle: string;
  legalBasis: string;
  introParagraph: string;
  questions: string[];
  closingParagraphs: string[];
}

export const CH_HEALTH_FORM: SwissSelfCertFormMeta = {
  slug: 'stato-di-salute-svizzero',
  urlPath: CH_HEALTH_PDF_PATH,
  pdfTitle: 'QUESTIONARIO DI AUTOVALUTAZIONE DELLO STATO DI SALUTE',
  pdfSubtitle: 'Modello in uso presso datori di lavoro svizzeri — art. 328b CO',
  legalBasis: 'art. 328b Codice delle obbligazioni (CO); LORD artt. 13 e 40 per l’impiego pubblico cantonale',
  introParagraph: 'Il presente questionario raccoglie solo le informazioni sullo stato di salute rilevanti per valutare l’idoneità alla posizione per cui ci si candida, nei limiti previsti dall’art. 328b del Codice delle obbligazioni svizzero. Rispondere con onestà: una dichiarazione falsa su un punto rilevante per l’idoneità alla mansione può costituire motivo di risoluzione del rapporto di lavoro.',
  questions: [
    'Gode attualmente di un buono stato di salute generale?',
    'È affetto/a da patologie croniche che potrebbero limitare lo svolgimento delle mansioni proprie della posizione?',
    'È attualmente in cura per una condizione che potrebbe incidere sulla capacità lavorativa nella posizione per cui si candida?',
    'Ha avuto, negli ultimi 12 mesi, assenze per malattia superiori a 30 giorni consecutivi?',
    'È disponibile a sottoporsi, se richiesto dal datore di lavoro, a una visita di idoneità presso un medico del lavoro?',
  ],
  closingParagraphs: [
    'Confermo che le risposte fornite sono veritiere e complete, per quanto a mia conoscenza, e riguardano esclusivamente aspetti rilevanti per l’idoneità alla posizione indicata.',
  ],
};

export const CH_CRIMINAL_RECORD_FORM: SwissSelfCertFormMeta = {
  slug: 'casellario-giudiziario-svizzero',
  urlPath: CH_CRIMINAL_RECORD_PDF_PATH,
  pdfTitle: 'AUTOCERTIFICAZIONE ASSENZA DI PROCEDIMENTI PENALI PENDENTI',
  pdfSubtitle: 'Modello in uso presso datori di lavoro svizzeri — aggiornato 2025',
  legalBasis: 'art. 369 Codice penale svizzero (CP) — cancellazione delle iscrizioni nel casellario giudiziale',
  introParagraph: 'Il modello più recente in uso presso i datori di lavoro svizzeri si limita a chiedere l’assenza di procedimenti penali in corso, non le condanne passate: l’art. 369 del Codice penale svizzero prevede infatti la cancellazione delle iscrizioni nel casellario giudiziale dopo un periodo di buona condotta, e una condanna cancellata non può più essere fatta valere contro la persona interessata.',
  questions: [
    'È attualmente parte in un procedimento penale pendente per un reato incompatibile con le mansioni della posizione per cui si candida?',
  ],
  closingParagraphs: [
    'Dichiaro la mia disponibilità a produrre, su richiesta del datore di lavoro, un estratto del casellario giudiziale svizzero per privati, rilasciato dall’Ufficio federale di giustizia.',
  ],
};

/* ── PDF generation ────────────────────────────────────────────────── */

const PDF_COLORS = PDF_BASE_PALETTE;
const PDF_PAGE = PDF_PAGE_A4;
const PDF_MARGIN = PDF_MARGIN_DEFAULT;
const PDF_CONTENT_WIDTH = PDF_PAGE.width - PDF_MARGIN.left - PDF_MARGIN.right;

function drawField(doc: PDFKit.PDFDocument, label: string, width?: number): void {
  const w = width ?? PDF_CONTENT_WIDTH;
  doc.fontSize(9).font('Helvetica').fillColor(PDF_COLORS.muted);
  doc.text(label, { continued: false });
  const lineY = doc.y + 16;
  doc.strokeColor(PDF_COLORS.rule).lineWidth(1);
  doc.moveTo(doc.x, lineY).lineTo(doc.x + w, lineY).stroke();
  doc.y = lineY + 12;
}

/**
 * Two fields side by side sharing one row, e.g. "Nato/a a" + "il (gg/mm/aaaa)".
 * Replaces the previous pattern of two stacked drawField() calls glued back
 * together with `doc.y -= 22` — that hack cancelled the vertical advance but
 * never moved doc.x, so the second label rendered flush under the first
 * instead of beside it, colliding label text with the line above.
 */
function drawFieldRow(doc: PDFKit.PDFDocument, fields: Array<{ label: string; width: number }>, gap = 20): void {
  const startX = doc.x;
  const startY = doc.y;
  doc.fontSize(9).font('Helvetica').fillColor(PDF_COLORS.muted);
  const labelHeight = Math.max(...fields.map((f) => doc.heightOfString(f.label, { width: f.width })));
  const lineY = startY + labelHeight + 16;
  let cursorX = startX;
  for (const { label, width } of fields) {
    doc.text(label, cursorX, startY, { width, lineBreak: false });
    doc.strokeColor(PDF_COLORS.rule).lineWidth(1);
    doc.moveTo(cursorX, lineY).lineTo(cursorX + width, lineY).stroke();
    cursorX += width + gap;
  }
  doc.x = startX;
  doc.y = lineY + 12;
}

/**
 * Draws a question with two vector checkboxes (SI / NO). Uses doc.rect()
 * outlines rather than Unicode box-drawing glyphs (☐) — Helvetica's base-14
 * WinAnsi encoding doesn't reliably render those characters.
 */
function drawYesNoQuestion(doc: PDFKit.PDFDocument, question: string): void {
  const boxSize = 11;
  const noBoxX = PDF_MARGIN.left + PDF_CONTENT_WIDTH - 40;
  const siBoxX = noBoxX - 62;
  // Text column stops before the SI box, with a real gutter — the previous
  // fixed `PDF_CONTENT_WIDTH - 90` budget over-estimated available width by
  // ~28pt, so long questions ran their last word(s) under the SI checkbox.
  const textWidth = siBoxX - PDF_MARGIN.left - 16;
  const startY = doc.y;

  doc.fontSize(10).font('Helvetica').fillColor(PDF_COLORS.body);
  doc.text(question, PDF_MARGIN.left, startY, { width: textWidth });
  const textBottomY = doc.y;

  doc.strokeColor(PDF_COLORS.rule).lineWidth(1);
  doc.rect(siBoxX, startY, boxSize, boxSize).stroke();
  doc.rect(noBoxX, startY, boxSize, boxSize).stroke();
  doc.fontSize(8).fillColor(PDF_COLORS.muted).font('Helvetica');
  doc.text('SI', siBoxX + boxSize + 4, startY - 1, { width: 20, lineBreak: false });
  doc.text('NO', noBoxX + boxSize + 4, startY - 1, { width: 24, lineBreak: false });

  doc.x = PDF_MARGIN.left;
  doc.y = Math.max(textBottomY, startY + boxSize) + 14;
}

/**
 * Small, low-opacity site wordmark in the footer margin band — a discreet
 * branding touch, not a header lockup. logo-rect-400.png has dark text on a
 * transparent background, so it only reads on the page's white background,
 * never the dark header band. Purely decorative: a missing/corrupt asset
 * must never break PDF generation, hence the swallowed catch.
 */
function drawFooterLogo(doc: PDFKit.PDFDocument, logoPath: string | undefined): void {
  if (!logoPath) return;
  try {
    const width = 84;
    const height = width * (80 / 400);
    const x = (PDF_PAGE.width - width) / 2;
    const y = PDF_PAGE.height - 38;
    doc.opacity(0.55);
    doc.image(logoPath, x, y, { width, height });
  } catch {
    // Decorative — swallow and continue without the logo.
  } finally {
    doc.opacity(1);
  }
}

export async function generateSelfCertificationPdf(form: SelfCertFormMeta, logoPath?: string): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;

  const doc = new PDFDocument({
    size: 'A4',
    margins: PDF_MARGIN,
    bufferPages: true,
    info: {
      Title: form.pdfTitle,
      Author: 'Frontaliere Ticino',
      Subject: form.pdfSubtitle,
      Creator: 'frontaliereticino.ch',
    },
  });
  const bufferPromise = collectPdfBuffer(doc);

  doc.rect(0, 0, PDF_PAGE.width, 110).fill(PDF_COLORS.headerBg);
  doc.fillColor(PDF_COLORS.white).fontSize(16).font('Helvetica-Bold');
  doc.text(form.pdfTitle, PDF_MARGIN.left, 34, { width: PDF_CONTENT_WIDTH });
  doc.fontSize(11).font('Helvetica');
  doc.text(form.pdfSubtitle, PDF_MARGIN.left, doc.y + 6, { width: PDF_CONTENT_WIDTH });

  doc.y = 130;
  doc.fillColor(PDF_COLORS.body).fontSize(10).font('Helvetica');
  doc.text('Il/La sottoscritto/a', PDF_MARGIN.left, doc.y, { width: PDF_CONTENT_WIDTH });
  doc.moveDown(0.3);
  drawField(doc, 'Cognome e nome');
  drawFieldRow(doc, [
    { label: 'Nato/a a', width: 260 },
    { label: 'il (gg/mm/aaaa)', width: 200 },
  ]);
  drawField(doc, 'Residente a (comune, via/piazza, n., CAP)');
  drawField(doc, 'Codice fiscale', 260);

  doc.moveDown(0.5);
  doc.fontSize(10).font('Helvetica');
  for (const paragraph of form.declarationParagraphs) {
    const isHeading = paragraph === 'DICHIARA';
    if (isHeading) {
      doc.moveDown(0.4);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(PDF_COLORS.heading);
      doc.text(paragraph, PDF_MARGIN.left, doc.y, { width: PDF_CONTENT_WIDTH, align: 'center' });
      doc.moveDown(0.4);
      doc.font('Helvetica').fontSize(10).fillColor(PDF_COLORS.body);
    } else {
      doc.text(paragraph, PDF_MARGIN.left, doc.y, { width: PDF_CONTENT_WIDTH, align: 'justify' });
      doc.moveDown(0.5);
    }
  }

  drawField(doc, 'Destinatario / datore di lavoro (ragione sociale)');

  doc.moveDown(0.6);
  doc.fontSize(9).font('Helvetica').fillColor(PDF_COLORS.muted);
  doc.text(
    'Ai sensi dell’art. 38, comma 3, D.P.R. 445/2000, alla presente dichiarazione va allegata copia fotostatica di un documento di identità in corso di validità.',
    PDF_MARGIN.left, doc.y, { width: PDF_CONTENT_WIDTH },
  );

  doc.moveDown(2);
  const sigY = doc.y;
  doc.fontSize(9).fillColor(PDF_COLORS.muted).font('Helvetica');
  doc.text('Luogo e data', PDF_MARGIN.left, sigY, { width: 220 });
  doc.text('Firma', PDF_MARGIN.left + 300, sigY, { width: 180 });
  const sigLineY = sigY + 30;
  doc.strokeColor(PDF_COLORS.rule).lineWidth(1);
  doc.moveTo(PDF_MARGIN.left, sigLineY).lineTo(PDF_MARGIN.left + 200, sigLineY).stroke();
  doc.moveTo(PDF_MARGIN.left + 300, sigLineY).lineTo(PDF_MARGIN.left + 480, sigLineY).stroke();

  doc.fontSize(8).fillColor(PDF_COLORS.muted).font('Helvetica');
  doc.text(
    'Nota: verso le Pubbliche Amministrazioni italiane questa dichiarazione ha piena efficacia sostitutiva. Verso datori di lavoro privati, inclusi quelli svizzeri, è valida solo se il destinatario accetta di riceverla in luogo del documento originale (art. 2, comma 2, D.P.R. 445/2000).',
    PDF_MARGIN.left, PDF_PAGE.height - PDF_MARGIN.bottom - 60, { width: PDF_CONTENT_WIDTH },
  );
  doc.text(
    `Documento generato da ${CANONICAL_URL} — non costituisce consulenza legale.`,
    PDF_MARGIN.left, doc.y + 6, { width: PDF_CONTENT_WIDTH },
  );
  drawFooterLogo(doc, logoPath);

  doc.end();
  return bufferPromise;
}

export async function generateSwissSelfCertificationPdf(form: SwissSelfCertFormMeta, logoPath?: string): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;

  const doc = new PDFDocument({
    size: 'A4',
    margins: PDF_MARGIN,
    bufferPages: true,
    info: {
      Title: form.pdfTitle,
      Author: 'Frontaliere Ticino',
      Subject: form.pdfSubtitle,
      Creator: 'frontaliereticino.ch',
    },
  });
  const bufferPromise = collectPdfBuffer(doc);

  doc.rect(0, 0, PDF_PAGE.width, 110).fill(PDF_COLORS.headerBg);
  doc.fillColor(PDF_COLORS.white).fontSize(15).font('Helvetica-Bold');
  doc.text(form.pdfTitle, PDF_MARGIN.left, 30, { width: PDF_CONTENT_WIDTH });
  doc.fontSize(10).font('Helvetica');
  doc.text(form.pdfSubtitle, PDF_MARGIN.left, doc.y + 6, { width: PDF_CONTENT_WIDTH });

  doc.y = 130;
  doc.fillColor(PDF_COLORS.body).fontSize(10).font('Helvetica');
  doc.text('Candidato/a', PDF_MARGIN.left, doc.y, { width: PDF_CONTENT_WIDTH });
  doc.moveDown(0.3);
  drawField(doc, 'Cognome e nome');
  drawFieldRow(doc, [
    { label: 'Posizione per cui presenta candidatura', width: 260 },
    { label: 'Datore di lavoro / azienda', width: 200 },
  ]);

  doc.moveDown(0.4);
  doc.fontSize(9).font('Helvetica').fillColor(PDF_COLORS.muted);
  doc.text(form.introParagraph, PDF_MARGIN.left, doc.y, { width: PDF_CONTENT_WIDTH, align: 'justify' });
  doc.moveDown(0.6);
  doc.x = PDF_MARGIN.left;

  for (const question of form.questions) {
    drawYesNoQuestion(doc, question);
  }

  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor(PDF_COLORS.body);
  for (const paragraph of form.closingParagraphs) {
    doc.text(paragraph, PDF_MARGIN.left, doc.y, { width: PDF_CONTENT_WIDTH, align: 'justify' });
    doc.moveDown(0.5);
  }

  doc.moveDown(1.4);
  const sigY = doc.y;
  doc.fontSize(9).fillColor(PDF_COLORS.muted).font('Helvetica');
  doc.text('Luogo e data', PDF_MARGIN.left, sigY, { width: 220 });
  doc.text('Firma', PDF_MARGIN.left + 300, sigY, { width: 180 });
  const sigLineY = sigY + 30;
  doc.strokeColor(PDF_COLORS.rule).lineWidth(1);
  doc.moveTo(PDF_MARGIN.left, sigLineY).lineTo(PDF_MARGIN.left + 200, sigLineY).stroke();
  doc.moveTo(PDF_MARGIN.left + 300, sigLineY).lineTo(PDF_MARGIN.left + 480, sigLineY).stroke();

  doc.fontSize(8).fillColor(PDF_COLORS.muted).font('Helvetica');
  doc.text(
    `Riferimento normativo: ${form.legalBasis}. Documento generato da ${CANONICAL_URL} — non costituisce consulenza legale.`,
    PDF_MARGIN.left, PDF_PAGE.height - PDF_MARGIN.bottom - 40, { width: PDF_CONTENT_WIDTH },
  );
  drawFooterLogo(doc, logoPath);

  doc.end();
  return bufferPromise;
}

/* ── Landing page ──────────────────────────────────────────────────── */

export function renderLandingHtml(distDir?: string): { html: string; wordCount: number } {
  const homeUrl = `${BASE_URL}/`;

  const breadcrumbHtml = renderBreadcrumb([
    { label: 'Home', href: '/' },
    { label: H1 },
  ]);

  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: homeUrl },
      { '@type': 'ListItem', position: 2, name: H1, item: CANONICAL_URL },
    ],
  });

  const articleLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: H1,
    description: guardArticleJsonLdDescription(DESCRIPTION),
    image: `${BASE_URL}/og-image.png`,
    inLanguage: 'it',
    url: CANONICAL_URL,
    author: { '@type': 'Organization', name: 'Frontaliere Ticino', url: homeUrl },
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: homeUrl,
      logo: imageObjectLd({ url: `${BASE_URL}/icons/icon-512x512.png`, width: 512, height: 512 }),
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': CANONICAL_URL },
  });

  const faqEntries: [string, string][] = [
    [
      'Dove trovo il modulo di autocertificazione dello stato di salute e del casellario giudiziario?',
      'In questa pagina, gratuitamente: sono quattro PDF pronti da scaricare e compilare, due in versione italiana (art. 47 e art. 46 c.1 lett. z, D.P.R. 445/2000) e due in versione svizzera, sul modello dei questionari usati dai datori di lavoro ticinesi.',
    ],
    [
      'Chi deve compilare l’autocertificazione per una candidatura di lavoro?',
      'La compila il candidato in prima persona, con i propri dati anagrafici, firmandola di proprio pugno e allegando copia di un documento di identità in corso di validità.',
    ],
    [
      'L’autocertificazione è valida anche per un datore di lavoro svizzero?',
      'Verso le Pubbliche Amministrazioni italiane l’autocertificazione ha piena efficacia per legge. Verso un datore di lavoro privato, incluse le aziende svizzere, è valida solo se il destinatario accetta di riceverla al posto del documento originale (art. 2, comma 2, D.P.R. 445/2000): conviene chiedere conferma prima di inviarla.',
    ],
    [
      'Serve anche un modulo in stile svizzero, oltre a quello italiano?',
      'Non è obbligatorio, ma può essere utile: molte aziende ticinesi impostano il proprio questionario di autovalutazione sul modello dei formulari cantonali (ad es. quello della SESCO sullo stato di salute) invece che sul D.P.R. 445/2000 italiano. Su questa pagina trovi entrambe le versioni, gratuite.',
    ],
    [
      'Perché il modulo più recente sul casellario giudiziale non chiede più le condanne passate?',
      'Perché l’art. 369 del Codice penale svizzero prevede la cancellazione delle iscrizioni nel casellario dopo un periodo di buona condotta: una condanna cancellata non è più opponibile alla persona, quindi il modulo aggiornato si limita a chiedere se sono in corso procedimenti penali pendenti.',
    ],
    [
      'Un datore di lavoro svizzero può chiedermi qualsiasi informazione sulla mia salute?',
      'No. L’art. 328b del Codice delle obbligazioni limita la raccolta dei dati del candidato a quanto è effettivamente rilevante per valutare l’idoneità alla posizione o necessario per eseguire il contratto: domande generiche o sproporzionate rispetto alle mansioni non sono ammesse.',
    ],
  ];
  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqEntries.map(([q, a]) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  });

  const statTiles = `
    <section class="s-epjKYm">
      <div class="s-tbase">
        <div class="s-tlbl">Moduli PDF pronti</div>
        <div class="s-tval">4</div>
      </div>
      <div class="s-tbase">
        <div class="s-tlbl">Costo</div>
        <div class="s-tval">Gratis</div>
      </div>
      <div class="s-tbase">
        <div class="s-tlbl">Versioni</div>
        <div class="s-tval">IT + CH</div>
      </div>
      <div class="s-tbase">
        <div class="s-tlbl">Tempo di compilazione</div>
        <div class="s-tval">~5 min</div>
      </div>
    </section>`;

  const adviceBanner = `
    <div class="s-card" style="border-left: 4px solid var(--color-warning, #d97706); padding: 1rem; margin: 1.5rem 0;">
      <p style="${BODY_STYLE}"><strong>Attenzione:</strong> l’autocertificazione italiana ha valore pieno solo verso le Pubbliche Amministrazioni italiane. Verso datori di lavoro privati, incluse le aziende svizzere, è valida solo se chi la riceve accetta esplicitamente di sostituirla al documento originale — per questo mettiamo a disposizione anche una versione in stile svizzero.</p>
    </div>`;

  const ctaSection = `
    <section class="s-p1QaOi">
      <a href="${esc(HEALTH_PDF_PATH)}" class="s-cta" download data-pdf-gate data-pdf-gate-source="self_cert_health_it" data-pdf-gate-label="Autocertificazione italiana — stato di salute">Scarica autocertificazione italiana stato di salute (PDF)</a>
      <a href="${esc(CRIMINAL_RECORD_PDF_PATH)}" class="s-cta" download data-pdf-gate data-pdf-gate-source="self_cert_criminal_record_it" data-pdf-gate-label="Autocertificazione italiana — casellario giudiziario">Scarica autocertificazione italiana casellario giudiziario (PDF)</a>
      <a href="${esc(CH_HEALTH_PDF_PATH)}" class="s-cta" download data-pdf-gate data-pdf-gate-source="self_cert_health_ch" data-pdf-gate-label="Questionario svizzero — stato di salute">Scarica questionario svizzero stato di salute (PDF)</a>
      <a href="${esc(CH_CRIMINAL_RECORD_PDF_PATH)}" class="s-cta" download data-pdf-gate data-pdf-gate-source="self_cert_criminal_record_ch" data-pdf-gate-label="Autocertificazione svizzera — casellario giudiziario">Scarica autocertificazione svizzera casellario giudiziario (PDF)</a>
    </section>`;

  const body = `
    ${breadcrumbHtml}
    <header class="s-sy52lX">
      <p style="${HERO_EYEBROW_STYLE}">Guida pratica · candidature di lavoro</p>
      <h1 style="${H1_STYLE}">${esc(H1)}</h1>
      <p style="${LEDE_STYLE}">${esc(LEDE)}</p>
    </header>
    ${statTiles}
    ${adviceBanner}
    ${ctaSection}
    ${DRIVEBY_AD_SNIPPET}
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">Cos’è l’autocertificazione</h2>
      <p style="${BODY_STYLE}">L’autocertificazione (o dichiarazione sostitutiva) è un documento con cui una persona dichiara sotto la propria responsabilità fatti, stati o qualità personali, senza dover produrre un certificato ufficiale rilasciato da un ente. In Italia è disciplinata dal Decreto del Presidente della Repubblica 28 dicembre 2000, n. 445 (D.P.R. 445/2000), la legge che semplifica i rapporti tra cittadini e amministrazioni pubbliche. In Svizzera non esiste un istituto identico, ma i datori di lavoro utilizzano da tempo questionari di autovalutazione dai contenuti molto simili, costruiti sul quadro normativo svizzero.</p>
      <p style="${BODY_STYLE}">Nel caso di una candidatura di lavoro, l’autocertificazione più richiesta riguarda due aspetti: lo stato di salute generale (art. 47 D.P.R. 445/2000, dichiarazione sostitutiva di atto di notorietà) e l’assenza di condanne penali risultanti dal casellario giudiziale (art. 46, comma 1, lett. z, D.P.R. 445/2000, dichiarazione sostitutiva di certificazione).</p>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">Chi deve compilarla</h2>
      <p style="${BODY_STYLE}">Il modulo va compilato dal candidato in prima persona: nessun altro può dichiarare al posto suo. Va scritto in stampatello o compilato al computer, firmato di proprio pugno in originale e consegnato o inviato insieme a una copia fotostatica di un documento di identità in corso di validità, come richiesto dall’art. 38, comma 3, del D.P.R. 445/2000 per la versione italiana.</p>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">Come si compila, passo per passo</h2>
      <ol class="s-C1hMlw">
        <li class="s-U2-lJ-">Scarica il PDF corrispondente (stato di salute o casellario giudiziario, versione italiana o svizzera) qui sopra.</li>
        <li class="s-U2-lJ-">Compila i dati anagrafici: nome, cognome, luogo e data di nascita, residenza, codice fiscale.</li>
        <li class="s-U2-lJ-">Indica il nome dell’azienda o ente a cui invii la candidatura nel campo destinatario.</li>
        <li class="s-U2-lJ-">Leggi la dichiarazione o le domande: descrivono esattamente cosa stai attestando e, per la versione italiana, le responsabilità penali in caso di dichiarazioni false (art. 76 D.P.R. 445/2000).</li>
        <li class="s-U2-lJ-">Indica luogo, data e firma di proprio pugno.</li>
        <li class="s-q3nqK4">Allega una copia (anche fotografia leggibile) di un documento di identità valido.</li>
      </ol>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">Quando vale davvero: Italia vs datori di lavoro svizzeri</h2>
      <p style="${BODY_STYLE}">Verso le Pubbliche Amministrazioni italiane e i gestori di servizi pubblici, l’autocertificazione sostituisce per legge il certificato originale: l’ente non può rifiutarla né chiedere il documento ufficiale al suo posto.</p>
      <p style="${BODY_STYLE}">Verso un soggetto privato — incluso un datore di lavoro svizzero — la situazione è diversa: l’art. 2, comma 2, del D.P.R. 445/2000 la rende valida solo se chi la riceve accetta di considerarla equivalente al documento originale. Molte aziende ticinesi preferiscono invece un proprio questionario in stile svizzero, come quelli proposti più sotto. Se il datore di lavoro richiede il documento originale, il certificato medico va richiesto al proprio medico curante o al servizio di medicina del lavoro, mentre l’estratto del casellario giudiziale italiano si richiede tramite lo sportello online del Ministero della Giustizia o presso qualunque ufficio del casellario in Italia; l’equivalente svizzero (estratto per privati) si richiede all’Ufficio federale di giustizia.</p>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">Il modello in uso presso i datori di lavoro svizzeri</h2>
      <p style="${BODY_STYLE}">Molte aziende ed enti in Ticino, oltre o al posto dell’autocertificazione italiana, utilizzano un proprio questionario di autovalutazione, costruito sul modello dei formulari cantonali — ad esempio il questionario sullo stato di salute della SESCO (Sezione delle risorse umane del Cantone Ticino, versione gennaio 2018) o i moduli di autocertificazione del casellario giudiziale diffusi da enti come Lugano Living In Switzerland (Lugano-LIS). Per gli impieghi pubblici cantonali, il riferimento normativo è la LORD (Legge sull’ordinamento degli impiegati dello Stato e dei docenti), artt. 13 e 40; per i rapporti di lavoro privati vale l’art. 328b del Codice delle obbligazioni (CO), che limita la raccolta di dati personali del candidato a quanto è realmente rilevante per valutare l’idoneità alla posizione.</p>
      <p style="${BODY_STYLE}">Abbiamo preparato due PDF aggiuntivi, in italiano, che seguono questo modello: un questionario di autovalutazione dello stato di salute e un’autocertificazione dell’assenza di procedimenti penali pendenti, entrambi pensati per candidature presso datori di lavoro ticinesi.</p>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">Cosa può chiedere (e cosa no) un datore di lavoro svizzero</h2>
      <p style="${BODY_STYLE}">L’art. 328b CO stabilisce un principio semplice: il datore di lavoro può raccogliere solo i dati del candidato che riguardano la sua idoneità al posto di lavoro o che sono necessari per eseguire il contratto. Domande su stato di salute o casellario giudiziale sono lecite solo se il tema è rilevante per le mansioni specifiche della posizione — ad esempio la sicurezza sul lavoro, la guida di veicoli, il contatto con minori o con valori. Domande generiche, sproporzionate o riferite a condanne penali già cancellate dal casellario non sono ammesse.</p>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">Perché il modulo aggiornato sul casellario giudiziale è più snello</h2>
      <p style="${BODY_STYLE}">I modelli più recenti in circolazione chiedono solo se il candidato è parte in un procedimento penale attualmente pendente, senza più domandare condanne passate. Il motivo è l’art. 369 del Codice penale svizzero, che prevede la cancellazione delle iscrizioni nel casellario giudiziale dopo un periodo di buona condotta: una condanna cancellata non può più essere fatta valere contro la persona interessata, quindi chiedere conto di condanne passate espone il datore di lavoro al rischio di una domanda non più lecita.</p>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">Domande frequenti</h2>
      ${faqEntries.map(([q, a]) => `
      <h3 style="${H3_STYLE}">${esc(q)}</h3>
      <p style="${BODY_STYLE}">${esc(a)}</p>`).join('')}
    </section>
    <section class="s-p1QaOi">
      <a href="/cerca-lavoro-ticino/" class="s-cta">Cerca lavoro in Ticino</a>
      <a class="s-bX1C8q" href="/articoli-frontaliere/documenti-necessari-lavoro-svizzera/" style="${LINK_ACCENT_STYLE}">Tutti i documenti per lavorare in Svizzera</a>
    </section>
  `;

  const adSection = `<section class="s-U5Q4dL" aria-label="advertisement">${adSlotHtml('ARTICLE_END_MULTIPLEX')}</section>`;
  const bodyHtml = `<main class="s-xzWvwM">${body}</main>${adSection}`;
  const wordCount = countHtmlBodyWords(body);

  const html = buildSeoPageHtml({
    locale: 'it',
    title: TITLE,
    description: DESCRIPTION,
    canonicalUrl: CANONICAL_URL,
    robots: wordCount >= MIN_INDEXABLE_WORDS ? 'index,follow' : 'noindex,follow',
    ogType: 'article',
    jsonLdScripts: [breadcrumbLd, articleLd, faqLd],
    bodyHtml,
    distDir,
  });

  return { html, wordCount };
}

/* ── Plugin ────────────────────────────────────────────────────────── */

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const masterSitemap = path.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(masterSitemap)) return;
  try {
    let idx = fs.readFileSync(masterSitemap, 'utf-8');
    if (!idx.includes('sitemap-moduli.xml')) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-moduli.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-moduli\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(masterSitemap, idx, 'utf-8');
  } catch (err) {
    console.warn('\x1b[33m[self-certification-forms]\x1b[0m sitemap-index patch failed:', err);
  }
}

export function selfCertificationFormsPlugin(rootDir: string): Plugin {
  return {
    name: 'self-certification-forms',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_SELF_CERTIFICATION_FORMS === '1') {
        console.log('\x1b[36m[self-certification-forms]\x1b[0m skipped (SKIP_SELF_CERTIFICATION_FORMS=1)');
        return;
      }

      const distDir = path.resolve(rootDir, 'dist');
      const dateStamp = new Date().toISOString().slice(0, 10);

      const collector = new WriteCollector({
        distDir,
        pluginName: 'selfCertificationFormsPlugin',
      });

      const { html, wordCount } = renderLandingHtml(distDir);
      if (wordCount < MIN_INDEXABLE_WORDS) {
        console.warn(`\x1b[33m[self-certification-forms]\x1b[0m landing below MIN_INDEXABLE_WORDS (${wordCount}) — will be noindex`);
      }
      collector.add(path.join(distDir, LANDING_URL_PATH, 'index.html'), html);
      collector.add(path.join(distDir, LANDING_URL_PATH.replace(/\/+$/, '') + '.html'), html);

      const logoPath = path.resolve(rootDir, 'public', 'images', 'publisher', 'logo-rect-400.png');
      const [healthPdf, criminalRecordPdf, chHealthPdf, chCriminalRecordPdf] = await Promise.all([
        generateSelfCertificationPdf(HEALTH_FORM, logoPath),
        generateSelfCertificationPdf(CRIMINAL_RECORD_FORM, logoPath),
        generateSwissSelfCertificationPdf(CH_HEALTH_FORM, logoPath),
        generateSwissSelfCertificationPdf(CH_CRIMINAL_RECORD_FORM, logoPath),
      ]);
      fs.mkdirSync(path.join(distDir, 'moduli'), { recursive: true });
      fs.writeFileSync(path.join(distDir, HEALTH_PDF_PATH), healthPdf);
      fs.writeFileSync(path.join(distDir, CRIMINAL_RECORD_PDF_PATH), criminalRecordPdf);
      fs.writeFileSync(path.join(distDir, CH_HEALTH_PDF_PATH), chHealthPdf);
      fs.writeFileSync(path.join(distDir, CH_CRIMINAL_RECORD_PDF_PATH), chCriminalRecordPdf);

      const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${CANONICAL_URL}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>\n</urlset>\n`;
      try {
        fs.writeFileSync(path.join(distDir, 'sitemap-moduli.xml'), sitemapXml, 'utf-8');
      } catch (err) {
        console.warn('\x1b[33m[self-certification-forms]\x1b[0m sitemap write failed:', err);
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(`\x1b[36m[self-certification-forms]\x1b[0m Generated landing + 4 PDFs — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

      if (fs.existsSync(path.join(distDir, 'sitemap-moduli.xml'))) {
        patchSitemapIndex(distDir, dateStamp);
      }
    },
  };
}
