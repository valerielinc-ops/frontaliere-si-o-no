import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PageSizes, rgb } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { cvToSend } from './assistedApplicationDocxInPlace.js';
import { documentFilesOf, photoFilesOf, requiredDocumentsFor } from './assistedApplicationExtraDocuments.js';
import { isAssistedApplicationCvKey } from './assistedApplicationCvCheck.js';

export const POSTAL_PACKET_MAX_SOURCE_BYTES = 48 * 1024 * 1024;
export const POSTAL_PACKET_CONTENT_TYPE = 'application/pdf';
export const POSTAL_PACKET_FILE_NAME = 'dossier-candidatura-cartacea.pdf';

const MARGIN = 46;
const MAX_PAGES = 240;
const A4 = PageSizes.A4;
const PHOTO_WIDTH = 35 * 72 / 25.4;
const PHOTO_HEIGHT = 45 * 72 / 25.4;
const SUPPORTED_TYPES = new Set(['pdf', 'jpg', 'png']);

export class PostalPacketError extends Error {
  constructor(code, status = 409, details = {}) {
    super(code);
    this.name = 'PostalPacketError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const safeText = (value) => String(value ?? '')
  .replace(/\r/g, '')
  .replace(/\u00a0/g, ' ')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
  .trim();

const COPY = {
  it: {
    title: 'Dossier per la candidatura cartacea',
    packetNote: 'Questo unico PDF riunisce le istruzioni postali e i documenti forniti. Le pagine iniziali e gli indici sono solo di servizio: non inserirli nella busta. Stampa e spedisci le pagine dei documenti; ricopia a mano la lettera indicata e non spedire le pagine contrassegnate. Aggiungi gli originali cartacei richiesti dal bando. Le scansioni locali sono unite su questo dispositivo. Le copie stampabili dei PDF firmati sono incluse, ma la firma digitale non viene mantenuta: conserva il file originale e allegalo separatamente se il bando richiede la verifica digitale.',
    job: 'Candidatura', recipient: 'Destinatario', address: 'Indirizzo postale', deadline: 'Scadenza',
    marking: 'Dicitura sulla busta', instructions: 'Istruzioni di spedizione', form: 'Modulo ufficiale',
    checklist: 'Documenti richiesti', included: 'incluso nel PDF', local: 'documento locale; vedere l’indice delle scansioni unite, se presente', manual: 'da aggiungere fisicamente',
    prepared: 'segnato come preparato; aggiungere fisicamente', exempt: 'esente', missing: 'non incluso', signedPrintableShort: 'copia stampabile inclusa; conserva l’originale firmato se serve la verifica digitale',
    files: 'Indice dei documenti digitali - NON SPEDIRE QUESTA PAGINA', includedStatus: 'incluso nel PDF', signedOriginalNote: 'copia stampabile inclusa; conserva e allega separatamente il file originale se il bando richiede la verifica della firma digitale', letterTitle: 'Bozza della lettera manoscritta - NON spedire questa pagina',
    letterNote: 'Ricopia a mano la bozza qui sotto. Completa il termine di disponibilita nella riga dedicata. Inserisci nella busta la lettera scritta a mano, non questa stampa.',
    availability: 'Termine di disponibilita: ______________________________________________',
    noLetter: 'La bozza della lettera non e disponibile. Chiedi assistenza prima di spedire.',
    resident: 'domiciliato/a nel Comune', employee: 'dipendente comunale',
    includedFile: 'allegato digitale', passportPhoto: 'Fotografia formato passaporto - stampa nel riquadro; verifica dimensioni e qualita prima di spedirla.',
    manualNote: 'Controlla nel bando se serve aggiungere anche un originale cartaceo. Le scansioni non sostituiscono gli originali quando sono richiesti.',
    noFiles: 'Nessun documento digitale da allegare a questo dossier.',
  },
  en: {
    title: 'Paper application packet',
    packetNote: 'This single PDF brings together the mailing instructions and the documents provided. The opening pages and indexes are for guidance only: do not put them in the envelope. Print and mail the document pages; copy the indicated letter by hand and do not mail pages marked as instructions. Add any paper originals required by the posting. Local scans are merged on this device. Printable copies of digitally signed PDFs are included, but the digital signatures are not preserved: keep the original file and attach it separately if the posting requires digital verification.',
    job: 'Application', recipient: 'Recipient', address: 'Mailing address', deadline: 'Deadline',
    marking: 'Text for the envelope', instructions: 'Mailing instructions', form: 'Official form',
    checklist: 'Required documents', included: 'included in this PDF', local: 'local document; see the index of merged scans, if included', manual: 'add separately on paper',
    prepared: 'marked prepared; add separately on paper', exempt: 'exempt', missing: 'not included', signedPrintableShort: 'printable copy included; keep the signed original if digital verification is required',
    files: 'Index of digital documents - DO NOT MAIL THIS PAGE', includedStatus: 'included in this PDF', signedOriginalNote: 'printable copy included; keep and attach the original separately if the posting requires digital signature verification', letterTitle: 'Handwritten letter draft - DO NOT MAIL THIS PAGE',
    letterNote: 'Copy the draft below by hand. Complete the availability term on the marked line. Put the handwritten letter in the envelope, not this printout.',
    availability: 'Availability date/term: ______________________________________________',
    noLetter: 'The letter draft is unavailable. Ask for assistance before mailing.',
    resident: 'domiciled in the municipality', employee: 'municipal employee',
    includedFile: 'digital attachment', passportPhoto: 'Passport-size photograph - print in the frame; check its dimensions and quality before mailing.',
    manualNote: 'Check the posting to see whether any paper original must also be added. A scan does not replace an original when one is required.',
    noFiles: 'There are no digital documents to attach to this packet.',
  },
  de: {
    title: 'Unterlagenpaket fuer die Papierbewerbung',
    packetNote: 'Dieses PDF enthaelt Versandhinweise und die bereitgestellten Unterlagen. Die ersten Seiten und Verzeichnisse dienen nur der Orientierung und gehoeren nicht in den Umschlag. Drucke nur die Dokumentseiten aus; schreibe den angegebenen Brief von Hand ab und versende keine als Hinweis markierten Seiten. Fuege verlangte Papieroriginale hinzu. Lokale Scans werden auf diesem Geraet zusammengefuehrt. Druckbare Kopien digital signierter PDFs sind enthalten, die digitale Signatur bleibt jedoch nicht erhalten: Bewahre die Originaldatei auf und lege sie separat bei, falls die Ausschreibung eine digitale Pruefung verlangt.',
    job: 'Bewerbung', recipient: 'Empfaenger', address: 'Postadresse', deadline: 'Frist',
    marking: 'Vermerk auf dem Umschlag', instructions: 'Versandhinweise', form: 'Offizielles Formular',
    checklist: 'Erforderliche Unterlagen', included: 'in diesem PDF enthalten', local: 'lokales Dokument; siehe Verzeichnis der eingefuegten Scans, falls vorhanden', manual: 'auf Papier separat beilegen',
    prepared: 'als vorbereitet markiert; separat beilegen', exempt: 'befreit', missing: 'nicht enthalten', signedPrintableShort: 'druckbare Kopie enthalten; Original bei erforderlicher digitaler Pruefung aufbewahren',
    files: 'Verzeichnis der digitalen Unterlagen - DIESE SEITE NICHT VERSENDEN', includedStatus: 'in diesem PDF enthalten', signedOriginalNote: 'druckbare Kopie enthalten; Original separat aufbewahren und beilegen, falls die Ausschreibung eine digitale Signaturpruefung verlangt', letterTitle: 'Entwurf des handschriftlichen Anschreibens - NICHT VERSENDEN',
    letterNote: 'Schreibe den folgenden Entwurf von Hand ab. Ergaenze die Verfuegbarkeit in der markierten Zeile. Lege den handschriftlichen Brief bei, nicht diesen Ausdruck.',
    availability: 'Verfuegbarkeit ab: ______________________________________________',
    noLetter: 'Der Briefentwurf ist nicht verfuegbar. Bitte vor dem Versand Hilfe anfordern.',
    resident: 'in der Gemeinde wohnhaft', employee: 'Gemeindeangestellte/r',
    includedFile: 'digitale Beilage', passportPhoto: 'Passfoto - im Rahmen ausdrucken; Groesse und Qualitaet vor dem Versand pruefen.',
    manualNote: 'Pruefe in der Ausschreibung, ob Papieroriginale zusaetzlich beigelegt werden muessen. Ein Scan ersetzt kein verlangtes Original.',
    noFiles: 'Diesem Paket sind keine digitalen Unterlagen beigefuegt.',
  },
  fr: {
    title: 'Dossier de candidature papier',
    packetNote: 'Ce PDF unique rassemble les instructions d’envoi et les documents fournis. Les premieres pages et les index servent uniquement de guide : ne les mettez pas dans l’enveloppe. Imprimez et envoyez les pages des documents ; recopiez la lettre indiquee a la main et n’envoyez pas les pages marquees comme instructions. Ajoutez les originaux papier exiges par l’annonce. Les scans locaux sont fusionnes sur cet appareil. Les copies imprimables des PDF signes numeriquement sont incluses, mais la signature numerique n’est pas conservee : gardez le fichier original et joignez-le separement si l’annonce exige une verification numerique.',
    job: 'Candidature', recipient: 'Destinataire', address: 'Adresse postale', deadline: 'Echeance',
    marking: 'Mention sur l’enveloppe', instructions: 'Instructions d’envoi', form: 'Formulaire officiel',
    checklist: 'Documents requis', included: 'inclus dans ce PDF', local: 'document local ; voir la liste des scans fusionnes, le cas echeant', manual: 'a ajouter separement sur papier',
    prepared: 'indique comme prepare ; a ajouter separement', exempt: 'dispense', missing: 'non inclus', signedPrintableShort: 'copie imprimable incluse ; conservez l’original si une verification numerique est requise',
    files: 'Index des documents numeriques - NE PAS ENVOYER CETTE PAGE', includedStatus: 'inclus dans ce PDF', signedOriginalNote: 'copie imprimable incluse ; conservez et joignez separement l’original si l’annonce exige la verification de la signature numerique', letterTitle: 'Projet de lettre manuscrite - NE PAS ENVOYER CETTE PAGE',
    letterNote: 'Recopiez le projet ci-dessous a la main. Completez le delai de disponibilite sur la ligne indiquee. Joignez la lettre manuscrite, pas cette impression.',
    availability: 'Delai de disponibilite : ______________________________________________',
    noLetter: 'Le projet de lettre est indisponible. Demandez de l’aide avant l’envoi.',
    resident: 'domicilie dans la commune', employee: 'employe communal',
    includedFile: 'piece jointe numerique', passportPhoto: 'Photo format passeport - imprimez-la dans le cadre ; verifiez ses dimensions et sa qualite avant l’envoi.',
    manualNote: 'Verifiez dans l’annonce si un original papier doit aussi etre ajoute. Un scan ne remplace pas un original exige.',
    noFiles: 'Aucun document numerique a joindre a ce dossier.',
  },
};

const copyFor = (locale) => COPY[String(locale || '').slice(0, 2).toLowerCase()] || COPY.it;
const extensionOf = (file) => String(file?.detectedType || file?.extension || '').toLowerCase();
const cleanName = (value) => safeText(value).replace(/[\\/:*?"<>|]/g, '_').slice(0, 160) || 'documento';

export function postalPacketChecklistStatus(locale, status) {
  const copy = copyFor(locale);
  return copy[status] || copy.missing;
}

export function postalPacketExemptionLabel(locale, reason) {
  const copy = copyFor(locale);
  return reason === 'municipal_employee' ? copy.employee : copy.resident;
}

const exemptionOf = (document, flow) => {
  const reason = flow?.documents?.[document.id]?.exemption;
  return (document.exemptions || []).includes(reason) ? reason : '';
};

/** Include only materials the candidate must submit; an exempt document must not reappear as an attachment. */
export function postalPacketSources({ order, orderId, flow, draft }) {
  const requested = requiredDocumentsFor(draft, flow);
  const filesForDocument = (document) => document.kind === 'photo'
    ? photoFilesOf(flow, orderId, document) : documentFilesOf(flow, orderId, document.id);
  const selected = cvToSend(draft, flow, order);
  const cvRequirement = requested.find((document) => document.id === 'curriculum_vitae');
  const cv = cvRequirement && exemptionOf(cvRequirement, flow) ? null : {
    key: selected.key,
    type: selected.extension,
    size: selected.cv === 'original'
      ? (order?.cvFileCheck?.key === selected.key ? Number(order.cvFileCheck.size) || 0 : 0)
      : selected.cv === 'tailored' ? Number(draft?.tailoredCv?.size) || 0 : 0,
    name: selected.cv === 'original'
      ? order?.cvFileName || selected.key.split('/').pop() || 'CV'
      : selected.cv === 'inplace' ? 'CV_adattato.docx' : 'CV_adattato.pdf',
  };
  const documents = requested.filter((document) => document.id !== 'curriculum_vitae' && !document.localOnly && !exemptionOf(document, flow)).flatMap((document) => (
    filesForDocument(document).map((file) => ({
      ...file,
      label: document.label,
      documentId: document.id,
      purpose: document.id === 'passport_photo' ? 'passport_photo' : 'document',
    }))
  ));
  // The applicant needs the draft to copy by hand even when the posting
  // explicitly lists a handwritten letter as a required document.
  const letterRequirement = requested.find((document) => document.id === 'handwritten_letter');
  const includeHandwrittenLetter = !letterRequirement || !exemptionOf(letterRequirement, flow);
  const localDocuments = requested
    .filter((document) => document.localOnly && !exemptionOf(document, flow))
    .map(({ id, label, required }) => ({ id, label, required }));
  const missingDocuments = requested
    .filter((document) => document.required && document.id !== 'curriculum_vitae' && !document.localOnly
      && document.delivery !== 'service' && !exemptionOf(document, flow))
    .filter((document) => filesForDocument(document).length === 0)
    .map((document) => document.label);
  if (cvRequirement?.required && !exemptionOf(cvRequirement, flow) && !cv?.key) missingDocuments.unshift(cvRequirement.label);
  return { cv, documents, includeHandwrittenLetter, localDocuments, missingDocuments };
}

/** Preflight format and actual stored source sizes before approving a postal packet. */
export function postalPacketReadiness({ order, orderId, flow, draft }) {
  const { cv, documents, localDocuments, missingDocuments } = postalPacketSources({ order, orderId, flow, draft });
  const unsupportedFiles = [];
  if (cv && (!cv.key || !isAssistedApplicationCvKey(orderId, cv.key))) {
    unsupportedFiles.push('CV');
  } else if (cv && !SUPPORTED_TYPES.has(String(cv.type || '').toLowerCase())) {
    unsupportedFiles.push('CV');
  }
  for (const file of documents) {
    if (!SUPPORTED_TYPES.has(extensionOf(file))) unsupportedFiles.push(cleanName(file.name));
  }
  const sourceSizes = [...(cv ? [cv.size] : []), ...documents.map((file) => Number(file.size) || 0)];
  const missingSizes = sourceSizes.some((size) => !Number.isSafeInteger(size) || size <= 0);
  const sourceBytes = sourceSizes.reduce((sum, size) => sum + (Number.isSafeInteger(size) && size > 0 ? size : 0), 0);
  const tooLarge = sourceBytes > POSTAL_PACKET_MAX_SOURCE_BYTES;
  return {
    ready: unsupportedFiles.length === 0 && missingDocuments.length === 0 && !missingSizes && !tooLarge,
    unsupportedFiles: [...new Set(unsupportedFiles)].slice(0, 12),
    missingDocuments: [...new Set(missingDocuments)].slice(0, 16),
    localDocuments,
    missingSizes,
    tooLarge,
    sourceBytes,
    maxBytes: POSTAL_PACKET_MAX_SOURCE_BYTES,
  };
}

function wrap(text, font, size, width) {
  const lines = [];
  for (const paragraph of String(text || '').split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      for (const char of word) {
        const next = line + char;
        if (line && font.widthOfTextAtSize(next, size) > width) {
          lines.push(line);
          line = char;
        } else line = next;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

class PacketWriter {
  constructor(pdf, regular, bold, continuationTitle) {
    this.pdf = pdf;
    this.regular = regular;
    this.bold = bold;
    this.continuationTitle = continuationTitle;
    this.page = null;
    this.y = 0;
    this.newPage();
  }

  newPage(title = this.continuationTitle) {
    if (this.pdf.getPageCount() >= MAX_PAGES) throw new PostalPacketError('postal_packet_too_many_pages', 413);
    this.page = this.pdf.addPage(A4);
    this.y = A4[1] - MARGIN;
    if (title) {
      this.line(safeText(title), { size: 14, bold: true, gapAfter: 18, checkSpace: false });
      this.y -= 2;
    }
  }

  line(raw, { size = 10.5, bold = false, indent = 0, gapAfter = 0, checkSpace = true } = {}) {
    const text = safeText(raw);
    const font = bold ? this.bold : this.regular;
    const width = A4[0] - MARGIN * 2 - indent;
    const lines = wrap(text, font, size, width);
    const lineHeight = size * 1.42;
    for (const part of lines) {
      if (checkSpace && this.y < MARGIN + lineHeight) this.newPage();
      if (part) this.page.drawText(part, { x: MARGIN + indent, y: this.y, size, font, color: rgb(0.12, 0.14, 0.17) });
      this.y -= lineHeight;
    }
    this.y -= gapAfter;
  }

  section(title) {
    this.y -= 4;
    this.line(title, { size: 11.5, bold: true, gapAfter: 4 });
  }

  field(label, value) {
    this.line(label, { size: 9, bold: true, gapAfter: 1 });
    this.line(value || '-', { size: 10.5, indent: 8, gapAfter: 7 });
  }
}

function addImagePage(pdf, image, { photo = false } = {}) {
  if (pdf.getPageCount() >= MAX_PAGES) throw new PostalPacketError('postal_packet_too_many_pages', 413);
  const page = pdf.addPage(A4);
  if (photo) {
    const boxX = (A4[0] - PHOTO_WIDTH) / 2;
    const boxY = (A4[1] - PHOTO_HEIGHT) / 2;
    page.drawRectangle({ x: boxX, y: boxY, width: PHOTO_WIDTH, height: PHOTO_HEIGHT, borderColor: rgb(0.35, 0.38, 0.42), borderWidth: 0.6 });
    const scale = Math.min(PHOTO_WIDTH / image.width, PHOTO_HEIGHT / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawImage(image, { x: boxX + (PHOTO_WIDTH - width) / 2, y: boxY + (PHOTO_HEIGHT - height) / 2, width, height });
    return;
  }
  const maxWidth = A4[0] - MARGIN * 2;
  const maxHeight = A4[1] - MARGIN * 2;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  page.drawImage(image, { x: (A4[0] - width) / 2, y: (A4[1] - height) / 2, width, height });
}

function hasDigitalSignature(buffer) {
  const text = buffer.toString('latin1');
  return /\/SigFlags\b/.test(text) || (/\/ByteRange\s*\[/.test(text) && /\/Contents\s*</.test(text));
}

async function appendFile(pdf, file, regularFontBytes) {
  const type = String(file.type || '').toLowerCase();
  if (type === 'pdf') {
    let source;
    try {
      source = await PDFDocument.load(file.buffer, { updateMetadata: false });
    } catch {
      throw new PostalPacketError('postal_packet_pdf_unreadable', 422, { fileName: cleanName(file.name) });
    }
    const form = source.getForm();
    if (form.hasXFA()) throw new PostalPacketError('postal_packet_pdf_unreadable', 422, { fileName: cleanName(file.name) });
    if (form.getFields().length) {
      source.registerFontkit(fontkit);
      const appearanceFont = await source.embedFont(regularFontBytes, { subset: true });
      form.updateFieldAppearances(appearanceFont);
      // A signed source may have a signature widget without an appearance
      // stream, which pdf-lib cannot flatten. Keep updated field appearances
      // in the copied pages and leave the untouched original available.
      if (!hasDigitalSignature(file.buffer)) {
        form.flatten({ updateFieldAppearances: false });
      }
    }
    if (pdf.getPageCount() + source.getPageCount() > MAX_PAGES) throw new PostalPacketError('postal_packet_too_many_pages', 413);
    const pages = await pdf.copyPages(source, source.getPageIndices());
    pages.forEach((page) => pdf.addPage(page));
    return;
  }
  if (type === 'jpg' || type === 'png') {
    let image;
    try {
      image = type === 'jpg' ? await pdf.embedJpg(file.buffer) : await pdf.embedPng(file.buffer);
    } catch {
      throw new PostalPacketError('postal_packet_image_unreadable', 422, { fileName: cleanName(file.name) });
    }
    addImagePage(pdf, image, { photo: file.purpose === 'passport_photo' });
    return;
  }
  throw new PostalPacketError('postal_packet_unsupported_file', 422, { fileName: cleanName(file.name) });
}

/** Build a short cover/checklist, handwriting draft, selected CV and uploaded scans as one PDF. */
export async function buildPostalApplicationPacket({ locale, jobTitle, companyName, postalSubmission, coverLetterText, includeHandwrittenLetter = true, checklist, files }) {
  if (!postalSubmission?.recipient || !postalSubmission?.address || !postalSubmission?.deadline || !postalSubmission?.envelopeMarking || !postalSubmission?.instructions) {
    throw new PostalPacketError('postal_submission_incomplete', 409);
  }
  const unsupported = (files || []).filter((file) => !SUPPORTED_TYPES.has(String(file.type || '').toLowerCase()));
  if (unsupported.length) throw new PostalPacketError('postal_packet_unsupported_file', 422, { files: unsupported.slice(0, 12).map((file) => cleanName(file.name)) });
  const totalBytes = (files || []).reduce((sum, file) => sum + (Buffer.isBuffer(file.buffer) ? file.buffer.length : 0), 0);
  if (totalBytes > POSTAL_PACKET_MAX_SOURCE_BYTES) throw new PostalPacketError('postal_packet_too_large', 413);
  const signedPdfFiles = new Set((files || []).filter((file) => file.type === 'pdf' && hasDigitalSignature(file.buffer)));
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle('Paper application packet');
  pdf.setSubject(safeText(jobTitle || 'Paper application'));
  pdf.setCreator('frontaliereticino.ch');
  const [regularBytes, boldBytes] = await Promise.all([
    readFile(new URL('../assets/fonts/SourceSans3-Regular.ttf', import.meta.url)),
    readFile(new URL('../assets/fonts/SourceSans3-Bold.ttf', import.meta.url)),
  ]);
  const regular = await pdf.embedFont(regularBytes, { subset: true });
  const bold = await pdf.embedFont(boldBytes, { subset: true });
  const copy = copyFor(locale);
  const writer = new PacketWriter(pdf, regular, bold, copy.title);
  writer.line(copy.packetNote, { size: 10.5, gapAfter: 14 });
  writer.section(copy.job);
  writer.line(`${jobTitle || '-'}${companyName ? ` - ${companyName}` : ''}`, { size: 11, bold: true, gapAfter: 10 });
  writer.field(copy.recipient, postalSubmission.recipient);
  writer.field(copy.address, postalSubmission.address);
  writer.field(copy.deadline, postalSubmission.deadline);
  writer.field(copy.marking, postalSubmission.envelopeMarking);
  writer.field(copy.instructions, postalSubmission.instructions);
  if (postalSubmission.officialFormUrl) writer.field(copy.form, postalSubmission.officialFormUrl);
  writer.section(copy.checklist);
  const signedDocumentIds = new Set([...signedPdfFiles].map((file) => file.documentId).filter(Boolean));
  for (const item of checklist || []) {
    const status = signedDocumentIds.has(item.documentId) ? `${item.status}; ${copy.signedPrintableShort}` : item.status;
    writer.line(`${item.label}: ${status}`, { size: 10, bold: true, gapAfter: 1 });
    if (item.instructions) writer.line(item.instructions, { size: 9.5, indent: 8, gapAfter: 4 });
  }
  writer.line(copy.manualNote, { size: 9, gapAfter: 4 });

  if (includeHandwrittenLetter) {
    writer.newPage(copy.letterTitle);
    writer.line(copy.letterNote, { size: 9.5, gapAfter: 12 });
    writer.line(coverLetterText || copy.noLetter, { size: 10.5, gapAfter: 12 });
    writer.line(copy.availability, { size: 10.5, bold: true, gapAfter: 8 });
  }

  writer.newPage(copy.files);
  for (const file of files || []) {
    const status = signedPdfFiles.has(file) ? copy.signedOriginalNote : copy.includedStatus;
    writer.line(`${file.label || copy.includedFile}: ${cleanName(file.name)} - ${status}`, { size: 10, gapAfter: 2 });
  }
  if (!files?.length) writer.line(copy.noFiles, { size: 10 });

  for (const file of files || []) await appendFile(pdf, file, regularBytes);
  const bytes = await pdf.save({ useObjectStreams: true });
  return Buffer.from(bytes);
}

export { SUPPORTED_TYPES as POSTAL_PACKET_SUPPORTED_TYPES };
