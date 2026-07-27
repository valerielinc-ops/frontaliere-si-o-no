/**
 * Self-certification forms — Vite build plugin.
 *
 * Emits a static IT-only landing page explaining Italian self-certification
 * (DPR 445/2000) for job applications, plus two ready-to-fill legally-formatted
 * PDF templates generated with pdfkit:
 *   - autocertificazione-stato-di-salute.pdf (art. 47 DPR 445/2000)
 *   - autocertificazione-casellario-giudiziario.pdf (art. 46 c.1 lett. z DPR 445/2000)
 *
 * IT-only: the underlying legal instrument (DPR 445/2000) is Italian law and
 * has no equivalent facsimile in the other locales (same precedent as
 * pdfWhitepapersPlugin.ts, which only sources services/locales/blog-body/it/).
 *
 * URLs:
 *   /moduli/autocertificazione-candidatura/
 *   /moduli/autocertificazione-stato-di-salute.pdf
 *   /moduli/autocertificazione-casellario-giudiziario.pdf
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

const TITLE = 'Autocertificazione stato di salute e casellario giudiziario | Frontaliere Ticino';
const H1 = 'Autocertificazione stato di salute e casellario giudiziario: moduli e guida';
const DESCRIPTION = 'Modulo di autocertificazione dello stato di salute e del casellario giudiziario per candidarti a un lavoro: due PDF pronti da compilare, gratis, conformi al DPR 445/2000.';
const LEDE = 'Due PDF pronti da compilare per autocertificare stato di salute e casellario giudiziario in una candidatura di lavoro.';

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

/* ── PDF generation ────────────────────────────────────────────────── */

const PDF_COLORS = {
  headerBg: '#1e293b',
  white: '#ffffff',
  body: '#334155',
  heading: '#1e40af',
  muted: '#64748b',
  rule: '#cbd5e1',
};

const PDF_PAGE = { width: 595.28, height: 841.89 }; // A4
const PDF_MARGIN = { top: 56, bottom: 56, left: 56, right: 56 };
const PDF_CONTENT_WIDTH = PDF_PAGE.width - PDF_MARGIN.left - PDF_MARGIN.right;

function drawField(doc: PDFKit.PDFDocument, label: string, width?: number): void {
  const w = width ?? PDF_CONTENT_WIDTH;
  doc.fontSize(9).font('Helvetica').fillColor(PDF_COLORS.muted);
  doc.text(label, { continued: false });
  const lineY = doc.y + 14;
  doc.strokeColor(PDF_COLORS.rule).lineWidth(1);
  doc.moveTo(doc.x, lineY).lineTo(doc.x + w, lineY).stroke();
  doc.y = lineY + 8;
}

export async function generateSelfCertificationPdf(form: SelfCertFormMeta): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
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
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

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
    drawField(doc, 'Nato/a a', 260);
    doc.y -= 22;
    drawField(doc, 'il (gg/mm/aaaa)', 200);
    doc.x = PDF_MARGIN.left;
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

    doc.end();
  });
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
      'In questa pagina, gratuitamente: sono due PDF pronti da scaricare e compilare, uno per lo stato di salute (art. 47 D.P.R. 445/2000) e uno per il casellario giudiziale (art. 46, comma 1, lett. z, D.P.R. 445/2000).',
    ],
    [
      'Chi deve compilare l’autocertificazione per una candidatura di lavoro?',
      'La compila il candidato in prima persona, con i propri dati anagrafici, firmandola di proprio pugno e allegando copia di un documento di identità in corso di validità.',
    ],
    [
      'L’autocertificazione è valida anche per un datore di lavoro svizzero?',
      'Verso le Pubbliche Amministrazioni italiane l’autocertificazione ha piena efficacia per legge. Verso un datore di lavoro privato, incluse le aziende svizzere, è valida solo se il destinatario accetta di riceverla al posto del documento originale (art. 2, comma 2, D.P.R. 445/2000): conviene chiedere conferma prima di inviarla.',
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
        <div class="s-tval">2</div>
      </div>
      <div class="s-tbase">
        <div class="s-tlbl">Costo</div>
        <div class="s-tval">Gratis</div>
      </div>
      <div class="s-tbase">
        <div class="s-tlbl">Riferimento normativo</div>
        <div class="s-tval">D.P.R. 445/2000</div>
      </div>
      <div class="s-tbase">
        <div class="s-tlbl">Tempo di compilazione</div>
        <div class="s-tval">~5 min</div>
      </div>
    </section>`;

  const adviceBanner = `
    <div class="s-card" style="border-left: 4px solid var(--color-warning, #d97706); padding: 1rem; margin: 1.5rem 0;">
      <p style="${BODY_STYLE}"><strong>Attenzione:</strong> l’autocertificazione ha valore pieno solo verso le Pubbliche Amministrazioni italiane. Verso datori di lavoro privati, incluse le aziende svizzere, è valida solo se chi la riceve accetta esplicitamente di sostituirla al documento originale.</p>
    </div>`;

  const ctaSection = `
    <section class="s-p1QaOi">
      <a href="${esc(HEALTH_PDF_PATH)}" class="s-cta" download>Scarica autocertificazione stato di salute (PDF)</a>
      <a href="${esc(CRIMINAL_RECORD_PDF_PATH)}" class="s-cta" download>Scarica autocertificazione casellario giudiziario (PDF)</a>
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
      <p style="${BODY_STYLE}">L’autocertificazione (o dichiarazione sostitutiva) è un documento con cui una persona dichiara sotto la propria responsabilità fatti, stati o qualità personali, senza dover produrre un certificato ufficiale rilasciato da un ente. È disciplinata dal Decreto del Presidente della Repubblica 28 dicembre 2000, n. 445 (D.P.R. 445/2000), la legge italiana che semplifica i rapporti tra cittadini e amministrazioni pubbliche.</p>
      <p style="${BODY_STYLE}">Nel caso di una candidatura di lavoro, l’autocertificazione più richiesta riguarda due aspetti: lo stato di salute generale (art. 47 D.P.R. 445/2000, dichiarazione sostitutiva di atto di notorietà) e l’assenza di condanne penali risultanti dal casellario giudiziale (art. 46, comma 1, lett. z, D.P.R. 445/2000, dichiarazione sostitutiva di certificazione).</p>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">Chi deve compilarla</h2>
      <p style="${BODY_STYLE}">Il modulo va compilato dal candidato in prima persona: nessun altro può dichiarare al posto suo. Va scritto in stampatello o compilato al computer, firmato di proprio pugno in originale e consegnato o inviato insieme a una copia fotostatica di un documento di identità in corso di validità, come richiesto dall’art. 38, comma 3, del D.P.R. 445/2000.</p>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">Come si compila, passo per passo</h2>
      <ol class="s-C1hMlw">
        <li class="s-U2-lJ-">Scarica il PDF corrispondente (stato di salute o casellario giudiziario) qui sopra.</li>
        <li class="s-U2-lJ-">Compila i dati anagrafici: nome, cognome, luogo e data di nascita, residenza, codice fiscale.</li>
        <li class="s-U2-lJ-">Indica il nome dell’azienda o ente a cui invii la candidatura nel campo destinatario.</li>
        <li class="s-U2-lJ-">Leggi la dichiarazione: descrive esattamente cosa stai attestando e le responsabilità penali in caso di dichiarazioni false (art. 76 D.P.R. 445/2000).</li>
        <li class="s-U2-lJ-">Indica luogo, data e firma di proprio pugno.</li>
        <li class="s-q3nqK4">Allega una copia (anche fotografia leggibile) di un documento di identità valido.</li>
      </ol>
    </section>
    <section class="s-KZc0LQ">
      <h2 style="${H2_STYLE}">Quando vale davvero: Italia vs datori di lavoro svizzeri</h2>
      <p style="${BODY_STYLE}">Verso le Pubbliche Amministrazioni italiane e i gestori di servizi pubblici, l’autocertificazione sostituisce per legge il certificato originale: l’ente non può rifiutarla né chiedere il documento ufficiale al suo posto.</p>
      <p style="${BODY_STYLE}">Verso un soggetto privato — incluso un datore di lavoro svizzero — la situazione è diversa: l’art. 2, comma 2, del D.P.R. 445/2000 la rende valida solo se chi la riceve accetta di considerarla equivalente al documento originale. Molte aziende ticinesi la accettano volentieri in fase di candidatura, per snellire il processo, ma è buona norma chiederlo esplicitamente. Se il datore di lavoro richiede il documento originale, il certificato medico va richiesto al proprio medico curante o al servizio di medicina del lavoro, mentre l’estratto del casellario giudiziale si richiede tramite lo sportello online del Ministero della Giustizia o presso qualunque ufficio del casellario in Italia.</p>
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

      const [healthPdf, criminalRecordPdf] = await Promise.all([
        generateSelfCertificationPdf(HEALTH_FORM),
        generateSelfCertificationPdf(CRIMINAL_RECORD_FORM),
      ]);
      fs.mkdirSync(path.join(distDir, 'moduli'), { recursive: true });
      fs.writeFileSync(path.join(distDir, HEALTH_PDF_PATH), healthPdf);
      fs.writeFileSync(path.join(distDir, CRIMINAL_RECORD_PDF_PATH), criminalRecordPdf);

      const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${CANONICAL_URL}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>\n</urlset>\n`;
      try {
        fs.writeFileSync(path.join(distDir, 'sitemap-moduli.xml'), sitemapXml, 'utf-8');
      } catch (err) {
        console.warn('\x1b[33m[self-certification-forms]\x1b[0m sitemap write failed:', err);
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(`\x1b[36m[self-certification-forms]\x1b[0m Generated landing + 2 PDFs — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

      if (fs.existsSync(path.join(distDir, 'sitemap-moduli.xml'))) {
        patchSitemapIndex(distDir, dateStamp);
      }
    },
  };
}
