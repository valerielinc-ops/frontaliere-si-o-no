/**
 * The candidate's editable Word copy of the letter and of the tailored CV
 * (owner decision 2026-10-03): built on demand from the same document models
 * the PDFs are built from (buildCvDocument's result, letterPdfBlocks'
 * result), never stored, never a CV choice, never read by the send path. The
 * PDF stays the file that leaves; this copy is the candidate's to keep and
 * edit.
 *
 * Written by hand, no dependency: the parts Word needs and nothing else.
 * Formatting lives in styles.xml (and the bullet in numbering.xml);
 * document.xml holds paragraphs with a style reference, runs and text, in the
 * child order the schema requires (pPr before the runs, rPr before the text,
 * sectPr last in the body). settings.xml holds only the compatibility mode of
 * Word 2013 and later (15), so that Word does not open the copy in
 * Compatibility Mode. The name, the section titles and the bullets use
 * Word's own styles (Title, heading 1, List Bullet), so every editor shows
 * them as such. Arial, because the PDFs' Source Sans 3 is embedded in the PDF
 * only; A4, one column; w:lang from the document's language. No photo: the
 * review page says so. Content, order and separators follow the Typst
 * templates (templates/assisted-cv.typ, templates/assisted-letter.typ).
 *
 * Checked by tests (well-formed parts, the model's paragraphs read back by
 * mammoth) and by hand with LibreOffice; no test can prove Word opens it.
 */

import { createZip } from './lib/zipArchive.js';
import { escapeXmlText } from './assistedApplicationDocxInPlace.js';
import { SECTION_TITLES } from './assistedApplicationCvDocument.js';

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const LANG = { de: 'de-CH', fr: 'fr-CH', it: 'it-CH', en: 'en-GB' };
const ACCENT = '1F3A5F';
// Twips (1/20 pt) per millimetre.
const mm = (value) => Math.round(value * 56.6929);
const filled = (value) => String(value ?? '').trim() !== '';

// The compatibility mode Word 2013 and later write: the copy opens as a current document.
const SETTINGS = `${HEAD}<w:settings xmlns:w="${W}"><w:compat>`
  + '<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>'
  + '</w:compat></w:settings>';

/** A run's text: a tab and a line break as Word writes them, every piece escaped, spaces kept. */
function runContent(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
    .map((line) => line.split('\t').map((piece) => (piece ? `<w:t xml:space="preserve">${escapeXmlText(piece)}</w:t>` : '')).join('<w:tab/>'))
    .join('<w:br/>');
}

function run(text, characterStyle = '') {
  const content = runContent(text);
  return content ? `<w:r>${characterStyle ? `<w:rPr><w:rStyle w:val="${characterStyle}"/></w:rPr>` : ''}${content}</w:r>` : '';
}

const paragraph = (style, runs) => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${runs}</w:p>`;

// Child order of w:style: name, basedOn, next, qFormat, pPr, rPr. builtIn: Word's own style (Title,
// heading 1, List Bullet), as every editor knows it; the others are this file's.
function style({ id, name, type = 'paragraph', basedOn = 'Normal', next = '', pPr = '', rPr = '', isDefault = false, builtIn = false }) {
  return `<w:style w:type="${type}"${isDefault ? ' w:default="1"' : builtIn ? '' : ' w:customStyle="1"'} w:styleId="${id}"><w:name w:val="${name}"/>`
    + `${basedOn && !isDefault ? `<w:basedOn w:val="${basedOn}"/>` : ''}${next ? `<w:next w:val="${next}"/>` : ''}${isDefault || builtIn ? '<w:qFormat/>' : ''}`
    + `${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}</w:style>`;
}

function stylesXml({ language, size, normal, styles }) {
  return `${HEAD}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr>`
    + '<w:rFonts w:ascii="Arial" w:eastAsia="Arial" w:hAnsi="Arial" w:cs="Arial"/>'
    + `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:lang w:val="${LANG[language] || LANG.it}"/>`
    + '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + style({ id: 'Normal', name: 'Normal', isDefault: true, pPr: normal })
    + styles.map(style).join('')
    + '</w:styles>';
}

function documentXml(paragraphs, margins) {
  return `${HEAD}<w:document xmlns:w="${W}"><w:body>${paragraphs.length ? paragraphs.join('') : '<w:p/>'}`
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    + `<w:pgMar w:top="${margins.top}" w:right="${margins.right}" w:bottom="${margins.bottom}" w:left="${margins.left}" w:header="567" w:footer="567" w:gutter="0"/>`
    + '<w:cols w:space="708"/></w:sectPr></w:body></w:document>';
}

function packageOf({ document, styles, numbering = '' }) {
  const parts = [
    ['[Content_Types].xml', `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
      + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
      + (numbering ? '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' : '')
      + '</Types>'],
    ['_rels/.rels', `${HEAD}<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${OFFICE_RELS}/officeDocument" Target="word/document.xml"/></Relationships>`],
    ['word/document.xml', document],
    ['word/_rels/document.xml.rels', `${HEAD}<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${OFFICE_RELS}/styles" Target="styles.xml"/>`
      + `<Relationship Id="rId2" Type="${OFFICE_RELS}/settings" Target="settings.xml"/>`
      + (numbering ? `<Relationship Id="rId3" Type="${OFFICE_RELS}/numbering" Target="numbering.xml"/>` : '')
      + '</Relationships>'],
    ['word/styles.xml', styles],
    ['word/settings.xml', SETTINGS],
    ...(numbering ? [['word/numbering.xml', numbering]] : []),
  ];
  return createZip(parts.map(([name, text]) => ({ name, data: Buffer.from(text, 'utf8') })));
}

// ── CV ────────────────────────────────────────────────────────────────────

const CV_STYLES = [
  { id: 'Title', name: 'Title', builtIn: true, next: 'Normal', pPr: '<w:spacing w:after="0"/>', rPr: `<w:b/><w:bCs/><w:color w:val="${ACCENT}"/><w:sz w:val="42"/><w:szCs w:val="42"/>` },
  { id: 'CvHeadline', name: 'CV Headline', next: 'Normal', pPr: '<w:spacing w:before="20" w:after="0"/>', rPr: '<w:sz w:val="22"/><w:szCs w:val="22"/>' },
  { id: 'CvContact', name: 'CV Contact', next: 'Normal', pPr: '<w:spacing w:before="60" w:after="0"/>', rPr: '<w:sz w:val="19"/><w:szCs w:val="19"/>' },
  // The section title in capitals in the text (as the Typst template and cvDocumentBlocks print it), a rule under it.
  { id: 'Heading1', name: 'heading 1', builtIn: true, next: 'Normal', pPr: `<w:keepNext/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="${ACCENT}"/></w:pBdr><w:spacing w:before="220" w:after="100"/><w:outlineLvl w:val="0"/>`, rPr: `<w:b/><w:bCs/><w:color w:val="${ACCENT}"/><w:spacing w:val="8"/><w:sz w:val="21"/><w:szCs w:val="21"/>` },
  { id: 'CvPair', name: 'CV Detail', pPr: '<w:spacing w:before="40" w:after="0"/>' },
  { id: 'CvEntry', name: 'CV Entry', next: 'CvMeta', pPr: '<w:keepNext/><w:spacing w:before="160" w:after="0"/>' },
  // The dates on a line under the role, never a date column.
  { id: 'CvMeta', name: 'CV Dates', next: 'CvText', pPr: '<w:keepNext/><w:spacing w:after="0"/>', rPr: '<w:color w:val="464646"/><w:sz w:val="19"/><w:szCs w:val="19"/>' },
  { id: 'CvText', name: 'CV Text', pPr: '<w:spacing w:after="40"/>' },
  // A real list (numbering.xml): Enter continues it in every editor, the text holds no bullet character.
  { id: 'ListBullet', name: 'List Bullet', builtIn: true, pPr: '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="40"/>' },
  { id: 'CvStrong', name: 'CV Strong', type: 'character', basedOn: '', rPr: '<w:b/><w:bCs/>' },
];

const CV_NUMBERING = `${HEAD}<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>`
  + '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:pStyle w:val="ListBullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/>'
  + `<w:pPr><w:ind w:left="${mm(5)}" w:hanging="${mm(5)}"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/></w:rPr></w:lvl>`
  + '</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';

function cvParagraphs(document) {
  const out = [];
  const add = (styleId, runs) => { if (runs) out.push(paragraph(styleId, runs)); };
  const heading = (title) => add('Heading1', run(String(title || '').toUpperCase()));
  // "Label: value" on one line, the label bold.
  const pair = ([label, value]) => add('CvPair', `${run(label, 'CvStrong')}${filled(value) ? run(`: ${value}`) : ''}`);
  add('Title', run(document.name));
  if (filled(document.headline)) add('CvHeadline', run(document.headline));
  if ((document.contact || []).length) add('CvContact', run(document.contact.join('  ·  ')));
  if ((document.personal || []).length) {
    heading(document.personalTitle || (SECTION_TITLES[document.language] || SECTION_TITLES.it).personal);
    document.personal.forEach(pair);
  }
  for (const section of document.sections || []) {
    heading(section.title);
    if (filled(section.text)) add('CvText', run(section.text));
    (section.pairs || []).forEach(pair);
    for (const item of section.list || []) if (filled(item)) add('ListBullet', run(item));
    for (const item of section.items || []) {
      const title = filled(item.title) ? item.title : '';
      const org = filled(item.org) ? item.org : '';
      if (title || org) add('CvEntry', `${run(title, 'CvStrong')}${run(title && org ? `, ${org}` : org)}`);
      const meta = [item.date, item.place].filter(filled).join(' · ');
      if (meta) add('CvMeta', run(meta));
      if (filled(item.text)) add('CvText', run(item.text));
      for (const bullet of item.bullets || []) if (filled(bullet)) add('ListBullet', run(bullet));
    }
  }
  return out;
}

/**
 * @param {object} document buildCvDocument's result (a `photo` on it is not printed)
 * @returns {Buffer} the .docx
 */
export function renderCvDocx(document) {
  return packageOf({
    // assisted-cv.typ: margin x 2 cm, top 1.8 cm, bottom 1.6 cm.
    document: documentXml(cvParagraphs(document), { top: mm(18), right: mm(20), bottom: mm(16), left: mm(20) }),
    styles: stylesXml({ language: document.language, size: 20, normal: '<w:spacing w:after="60" w:line="252" w:lineRule="auto"/>', styles: CV_STYLES }),
    numbering: CV_NUMBERING,
  });
}

// ── Letter ────────────────────────────────────────────────────────────────

// Exact line heights, so the address lands where assisted-letter.typ puts it.
const SENDER_NAME_LINE = 300;
const LINE = 280;

function letterStyles(language, senderCount, recipientCount, closing) {
  // Address, place and date, closing and signature at 117 mm in French and Italian, on the left in German and English.
  const column = language === 'fr' || language === 'it' ? `<w:ind w:left="${mm(117 - 25)}"/>` : '';
  const senderHeight = senderCount ? SENDER_NAME_LINE + (senderCount - 1) * LINE : 0;
  // The sender block is 31 mm high, then 6 mm: the address 52 mm from the top edge; place and date 32 mm below.
  const recipientBefore = Math.max(0, mm(37) - senderHeight);
  const dateBefore = recipientCount ? Math.max(0, mm(32) - recipientCount * LINE) : recipientBefore + mm(32);
  return [
    { id: 'LetterSenderName', name: 'Letter Sender Name', pPr: `<w:spacing w:after="0" w:line="${SENDER_NAME_LINE}" w:lineRule="exact"/>`, rPr: '<w:b/><w:bCs/><w:sz w:val="24"/><w:szCs w:val="24"/>' },
    { id: 'LetterSender', name: 'Letter Sender', pPr: `<w:spacing w:after="0" w:line="${LINE}" w:lineRule="exact"/>` },
    { id: 'LetterRecipient', name: 'Letter Recipient', pPr: `<w:spacing w:after="0" w:line="${LINE}" w:lineRule="exact"/>${column}` },
    { id: 'LetterRecipientFirst', name: 'Letter Recipient First Line', basedOn: 'LetterRecipient', next: 'LetterRecipient', pPr: `<w:spacing w:before="${recipientBefore}" w:after="0" w:line="${LINE}" w:lineRule="exact"/>` },
    { id: 'LetterDate', name: 'Letter Place and Date', pPr: `<w:spacing w:before="${dateBefore}" w:after="0"/>${column}` },
    { id: 'LetterSubject', name: 'Letter Subject', pPr: `<w:spacing w:before="${mm(9)}" w:after="${mm(5)}"/>`, rPr: '<w:b/><w:bCs/>' },
    { id: 'LetterSalutation', name: 'Letter Salutation', next: 'LetterBody', pPr: '<w:spacing w:after="230"/>' },
    { id: 'LetterBody', name: 'Letter Body', pPr: '<w:spacing w:after="230"/>' },
    { id: 'LetterClosing', name: 'Letter Closing', pPr: `<w:spacing w:before="${mm(2)}" w:after="0"/>${column}` },
    // assisted-letter.typ: v(2mm), the closing when there is one, v(16mm), the signature (room to sign by hand).
    { id: 'LetterSignature', name: 'Letter Signature', pPr: `<w:spacing w:before="${mm(closing ? 16 : 18)}" w:after="0"/>${column}` },
    { id: 'LetterEnclosures', name: 'Letter Enclosures', pPr: `<w:spacing w:before="${mm(8)}" w:after="0"/>`, rPr: '<w:sz w:val="20"/><w:szCs w:val="20"/>' },
  ];
}

/**
 * @param {object} blocks letterPdfBlocks' result
 * @returns {Buffer} the .docx
 */
export function renderLetterDocx(blocks) {
  const sender = (blocks.senderLines || []).filter(filled);
  const recipient = (blocks.recipientLines || []).filter(filled);
  const out = [];
  const add = (styleId, text) => { if (filled(text)) out.push(paragraph(styleId, run(text))); };
  sender.forEach((line, index) => add(index ? 'LetterSender' : 'LetterSenderName', line));
  recipient.forEach((line, index) => add(index ? 'LetterRecipient' : 'LetterRecipientFirst', line));
  add('LetterDate', blocks.placeDate);
  add('LetterSubject', blocks.subject);
  add('LetterSalutation', blocks.salutation);
  for (const text of blocks.paragraphs || []) add('LetterBody', text);
  add('LetterClosing', blocks.closing);
  add('LetterSignature', blocks.signature);
  const enclosures = (blocks.enclosures || []).filter(filled);
  // assisted-letter.typ: the label carries its own colon («Allegato:», «Annexes :»).
  if (enclosures.length) add('LetterEnclosures', [blocks.enclosuresLabel, enclosures.join(', ')].filter(filled).join(' '));
  return packageOf({
    // assisted-letter.typ: left 25 mm, right 20 mm, top 15 mm, bottom 18 mm.
    document: documentXml(out, { top: mm(15), right: mm(20), bottom: mm(18), left: mm(25) }),
    styles: stylesXml({ language: blocks.language, size: 22, normal: '<w:spacing w:after="0" w:line="264" w:lineRule="auto"/>', styles: letterStyles(blocks.language, sender.length, recipient.length, filled(blocks.closing)) }),
  });
}
