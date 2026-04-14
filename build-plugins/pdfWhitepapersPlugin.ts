import path from 'path';
import type { Plugin } from 'vite';
import { BASE_URL } from './constants';

interface PdfGuide {
 filename: string;
 title: string;
 subtitle: string;
 articleSlug: string;
 bodyText: string;
}

const GUIDES: PdfGuide[] = [
 {
 filename: 'guida-completa-frontaliere-2026',
 title: 'Guida Completa Frontaliere 2026',
 subtitle: 'Tutto ciò che devi sapere per lavorare in Svizzera dal confine italiano',
 articleSlug: 'guida-completa-frontaliere',
 bodyText: 'La guida completa per frontalieri 2026 copre ogni aspetto della vita lavorativa transfrontaliera: dal calcolo dello stipendio netto con il nuovo accordo fiscale Italia-Svizzera, alla scelta tra permesso G e permesso B, passando per la dichiarazione dei redditi, i contributi AVS/LPP, e le deduzioni fiscali disponibili. Include tabelle comparative aggiornate, esempi pratici di busta paga e una checklist completa per chi inizia a lavorare in Ticino.',
 },
 {
 filename: 'permesso-g-vantaggi-svantaggi',
 title: 'Permesso G: Vantaggi e Svantaggi',
 subtitle: 'Analisi completa del permesso per frontalieri nel 2026',
 articleSlug: 'permesso-g-vantaggi-svantaggi',
 bodyText: 'Il permesso G (Grenzgängerbewilligung) è il documento che autorizza i frontalieri a lavorare in Svizzera risiedendo in Italia. Questa guida analizza in dettaglio vantaggi e svantaggi: dalla tassazione alla fonte con il nuovo accordo 2026, alle prestazioni sociali (AVS, disoccupazione, maternità), fino ai costi di trasporto e alla qualità di vita. Confronto pratico tra restare in Italia con permesso G e trasferirsi in Svizzera con permesso B.',
 },
 {
 filename: 'lamal-vs-ssn-frontalieri',
 title: 'LAMal vs SSN per Frontalieri',
 subtitle: 'Guida alla scelta dell\'assicurazione sanitaria',
 articleSlug: 'lamal-vs-ssn-decisione',
 bodyText: 'I frontalieri italiani in Svizzera possono scegliere tra l\'assicurazione obbligatoria svizzera LAMal e il Servizio Sanitario Nazionale italiano (SSN). Questa guida confronta costi, coperture, franchigie e tempi di attesa di entrambe le opzioni. Include simulazioni di premio per i principali assicuratori LAMal nei cantoni di frontiera (Ticino, Grigioni, Vallese) e analizza i casi in cui conviene optare per il diritto di scelta SSN entro 3 mesi dall\'inizio dell\'impiego.',
 },
 {
 filename: 'trovare-lavoro-ticino-frontaliere',
 title: 'Trovare Lavoro in Ticino',
 subtitle: 'Strategie efficaci per frontalieri nel mercato svizzero',
 articleSlug: 'trovare-lavoro-ticino',
 bodyText: 'Il mercato del lavoro ticinese offre opportunità in settori come farmaceutica, finanza, logistica e IT, con salari mediamente superiori a quelli italiani. Questa guida presenta le strategie più efficaci per trovare lavoro come frontaliere: dai portali specializzati (jobs.ch, jobscout24) alle agenzie interinali, dalla candidatura spontanea alle aziende del Luganese fino al networking professionale. Include consigli su CV svizzero, colloquio di lavoro e aspettative salariali per ruolo.',
 },
];

/* ── Colour palette (decimal RGB for pdfkit) ─────────────── */
/* ── Colour palette (hex strings for pdfkit) ─────────────── */
const COLORS = {
 headerBg: '#1e293b', // slate-800
 white: '#ffffff',
 body: '#334155', // slate-700
 heading: '#1e40af', // blue-800
 link: '#2563eb', // blue-600
 muted: '#64748b', // slate-500
 bullet: '#1e40af', // blue-800
 rule: '#cbd5e1', // slate-300
};

const PAGE = { width: 595.28, height: 841.89 }; // A4
const MARGIN = { top: 56, bottom: 56, left: 56, right: 56 };
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;

/* ── Parsed content types ─────────────────────────────────── */
interface Section { type: 'h2' | 'h3'; text: string }
interface ContentBlock {
 type: 'h2' | 'h3' | 'paragraph' | 'bullet';
 text: string;
}

/**
 * Read a blog body .ts file and extract the markdown content strings.
 * Returns concatenated body1+body2+... in order.
 * Handles both single-quoted ('...') and backtick-quoted (`...`) values.
 */
function extractArticleContent(
 fs: typeof import('node:fs'),
 rootDir: string,
 articleSlug: string,
): string | null {
 const filePath = path.join(rootDir, 'services', 'locales', 'blog-body', 'it', `${articleSlug}.ts`);

 if (!fs.existsSync(filePath)) return null;

 const raw = fs.readFileSync(filePath, 'utf-8');
 const bodies: string[] = [];

 for (let n = 1; n <= 20; n++) {
 const keyStr = `'blog.article.${articleSlug}.body${n}':`;
 const idx = raw.indexOf(keyStr);
 if (idx < 0) break;

 // Find the opening delimiter (single-quote or backtick) after the colon
 let pos = idx + keyStr.length;
 while (pos < raw.length && raw[pos] !== "'" && raw[pos] !== '`') pos++;
 if (pos >= raw.length) break;

 const delimiter = raw[pos]; // either "'" or "`"
 const start = pos + 1;
 pos = start;

 if (delimiter === '`') {
 // Backtick: scan for unescaped closing backtick
 while (pos < raw.length) {
 if (raw[pos] === '`' && raw[pos - 1] !== '\\') break;
 pos++;
 }
 } else {
 // Single quote: scan for unescaped closing quote
 while (pos < raw.length) {
 if (raw[pos] === "'" && raw[pos - 1] !== '\\') break;
 pos++;
 }
 }

 let value = raw.substring(start, pos);

 // Unescape depending on delimiter style
 if (delimiter === "'") {
 value = value
 .replace(/\\n/g, '\n')
 .replace(/\\'/g, "'")
 .replace(/\\"/g, '"')
 .replace(/\\\\/g, '\\');
 } else {
 // Backtick strings: newlines are literal, only \\` needs unescaping
 value = value.replace(/\\`/g, '`');
 }

 bodies.push(value);
 }

 return bodies.length > 0 ? bodies.join('\n\n') : null;
}

/** Parse markdown content into structured blocks for PDF rendering. */
function parseContent(markdown: string): { sections: Section[]; blocks: ContentBlock[] } {
 const sections: Section[] = [];
 const blocks: ContentBlock[] = [];
 const lines = markdown.split('\n');

 for (const line of lines) {
 const trimmed = line.trim();
 if (!trimmed) continue;

 if (trimmed.startsWith('## ')) {
 const text = stripMarkdownFormatting(trimmed.slice(3).trim());
 if (text) {
 sections.push({ type: 'h2', text });
 blocks.push({ type: 'h2', text });
 }
 } else if (trimmed.startsWith('### ')) {
 const text = stripMarkdownFormatting(trimmed.slice(4).trim());
 if (text) {
 sections.push({ type: 'h3', text });
 blocks.push({ type: 'h3', text });
 }
 } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
 const text = stripMarkdownFormatting(trimmed.slice(2).trim());
 if (text) blocks.push({ type: 'bullet', text });
 } else if (trimmed.startsWith('| ') || trimmed.startsWith('>') || trimmed.startsWith('#')) {
 // Skip tables, blockquotes (too complex for simple PDF), and H1/H4+
 if (trimmed.startsWith('> ')) {
 const text = stripMarkdownFormatting(trimmed.slice(2).trim());
 if (text) blocks.push({ type: 'paragraph', text: `« ${text} »` });
 }
 } else {
 const text = stripMarkdownFormatting(trimmed);
 if (text && text.length > 2) blocks.push({ type: 'paragraph', text });
 }
 }

 return { sections, blocks };
}

/** Strip markdown formatting (bold, italic, links) to plain text. */
function stripMarkdownFormatting(text: string): string {
 return text
 .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold**
 .replace(/\*([^*]+)\*/g, '$1') // *italic*
 .replace(/`([^`]+)`/g, '$1') // `code`
 .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url)
 .replace(/~~([^~]+)~~/g, '$1') // ~~strikethrough~~
 .trim();
}

/**
 * Generate a single PDF whitepaper and return it as a Buffer.
 */
async function generatePdf(guide: PdfGuide, markdown: string): Promise<Buffer> {
 const PDFDocument = (await import('pdfkit')).default;

 return new Promise((resolve, reject) => {
 const chunks: Buffer[] = [];
 const doc = new PDFDocument({
 size: 'A4',
 margins: { top: MARGIN.top, bottom: MARGIN.bottom, left: MARGIN.left, right: MARGIN.right },
 bufferPages: true,
 info: {
 Title: guide.title,
 Author: 'Frontaliere Ticino',
 Subject: guide.subtitle,
 Creator: 'frontaliereticino.ch',
 },
 });

 doc.on('data', (chunk: Buffer) => chunks.push(chunk));
 doc.on('end', () => resolve(Buffer.concat(chunks)));
 doc.on('error', reject);

 const { sections, blocks } = parseContent(markdown);

 // ── Cover Page ──────────────────────────────────────────
 renderCoverPage(doc, guide);

 // ── Table of Contents ───────────────────────────────────
 if (sections.length > 0) {
 doc.addPage();
 renderTableOfContents(doc, sections);
 }

 // ── Body Content ────────────────────────────────────────
 doc.addPage();
 renderBodyContent(doc, blocks);

 // ── Back Page (CTA) ─────────────────────────────────────
 doc.addPage();
 renderBackPage(doc);

 // ── Page Numbers (footer on every page except cover) ────
 const totalPages = doc.bufferedPageRange().count;
 for (let i = 1; i < totalPages; i++) {
 doc.switchToPage(i);
 const footerY = PAGE.height - 36;
 doc.fontSize(8).fillColor(COLORS.muted);
 doc.text(
 `© 2026 Frontaliere Ticino — frontaliereticino.ch`,
 MARGIN.left, footerY,
 { width: CONTENT_WIDTH / 2, align: 'left' },
 );
 doc.text(
 `Pagina ${i} di ${totalPages - 1}`,
 PAGE.width / 2, footerY,
 { width: CONTENT_WIDTH / 2, align: 'right' },
 );
 }

 doc.end();
 });
}

function renderCoverPage(doc: PDFKit.PDFDocument, guide: PdfGuide): void {
 // Full-width header background
 doc.rect(0, 0, PAGE.width, PAGE.height).fill(COLORS.headerBg);

 // Title
 doc.fillColor(COLORS.white);
 doc.fontSize(36).font('Helvetica-Bold');
 doc.text(guide.title, MARGIN.left, PAGE.height * 0.3, {
 width: CONTENT_WIDTH,
 align: 'center',
 });

 // Subtitle
 doc.moveDown(0.8);
 doc.fontSize(16).font('Helvetica');
 doc.text(guide.subtitle, MARGIN.left, doc.y, {
 width: CONTENT_WIDTH,
 align: 'center',
 });

 // Branding line
 doc.moveDown(3);
 doc.fontSize(14).font('Helvetica-Bold');
 doc.text('frontaliereticino.ch', MARGIN.left, doc.y, {
 width: CONTENT_WIDTH,
 align: 'center',
 });

 // Date
 doc.moveDown(1);
 doc.fontSize(12).font('Helvetica');
 doc.text('Aprile 2026', MARGIN.left, doc.y, {
 width: CONTENT_WIDTH,
 align: 'center',
 });
}

function renderTableOfContents(doc: PDFKit.PDFDocument, sections: Section[]): void {
 doc.fillColor(COLORS.heading).fontSize(24).font('Helvetica-Bold');
 doc.text('Indice', MARGIN.left, MARGIN.top, { width: CONTENT_WIDTH });
 doc.moveDown(1);

 // Horizontal rule
 doc.strokeColor(COLORS.rule).lineWidth(1);
 doc.moveTo(MARGIN.left, doc.y).lineTo(PAGE.width - MARGIN.right, doc.y).stroke();
 doc.moveDown(0.8);

 let tocIndex = 0;
 for (const section of sections) {
 if (section.type === 'h2') {
 tocIndex++;
 doc.fillColor(COLORS.body).fontSize(12).font('Helvetica-Bold');
 doc.text(`${tocIndex}. ${section.text}`, MARGIN.left, doc.y, {
 width: CONTENT_WIDTH,
 });
 doc.moveDown(0.3);
 } else if (section.type === 'h3') {
 doc.fillColor(COLORS.muted).fontSize(10).font('Helvetica');
 doc.text(` ${section.text}`, MARGIN.left + 16, doc.y, {
 width: CONTENT_WIDTH - 16,
 });
 doc.moveDown(0.2);
 }

 // If we're near the bottom, stop to avoid overflow (ToC is a preview)
 if (doc.y > PAGE.height - MARGIN.bottom - 40) break;
 }
}

function renderBodyContent(doc: PDFKit.PDFDocument, blocks: ContentBlock[]): void {
 for (const block of blocks) {
 // Check if we need a new page (leave room for at least a heading + paragraph)
 const spaceNeeded = block.type === 'h2' ? 60 : block.type === 'h3' ? 45 : 30;
 if (doc.y > PAGE.height - MARGIN.bottom - spaceNeeded) {
 doc.addPage();
 }

 switch (block.type) {
 case 'h2':
 doc.moveDown(0.8);
 // Horizontal rule before H2
 doc.strokeColor(COLORS.rule).lineWidth(0.5);
 doc.moveTo(MARGIN.left, doc.y).lineTo(PAGE.width - MARGIN.right, doc.y).stroke();
 doc.moveDown(0.5);
 doc.fillColor(COLORS.heading).fontSize(18).font('Helvetica-Bold');
 doc.text(block.text, MARGIN.left, doc.y, { width: CONTENT_WIDTH });
 doc.moveDown(0.4);
 break;

 case 'h3':
 doc.moveDown(0.5);
 doc.fillColor(COLORS.heading).fontSize(14).font('Helvetica-Bold');
 doc.text(block.text, MARGIN.left, doc.y, { width: CONTENT_WIDTH });
 doc.moveDown(0.3);
 break;

 case 'bullet':
 doc.fillColor(COLORS.bullet).fontSize(10).font('Helvetica-Bold');
 doc.text('•', MARGIN.left, doc.y, { continued: false });
 doc.fillColor(COLORS.body).fontSize(10).font('Helvetica');
 doc.text(block.text, MARGIN.left + 14, doc.y - 12, {
 width: CONTENT_WIDTH - 14,
 });
 doc.moveDown(0.15);
 break;

 case 'paragraph':
 doc.fillColor(COLORS.body).fontSize(10).font('Helvetica');
 doc.text(block.text, MARGIN.left, doc.y, {
 width: CONTENT_WIDTH,
 lineGap: 3,
 });
 doc.moveDown(0.4);
 break;
 }
 }
}

function renderBackPage(doc: PDFKit.PDFDocument): void {
 // Centered CTA page
 doc.rect(0, 0, PAGE.width, PAGE.height).fill(COLORS.headerBg);

 doc.fillColor(COLORS.white);
 doc.fontSize(22).font('Helvetica-Bold');
 doc.text('Calcola il tuo stipendio netto', MARGIN.left, PAGE.height * 0.35, {
 width: CONTENT_WIDTH,
 align: 'center',
 });

 doc.moveDown(1);
 doc.fontSize(14).font('Helvetica');
 doc.text(
 'Usa il simulatore gratuito per confrontare stipendio netto, tasse e contributi tra Svizzera e Italia.',
 MARGIN.left, doc.y,
 { width: CONTENT_WIDTH, align: 'center' },
 );

 doc.moveDown(2);
 doc.fillColor(COLORS.link).fontSize(16).font('Helvetica-Bold');
 doc.text('frontaliereticino.ch/calcola-stipendio', MARGIN.left, doc.y, {
 width: CONTENT_WIDTH,
 align: 'center',
 link: `${BASE_URL}/calcola-stipendio`,
 });

 doc.moveDown(4);
 doc.fillColor(COLORS.muted).fontSize(10).font('Helvetica');
 doc.text(
 '© 2026 Frontaliere Ticino — Tutti i diritti riservati',
 MARGIN.left, doc.y,
 { width: CONTENT_WIDTH, align: 'center' },
 );
}

/* ── HTML Landing Page for each PDF ──────────────────────── */

function generateLandingPage(guide: PdfGuide, pdfSizeKb: string, dateStamp: string): string {
 const canonical = `${BASE_URL}/guides/${guide.filename}/`;
 const pdfUrl = `${BASE_URL}/guides/${guide.filename}.pdf`;
 const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

 const jsonLd = JSON.stringify({
 '@context': 'https://schema.org',
 '@type': 'DigitalDocument',
 name: guide.title,
 description: guide.subtitle,
 url: canonical,
 encodingFormat: 'application/pdf',
 encoding: { '@type': 'MediaObject', contentUrl: pdfUrl, encodingFormat: 'application/pdf' },
 author: { '@type': 'Organization', name: 'Frontaliere Ticino', url: BASE_URL },
 publisher: { '@type': 'Organization', name: 'Frontaliere Ticino', url: BASE_URL },
 datePublished: dateStamp,
 dateModified: dateStamp,
 inLanguage: 'it',
 isAccessibleForFree: true,
 });

 return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(guide.title)} | Frontaliere Ticino</title>
<meta name="description" content="${esc(guide.subtitle)}">
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(guide.title)}">
<meta property="og:description" content="${esc(guide.subtitle)}">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="Frontaliere Ticino">
<meta property="og:image" content="${BASE_URL}/icons/icon-512x512.png">
<meta property="og:image:width" content="512">
<meta property="og:image:height" content="512">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(guide.title)}">
<meta name="twitter:description" content="${esc(guide.subtitle)}">
<script type="application/ld+json">${jsonLd}</script>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#334155;line-height:1.6}
h1{color:#1e293b;font-size:1.75rem;margin-bottom:0.25rem}
.subtitle{color:#64748b;font-size:1.1rem;margin-bottom:2rem}
.download-box{background:#f0f9ff;border:1px solid #bae6fd;border-radius:12px;padding:1.5rem;text-align:center;margin:2rem 0}
.download-btn{display:inline-block;background:#2563eb;color:#fff;padding:0.75rem 2rem;border-radius:8px;text-decoration:none;font-weight:600;font-size:1.1rem}
.download-btn:hover{background:#1d4ed8}
.meta{color:#64748b;font-size:0.9rem;margin-top:0.5rem}
nav{margin-top:2rem;padding-top:1rem;border-top:1px solid #e2e8f0;font-size:0.9rem;color:#64748b}
nav a{color:#2563eb;text-decoration:none}
</style>
</head>
<body>
<article>
<h1>${esc(guide.title)}</h1>
<p class="subtitle">${esc(guide.subtitle)}</p>
<div class="download-box">
<a class="download-btn" href="${pdfUrl}" download>📥 Scarica PDF (${pdfSizeKb} KB)</a>
<p class="meta">Formato PDF · Gratuito · Aggiornato ${dateStamp}</p>
</div>
<p>${esc(guide.bodyText)}</p>
<p>Questa guida fa parte delle risorse gratuite di <a href="${BASE_URL}/">Frontaliere Ticino</a> per i lavoratori transfrontalieri tra Svizzera e Italia.</p>
<p>Consulta anche l'<a href="${BASE_URL}/articoli-frontaliere/${guide.articleSlug}/">articolo completo online</a> per la versione aggiornata in tempo reale.</p>
</article>
<nav>
<a href="/">Simulatore Fiscale</a> · <a href="/guida-frontaliere/">Guida Frontaliere</a> · <a href="/articoli-frontaliere/">Articoli</a> · <a href="/cerca-lavoro-ticino/">Lavoro Ticino</a>
</nav>
</body>
</html>`;
}

/* ── Sitemap update ─────────────────────────────────────── */

function updateGuidesSitemap(fs: typeof import('node:fs'), rootDir: string, generatedGuides: PdfGuide[], dateStamp: string): void {
 const entries = generatedGuides.map(g => {
 const landingUrl = `${BASE_URL}/guides/${g.filename}/`;
 const pdfUrl = `${BASE_URL}/guides/${g.filename}.pdf`;
 return ` <url>
 <loc>${landingUrl}</loc>
 <lastmod>${dateStamp}</lastmod>
 <changefreq>monthly</changefreq>
 <priority>0.7</priority>
 </url>
 <url>
 <loc>${pdfUrl}</loc>
 <lastmod>${dateStamp}</lastmod>
 <changefreq>monthly</changefreq>
 <priority>0.5</priority>
 </url>`;
 }).join('\n');

 const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
 // Write to both public/ (source) and dist/ (deployed)
 const publicPath = path.join(rootDir, 'public', 'sitemap-guides.xml');
 const distPath = path.join(rootDir, 'dist', 'sitemap-guides.xml');
 fs.writeFileSync(distPath, sitemap, 'utf-8');
 // Also update public/ so the repo stays in sync
 fs.writeFileSync(publicPath, sitemap, 'utf-8');
}

/* ── Vite Plugin ──────────────────────────────────────────── */

export function pdfWhitepapersPlugin(rootDir: string): Plugin {
 return {
 name: 'pdf-whitepapers',
 apply: 'build',
 async closeBundle() {
 const fs = await import('node:fs');
 const outDir = path.join(rootDir, 'dist', 'guides');
 fs.mkdirSync(outDir, { recursive: true });

 const dateStamp = new Date().toISOString().slice(0, 10);
 let generated = 0;
 const generatedGuides: PdfGuide[] = [];

 for (const guide of GUIDES) {
 try {
 const markdown = extractArticleContent(fs, rootDir, guide.articleSlug);
 if (!markdown) {
 console.warn(`[pdf-guides] ⚠ Skipped ${guide.filename}: blog body file not found or empty`);
 continue;
 }

 const pdfBuffer = await generatePdf(guide, markdown);
 const outPath = path.join(outDir, `${guide.filename}.pdf`);
 fs.writeFileSync(outPath, pdfBuffer);

 const sizeKb = (pdfBuffer.length / 1024).toFixed(1);
 console.log(`[pdf-guides] ✓ ${guide.filename}.pdf (${sizeKb} KB)`);

 // Generate HTML landing page
 const landingDir = path.join(rootDir, 'dist', 'guides', guide.filename);
 fs.mkdirSync(landingDir, { recursive: true });
 const landingHtml = generateLandingPage(guide, sizeKb, dateStamp);
 fs.writeFileSync(path.join(landingDir, 'index.html'), landingHtml, 'utf-8');
 console.log(`[pdf-guides] ✓ ${guide.filename}/index.html (landing page)`);

 generated++;
 generatedGuides.push(guide);
 } catch (err) {
 console.warn(`[pdf-guides] ⚠ Failed to generate ${guide.filename}.pdf:`, err);
 }
 }

 // Update sitemap-guides.xml with both landing pages and PDF URLs
 if (generatedGuides.length > 0) {
 updateGuidesSitemap(fs, rootDir, generatedGuides, dateStamp);
 console.log(`[pdf-guides] Updated sitemap-guides.xml (${generatedGuides.length * 2} URLs)`);
 }

 console.log(`[pdf-guides] Generated ${generated} PDF whitepapers + landing pages in dist/guides/`);
 },
 };
}
