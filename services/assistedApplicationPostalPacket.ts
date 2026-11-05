import { PDFDocument, PageSizes, StandardFonts, rgb } from 'pdf-lib';

export interface LocalPostalDocument {
  id: string;
  label: string;
  files: File[];
}

export class LocalPostalPacketError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.name = 'LocalPostalPacketError';
    this.code = code;
  }
}

const A4 = PageSizes.A4;
const MAX_PACKET_PAGES = 240;
const PAGE_MARGIN = 46;
const PASSPORT_WIDTH = (35 * 72) / 25.4;
const PASSPORT_HEIGHT = (45 * 72) / 25.4;
const LOCAL_INDEX_COPY = {
  it: {
    title: 'Indice dei file aggiunti su questo dispositivo - NON SPEDIRE QUESTA PAGINA',
    merged: 'I file elencati qui sotto sono stati uniti a questo PDF direttamente nel browser.',
    signature: 'Le copie stampabili dei PDF firmati sono incluse, ma la firma digitale non viene mantenuta. Conserva l’originale e segui le istruzioni del bando se serve la verifica digitale.',
    signedOriginalNote: 'copia stampabile inclusa; conserva e allega separatamente l’originale se il bando richiede la verifica della firma digitale',
  },
  en: {
    title: 'Index of files added on this device - DO NOT MAIL THIS PAGE',
    merged: 'The files listed below were merged into this PDF locally in your browser.',
    signature: 'Printable copies of digitally signed PDFs are included, but the digital signatures are not preserved. Keep the original and follow the posting if digital verification is required.',
    signedOriginalNote: 'printable copy included; keep and attach the original separately if the posting requires digital signature verification',
  },
  de: {
    title: 'Verzeichnis der Dateien auf diesem Geraet - DIESE SEITE NICHT VERSENDEN',
    merged: 'Die unten aufgefuehrten Dateien wurden lokal im Browser in dieses PDF eingefuegt.',
    signature: 'Druckbare Kopien digital signierter PDFs sind enthalten, die digitale Signatur bleibt jedoch nicht erhalten. Bewahre das Original auf und beachte die Ausschreibung, falls eine digitale Pruefung erforderlich ist.',
    signedOriginalNote: 'druckbare Kopie enthalten; Original separat aufbewahren und beilegen, falls die Ausschreibung eine digitale Signaturpruefung verlangt',
  },
  fr: {
    title: 'Index des fichiers ajoutes sur cet appareil - NE PAS ENVOYER CETTE PAGE',
    merged: 'Les fichiers listes ci-dessous ont ete fusionnes dans ce PDF localement dans votre navigateur.',
    signature: 'Les copies imprimables des PDF signes numeriquement sont incluses, mais la signature numerique n’est pas conservee. Gardez l’original et suivez l’annonce si une verification numerique est requise.',
    signedOriginalNote: 'copie imprimable incluse ; conservez et joignez separement l’original si l’annonce exige la verification de la signature numerique',
  },
} as const;

function typeFromBytes(bytes: Uint8Array): 'pdf' | 'jpg' | 'png' | null {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return 'pdf';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)) return 'png';
  return null;
}

function pdfSafeText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasDigitalSignature(bytes: Uint8Array): boolean {
  const text = new TextDecoder('latin1').decode(bytes);
  return /\/SigFlags\b/.test(text) || (/\/ByteRange\s*\[/.test(text) && /\/Contents\s*</.test(text));
}

function addImagePage(pdf: PDFDocument, image: Awaited<ReturnType<PDFDocument['embedJpg']>>, passportPhoto: boolean) {
  if (pdf.getPageCount() >= MAX_PACKET_PAGES) throw new LocalPostalPacketError('postal_packet_too_many_pages');
  const page = pdf.addPage(A4);
  if (passportPhoto) {
    const x = (A4[0] - PASSPORT_WIDTH) / 2;
    const y = (A4[1] - PASSPORT_HEIGHT) / 2;
    page.drawRectangle({ x: x - 2, y: y - 2, width: PASSPORT_WIDTH + 4, height: PASSPORT_HEIGHT + 4, borderColor: rgb(0.55, 0.58, 0.62), borderWidth: 0.8 });
    const scale = Math.min(PASSPORT_WIDTH / image.width, PASSPORT_HEIGHT / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawImage(image, { x: x + (PASSPORT_WIDTH - width) / 2, y: y + (PASSPORT_HEIGHT - height) / 2, width, height });
    return;
  }
  const scale = Math.min((A4[0] - PAGE_MARGIN * 2) / image.width, (A4[1] - PAGE_MARGIN * 2) / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  page.drawImage(image, { x: (A4[0] - width) / 2, y: (A4[1] - height) / 2, width, height });
}

async function appendLocalFile(pdf: PDFDocument, document: LocalPostalDocument, bytes: Uint8Array, type: 'pdf' | 'jpg' | 'png', signed = false) {
  if (type === 'pdf') {
    let source: PDFDocument;
    try {
      source = await PDFDocument.load(bytes, { updateMetadata: false });
      const form = source.getForm();
      if (form.hasXFA()) throw new Error('xfa');
      if (form.getFields().length) {
        form.updateFieldAppearances();
        if (!signed) {
          form.flatten();
        }
      }
    } catch {
      throw new LocalPostalPacketError('postal_packet_local_pdf_unreadable');
    }
    if (!source.getPageCount() || pdf.getPageCount() + source.getPageCount() > MAX_PACKET_PAGES) {
      throw new LocalPostalPacketError('postal_packet_too_many_pages');
    }
    const pages = await pdf.copyPages(source, source.getPageIndices());
    pages.forEach((page) => pdf.addPage(page));
    return;
  }

  let image;
  try {
    image = type === 'jpg' ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
  } catch {
    throw new LocalPostalPacketError('postal_packet_local_image_unreadable');
  }
  addImagePage(pdf, image, document.id === 'passport_photo');
}

/** Append locally selected documents without transmitting their bytes to the service. */
export async function mergeLocalPostalDocuments({
  basePdf,
  documents,
  sourceBytes,
  maxBytes,
  locale = 'it',
}: {
  basePdf: ArrayBuffer | Uint8Array;
  documents: LocalPostalDocument[];
  sourceBytes: number;
  maxBytes: number;
  locale?: string;
}): Promise<Uint8Array> {
  const selectedFiles = documents.flatMap((document) => document.files.map((file) => ({ document, file })));
  if (!selectedFiles.length) return basePdf instanceof Uint8Array ? basePdf : new Uint8Array(basePdf);
  if (!Number.isFinite(sourceBytes) || !Number.isFinite(maxBytes) || sourceBytes + selectedFiles.reduce((sum, { file }) => sum + file.size, 0) > maxBytes) {
    throw new LocalPostalPacketError('postal_packet_too_large');
  }

  const attachments: Array<{ document: LocalPostalDocument; file: File; bytes: Uint8Array; type: 'pdf' | 'jpg' | 'png'; signed: boolean }> = [];
  for (const { document, file } of selectedFiles) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = typeFromBytes(bytes);
    if (!type) throw new LocalPostalPacketError('postal_packet_unsupported_file');
    const signed = type === 'pdf' && hasDigitalSignature(bytes);
    if (signed) {
      try {
        await PDFDocument.load(bytes, { updateMetadata: false });
      } catch {
        throw new LocalPostalPacketError('postal_packet_local_pdf_unreadable');
      }
    }
    attachments.push({ document, file, bytes, type, signed });
  }

  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(basePdf, { updateMetadata: false });
  } catch {
    throw new LocalPostalPacketError('postal_packet_download_failed');
  }

  if (pdf.getPageCount() >= MAX_PACKET_PAGES) throw new LocalPostalPacketError('postal_packet_too_many_pages');
  const copy = LOCAL_INDEX_COPY[String(locale || '').slice(0, 2).toLowerCase() as keyof typeof LOCAL_INDEX_COPY] || LOCAL_INDEX_COPY.it;
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const addIndexPage = (title: string) => {
    if (pdf.getPageCount() >= MAX_PACKET_PAGES) throw new LocalPostalPacketError('postal_packet_too_many_pages');
    const page = pdf.addPage(A4);
    page.drawText(pdfSafeText(title), { x: PAGE_MARGIN, y: A4[1] - PAGE_MARGIN - 18, size: 15, font: bold, color: rgb(0.12, 0.16, 0.22) });
    return { page, y: A4[1] - PAGE_MARGIN - 48 };
  };
  const drawWrapped = (value: string, options: { x: number; size: number; maxWidth: number; font: typeof regular }) => {
    const { x, size, maxWidth, font } = options;
    let line = '';
    const drawLine = (text: string) => {
      if (y < PAGE_MARGIN + size + 4) ({ page, y } = addIndexPage(copy.title));
      page.drawText(text, { x, y, size, font, color: rgb(0.16, 0.19, 0.25) });
      y -= size + 4;
    };
    for (const word of pdfSafeText(value).split(/\s+/).filter(Boolean)) {
      let remaining = word;
      while (font.widthOfTextAtSize(remaining, size) > maxWidth) {
        let splitAt = 1;
        while (splitAt < remaining.length && font.widthOfTextAtSize(remaining.slice(0, splitAt + 1), size) <= maxWidth) splitAt += 1;
        const piece = remaining.slice(0, splitAt);
        if (line) {
          drawLine(line);
          line = '';
        }
        drawLine(piece);
        remaining = remaining.slice(splitAt);
      }
      const next = line ? `${line} ${remaining}` : remaining;
      if (line && font.widthOfTextAtSize(next, size) > maxWidth) {
        drawLine(line);
        line = remaining;
      } else {
        line = next;
      }
    }
    if (line) drawLine(line);
  };
  let { page, y } = addIndexPage(copy.title);
  drawWrapped(copy.merged, { x: PAGE_MARGIN, size: 9.5, maxWidth: A4[0] - PAGE_MARGIN * 2, font: regular });
  y -= 8;
  for (const document of documents.filter((item) => item.files.length > 0)) {
    const label = pdfSafeText(document.label).slice(0, 100);
    drawWrapped(label, { x: PAGE_MARGIN, size: 10.5, maxWidth: A4[0] - PAGE_MARGIN * 2, font: bold });
    y -= 4;
    for (const attachment of attachments.filter((item) => item.document.id === document.id)) {
      const status = attachment.signed ? ` - ${copy.signedOriginalNote}` : '';
      drawWrapped(`- ${pdfSafeText(attachment.file.name).slice(0, 120)}${pdfSafeText(status)}`, { x: PAGE_MARGIN + 10, size: 9.5, maxWidth: A4[0] - PAGE_MARGIN * 2 - 10, font: regular });
    }
  }
  if (y < PAGE_MARGIN + 30) ({ page, y } = addIndexPage(copy.title));
  drawWrapped(copy.signature, { x: PAGE_MARGIN, size: 8.5, maxWidth: A4[0] - PAGE_MARGIN * 2, font: regular });

  for (const attachment of attachments) await appendLocalFile(pdf, attachment.document, attachment.bytes, attachment.type, attachment.signed);
  return pdf.save({ useObjectStreams: true });
}
