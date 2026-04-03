import path from 'path';
import type { Plugin } from 'vite';
import { BASE_URL } from './constants';

interface PdfGuide {
  filename: string;
  title: string;
  subtitle: string;
  articleSlug: string;
}

const GUIDES: PdfGuide[] = [
  {
    filename: 'guida-completa-frontaliere-2026',
    title: 'Guida Completa Frontaliere 2026',
    subtitle: 'Tutto ciò che devi sapere per lavorare in Svizzera dal confine italiano',
    articleSlug: 'guida-completa-frontaliere',
  },
  {
    filename: 'permesso-g-vantaggi-svantaggi',
    title: 'Permesso G: Vantaggi e Svantaggi',
    subtitle: 'Analisi completa del permesso per frontalieri nel 2026',
    articleSlug: 'permesso-g-vantaggi-svantaggi',
  },
  {
    filename: 'lamal-vs-ssn-frontalieri',
    title: 'LAMal vs SSN per Frontalieri',
    subtitle: 'Guida alla scelta dell\'assicurazione sanitaria',
    articleSlug: 'lamal-vs-ssn-decisione',
  },
  {
    filename: 'trovare-lavoro-ticino-frontaliere',
    title: 'Trovare Lavoro in Ticino',
    subtitle: 'Strategie efficaci per frontalieri nel mercato svizzero',
    articleSlug: 'trovare-lavoro-ticino',
  },
];

/* ── Colour palette (decimal RGB for pdfkit) ─────────────── */
/* ── Colour palette (hex strings for pdfkit) ─────────────── */
const COLORS = {
  headerBg: '#1e293b',   // slate-800
  white: '#ffffff',
  body: '#334155',       // slate-700
  heading: '#1e40af',    // blue-800
  link: '#2563eb',       // blue-600
  muted: '#64748b',      // slate-500
  bullet: '#1e40af',     // blue-800
  rule: '#cbd5e1',       // slate-300
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
    .replace(/\*\*([^*]+)\*\*/g, '$1')         // **bold**
    .replace(/\*([^*]+)\*/g, '$1')               // *italic*
    .replace(/`([^`]+)`/g, '$1')                 // `code`
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')     // [text](url)
    .replace(/~~([^~]+)~~/g, '$1')               // ~~strikethrough~~
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
      doc.text(`    ${section.text}`, MARGIN.left + 16, doc.y, {
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

/* ── Vite Plugin ──────────────────────────────────────────── */

export function pdfWhitepapersPlugin(rootDir: string): Plugin {
  return {
    name: 'pdf-whitepapers',
    apply: 'build',
    async closeBundle() {
      const fs = await import('node:fs');
      const outDir = path.join(rootDir, 'dist', 'guides');
      fs.mkdirSync(outDir, { recursive: true });

      let generated = 0;

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
          console.log(`[pdf-guides]   ✓ ${guide.filename}.pdf (${sizeKb} KB)`);
          generated++;
        } catch (err) {
          console.warn(`[pdf-guides] ⚠ Failed to generate ${guide.filename}.pdf:`, err);
        }
      }

      console.log(`[pdf-guides] Generated ${generated} PDF whitepapers in dist/guides/`);
    },
  };
}
