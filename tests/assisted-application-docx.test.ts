import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import mammoth from 'mammoth';
import { XMLValidator } from 'fast-xml-parser';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));

const { createZip, entryData, readZip } = await import('../functions/src/lib/zipArchive.js');
const { renderCvDocx, renderLetterDocx } = await import('../functions/src/assistedApplicationDocx.js');
const { cvToSend, paragraphInventory } = await import('../functions/src/assistedApplicationDocxInPlace.js');
const { SECTION_TITLES, buildCvDocument } = await import('../functions/src/assistedApplicationCvDocument.js');
const { sanitizeTailoredCv } = await import('../functions/src/assistedApplicationTailoredCv.js');
const { applicationFileName, applyLetterConventions, letterEnclosures, letterPdfBlocks, sanitizeProfile } = await import('../functions/src/assistedApplicationAiDraftCore.js');

// The candidate's editable Word copy (close-out P8, owner decision 2026-10-03), built from the same
// models as the PDFs. Invented candidates of the study 2026-10-02 (as in pdf-ats.test.ts), plus an
// English first job.
const NBSP = ' ';
const CASES = [
  {
    key: 'apprentice_de', language: 'de', type: 'apprentice', sector: 'it',
    identity: { name: 'Luka Kovačević', email: 'bewerbung-7f3k@frontaliereticino.ch', phone: '+41 79 555 01 23' },
    title: 'Lernende/r Informatiker/in EFZ Applikationsentwicklung',
    profile: {
      dateOfBirth: '14. März 2010', nationality: 'Schweiz / Kroatien', address: { street: 'Musterweg 12', postalCode: '8400', city: 'Winterthur' },
      languages: [{ language: 'Deutsch', level: 'Muttersprache' }, { language: 'Englisch', level: 'B1' }], skills: ['Python', 'Scratch'],
      experience: [
        { role: 'Informatiker EFZ Applikationsentwicklung', employer: 'Muster Informatik AG', location: 'Winterthur', start: '04.2026', end: '04.2026', kind: 'trial_apprenticeship', highlights: ['Kleine Webseite mit HTML & CSS <Grundlagen> gebaut'] },
        { role: 'Zeitungsverträger', employer: 'Regionalzeitung Winterthur', start: '2025', end: 'heute', kind: 'side_job', highlights: ['Jeden Samstag 80 Zeitungen verteilt'] },
      ],
      education: [{ degree: 'Sekundarschule A', institution: 'Schulhaus Rychenberg', start: '2023', end: '2026' }],
      aptitudeTests: [{ name: 'Multicheck ICT', date: 'März 2026', results: `Schulisches Potenzial 78${NBSP}%` }],
      interests: ['Fussball', 'Gitarre'], references: [{ name: 'Herr Peter Muster', role: 'Klassenlehrer', organisation: 'Schulhaus Rychenberg', contact: '+41 52 555 00 00' }],
    },
    contact: 'Frau Sandra Beispiel',
  },
  {
    key: 'nurse_fr', language: 'fr', type: 'qualified', sector: 'health',
    identity: { name: 'Élodie Marchetti', email: 'candidature-2q9x@frontaliereticino.ch', phone: '+33 6 55 55 01 02' },
    title: 'Infirmier/ère diplômé/e', summary: 'Infirmière en médecine interne depuis 2019, référente douleur, diplôme reconnu par la Croix-Rouge suisse (CRS).',
    profile: {
      headline: 'Infirmière', workPermit: 'Permis G (frontalière)', availability: 'Préavis de 2 mois', location: 'Annemasse (F)',
      languages: [{ language: 'Français', level: 'langue maternelle' }, { language: 'Italien', level: 'B2' }],
      experience: [
        { role: 'Infirmière en médecine interne', employer: 'Centre Hospitalier Exemple', location: 'Annecy', start: '09.2019', end: "aujourd'hui", kind: 'job', highlights: ['Prise en charge de 10 à 12 patients par poste', "Référente douleur de l'unité depuis 2022"] },
      ],
      education: [{ degree: "Diplôme d'État d'infirmier", institution: 'IFSI Exemple', start: '2015', end: '2018' }],
      recognitions: [{ title: 'Reconnaissance du diplôme par la Croix-Rouge suisse (CRS)', issuer: 'CRS', date: '2024' }],
    },
    contact: 'Madame Sandra Beispiel',
  },
  {
    key: 'developer_it', language: 'it', type: 'qualified', sector: 'it',
    identity: { name: 'Marco Bianchi', email: 'candidatura-8h2m@frontaliereticino.ch', phone: '+39 333 555 0101' },
    title: 'Sviluppatore full-stack', summary: 'Sviluppatore full-stack con 6 anni di esperienza su applicazioni web in TypeScript, React e Node.js.',
    profile: {
      headline: 'Sviluppatore full-stack', location: 'Como (I)', linkedin: 'linkedin.com/in/marco-bianchi-example', website: 'github.com/marcob-example',
      languages: [{ language: 'Italiano', level: 'madrelingua' }, { language: 'Inglese', level: 'C1' }],
      experience: [
        { role: 'Sviluppatore full-stack', employer: 'Esempio Software Srl', location: 'Milano', start: '03/2021', end: 'oggi', kind: 'job', highlights: ['Portale B2B in React e Node.js usato da 400 clienti', 'Tempo di build ridotto del 40% con Docker multi-stage'] },
      ],
      education: [{ degree: 'Laurea in Informatica', institution: "Università degli Studi dell'Insubria", start: '2016', end: '2019' }],
      projects: [{ name: 'timesheet', url: 'github.com/marcob-example/timesheet', description: 'App open source per fogli ore in TypeScript' }],
    },
    contact: 'Signora Sandra Beispiel',
  },
  {
    key: 'analyst_en', language: 'en', type: 'first_job', sector: 'other',
    identity: { name: 'Anna Müller-Rossi', email: 'application-5k1p@frontaliereticino.ch', phone: '+41 76 555 02 03' },
    title: 'Junior Data Analyst', summary: 'Graduate in economics with two internships in reporting.',
    profile: {
      location: 'Lugano', languages: [{ language: 'English', level: 'C1' }, { language: 'Italian', level: 'native' }],
      experience: [{ role: 'Reporting intern', employer: 'Example Bank SA', location: 'Lugano', start: '2025', end: '2025', kind: 'internship', highlights: ['Weekly KPI report for 3 teams'] }],
      education: [{ degree: 'BSc Economics', institution: 'USI', start: '2022', end: '2025', grade: '5.2/6' }],
      certifications: ['Power BI Data Analyst (PL-300)'],
    },
    contact: '',
  },
];
// The 1st of the month: the ordinal day of the Italian and French letters (P5).
const NOW = new Date(Date.UTC(2026, 9, 1, 9, 0, 0));
const LANGS: Record<string, string> = { de: 'de-CH', fr: 'fr-CH', it: 'it-CH', en: 'en-GB' };

function documentOf(test: any) {
  const profile = sanitizeProfile(test.profile);
  const cv = sanitizeTailoredCv({ headline: test.title, summary: test.summary || '', competencies: [], experience: [], skills: profile.skills }, {
    profile, cvText: JSON.stringify(test.profile), language: test.language, type: test.type, sector: test.sector, title: test.title,
  });
  return { profile, document: buildCvDocument(cv, { identity: test.identity, profile, language: test.language, type: test.type, sector: test.sector }) };
}

function blocksOf(test: any, profile: any) {
  const letter = applyLetterConventions({
    paragraphs: ["erster Absatz mit 81 % & <Team> und CHF 80'000.", 'Zweite Zeile\nim selben Absatz.', 'Dritter Absatz.'],
  }, { language: test.language, contactPerson: test.contact });
  return letterPdfBlocks({
    identity: test.identity, profile, posting: { contactPerson: test.contact, streetAddress: 'Technikumstrasse 9', postalCode: '8400', location: 'Winterthur' },
    companyName: 'Alpina Systems AG', language: test.language, letter, title: test.title, now: NOW,
    enclosures: letterEnclosures(test.language, test.key === 'nurse_fr' ? [] : ['Zeugnisse']), type: test.type,
  });
}

/** The paragraphs the CV prints, in the order and with the separators of templates/assisted-cv.typ. */
function expectedCvTexts(document: any) {
  const out = [document.name];
  if (document.headline) out.push(document.headline);
  if (document.contact.length) out.push(document.contact.join('  ·  '));
  const pair = ([label, value]: [string, string]) => (value ? `${label}: ${value}` : label);
  if (document.personal.length) out.push((document.personalTitle || SECTION_TITLES[document.language].personal).toUpperCase(), ...document.personal.map(pair));
  for (const section of document.sections) {
    out.push(section.title.toUpperCase());
    if (section.text) out.push(section.text);
    out.push(...(section.pairs || []).map(pair), ...(section.list || []));
    for (const item of section.items || []) {
      const head = [item.title, item.org].filter(Boolean).join(', ');
      if (head) out.push(head);
      const meta = [item.date, item.place].filter(Boolean).join(' · ');
      if (meta) out.push(meta);
      if (item.text) out.push(item.text);
      out.push(...(item.bullets || []));
    }
  }
  return out;
}

/** The paragraphs the letter prints (templates/assisted-letter.typ): the enclosure label carries its own colon. */
const expectedLetterTexts = (blocks: any) => [
  ...blocks.senderLines.filter(Boolean), ...blocks.recipientLines.filter(Boolean), blocks.placeDate, blocks.subject, blocks.salutation,
  ...blocks.paragraphs, blocks.closing, blocks.signature,
  blocks.enclosures.length ? [blocks.enclosuresLabel, blocks.enclosures.join(', ')].filter(Boolean).join(' ') : '',
].filter(Boolean);

const partText = (docx: Buffer, name: string) => entryData(readZip(docx).find((entry: any) => entry.name === name), 8 * 1024 * 1024).toString('utf8');
const inventoryOf = (docx: Buffer) => paragraphInventory(partText(docx, 'word/document.xml')).map((paragraph: any) => paragraph.text);
async function rawParagraphs(docx: Buffer) {
  const { value } = await mammoth.extractRawText({ buffer: docx });
  // mammoth ends each paragraph with a blank line.
  return value.split('\n\n').filter((text: string, index: number, all: string[]) => !(index === all.length - 1 && text === ''));
}

const CV_PARTS = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/settings.xml', 'word/numbering.xml'];
const LETTER_PARTS = CV_PARTS.filter((name) => name !== 'word/numbering.xml');

/** Every part a content type or a relationship names is in the package, and every part has its content type. */
function packageProblems(docx: Buffer) {
  const names = new Set(readZip(docx).map((entry: any) => entry.name));
  const problems: string[] = [];
  const types = partText(docx, '[Content_Types].xml');
  const overrides = [...types.matchAll(/<Override PartName="\/([^"]+)"/g)].map((match) => match[1]);
  for (const part of overrides) if (!names.has(part)) problems.push(`override without part: ${part}`);
  for (const name of names) {
    if (name === '[Content_Types].xml' || name.endsWith('.rels')) continue;
    if (!overrides.includes(name)) problems.push(`part without content type: ${name}`);
  }
  for (const [rels, base] of [['_rels/.rels', ''], ['word/_rels/document.xml.rels', 'word/']]) {
    for (const [, target] of partText(docx, rels).matchAll(/Target="([^"]+)"/g)) if (!names.has(`${base}${target}`)) problems.push(`relationship without part: ${target}`);
  }
  return problems;
}

describe('the candidate’s Word copy', () => {
  // Case 1.
  it('writes a new archive with createZip and refuses a duplicate name', () => {
    const zip = createZip([{ name: 'a.txt', data: Buffer.alloc(1000, 65) }, { name: 'empty', data: Buffer.alloc(0) }]);
    const back = readZip(zip);
    expect(back.map((entry: any) => entry.name)).toEqual(['a.txt', 'empty']);
    expect(back.map((entry: any) => [entry.method, entry.date, entry.time])).toEqual([[8, 0x0021, 0], [8, 0x0021, 0]]);
    expect(back[0].compressed.length).toBeLessThan(100);
    expect(entryData(back[0], 10_000)).toEqual(Buffer.alloc(1000, 65));
    expect(entryData(back[1], 10_000).length).toBe(0);
    expect(() => createZip([{ name: 'x', data: Buffer.from('1') }, { name: 'x', data: Buffer.from('2') }])).toThrow(expect.objectContaining({ code: 'duplicate_entry' }));
  });

  // Case 2.
  for (const test of CASES) {
    it(`${test.key}: the CV's parts are well-formed and hold the model's paragraphs in the template's order`, async () => {
      const { document } = documentOf(test);
      const docx = renderCvDocx(document);
      expect(readZip(docx).map((entry: any) => entry.name)).toEqual(CV_PARTS);
      for (const name of CV_PARTS) expect([name, XMLValidator.validate(partText(docx, name))]).toEqual([name, true]);
      expect(packageProblems(docx)).toEqual([]);
      const expected = expectedCvTexts(document);
      expect(inventoryOf(docx)).toEqual(expected);
      expect(await rawParagraphs(docx)).toEqual(expected);
      const styles = partText(docx, 'word/styles.xml');
      expect(styles).toContain(`<w:lang w:val="${LANGS[test.language]}"/>`);
      expect(styles).toContain('w:ascii="Arial"');
      expect(partText(docx, 'word/document.xml')).toMatch(/<w:sectPr><w:pgSz w:w="11906" w:h="16838"\/>.*<\/w:sectPr><\/w:body><\/w:document>$/);
      // Word's own styles: every editor reads the section titles as headings and the bullets as a list.
      const { value: html } = await mammoth.convertToHtml({ buffer: docx });
      expect(html).toContain('<h1>');
      const listed = document.sections.some((section: any) => section.list?.length || (section.items || []).some((item: any) => item.bullets?.length));
      expect(listed).toBe(true);
      expect(html).toContain('<ul><li>');
    });
  }

  // Decision of the close-out (P8 open question 2): Word opens the copy as a current document, not in Compatibility Mode.
  it('declares the compatibility mode of current Word in its own part, related and typed', () => {
    for (const docx of [renderCvDocx(documentOf(CASES[2]).document), renderLetterDocx(blocksOf(CASES[2], documentOf(CASES[2]).profile))]) {
      expect(partText(docx, 'word/settings.xml')).toContain('<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>');
      expect(partText(docx, 'word/_rels/document.xml.rels')).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"');
      expect(partText(docx, '[Content_Types].xml')).toContain('<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>');
    }
  });

  // Case 3.
  for (const test of CASES) {
    it(`${test.key}: the letter holds the blocks the PDF prints, its line breaks and its columns`, async () => {
      const { profile } = documentOf(test);
      const blocks = blocksOf(test, profile);
      const docx = renderLetterDocx(blocks);
      expect(readZip(docx).map((entry: any) => entry.name)).toEqual(LETTER_PARTS);
      for (const name of LETTER_PARTS) expect([name, XMLValidator.validate(partText(docx, name))]).toEqual([name, true]);
      expect(packageProblems(docx)).toEqual([]);
      const expected = expectedLetterTexts(blocks);
      expect(expected.some((text: string) => text.includes('\n'))).toBe(true);
      expect(inventoryOf(docx)).toEqual(expected);
      // mammoth's raw text drops a line break inside a paragraph; its HTML keeps it.
      expect(await rawParagraphs(docx)).toEqual(expected.map((text: string) => text.replace(/\n/g, '')));
      expect((await mammoth.convertToHtml({ buffer: docx })).value).toContain('<br />');
      expect(inventoryOf(docx).join('\n')).toContain(NBSP);
      const styles = partText(docx, 'word/styles.xml');
      // Address, place and date, closing and signature at 117 mm in French and Italian.
      expect(styles.includes('<w:ind w:left="5216"/>')).toBe(test.language === 'fr' || test.language === 'it');
      // A French closing is a sentence at the end of the body (closing ''): 2 + 16 mm above the signature.
      expect(blocks.closing === '').toBe(test.language === 'fr');
      expect(/w:styleId="LetterSignature">.*?<w:spacing w:before="(\d+)"/.exec(styles)?.[1]).toBe(test.language === 'fr' ? '1020' : '907');
    });
  }

  // Case 4.
  it('keeps every character: escaped, a tab as a tab, the protected space, the apostrophe; drops what XML forbids', () => {
    const { document } = documentOf(CASES[0]);
    const text = `Spalte\tzwei & <drei>\u0001 CHF${NBSP}80'000`;
    const docx = renderCvDocx({ ...document, sections: [...document.sections, { kind: 'test', title: 'Test', text }] });
    const xml = partText(docx, 'word/document.xml');
    for (const piece of ['&amp; &lt;drei&gt;', '<w:tab/>', NBSP, "80'000", 'č']) expect(xml).toContain(piece);
    expect(xml).not.toContain('\u0001');
    expect(inventoryOf(docx)).toContain(text.replace('\u0001', ''));
  });

  // Case 5.
  it('writes the elements in the order the schema requires', () => {
    for (const test of CASES) {
      const { document, profile } = documentOf(test);
      for (const docx of [renderCvDocx(document), renderLetterDocx(blocksOf(test, profile))]) {
        const xml = partText(docx, 'word/document.xml');
        const paragraphs = xml.match(/<w:p>.{0,40}/g) || [];
        expect(paragraphs.length).toBeGreaterThan(5);
        for (const start of paragraphs) expect(start.startsWith('<w:p><w:pPr><w:pStyle')).toBe(true);
        for (const [, next] of xml.matchAll(/<w:r>(.{0,9})/g)) expect(['<w:rPr>', '<w:t ', '<w:tab/>', '<w:br/>'].some((child) => next.startsWith(child))).toBe(true);
        for (const [tag] of xml.matchAll(/<w:t[ >][^>]*>/g)) expect(tag).toContain('xml:space="preserve"');
        const styles = partText(docx, 'word/styles.xml');
        expect(styles.indexOf('<w:docDefaults>')).toBeLessThan(styles.indexOf('<w:style '));
      }
    }
  });

  // Case 6.
  it('gives the same bytes for the same document, and never prints a photo', () => {
    const { document } = documentOf(CASES[1]);
    const docx = renderCvDocx(document);
    expect(Buffer.compare(docx, renderCvDocx(document))).toBe(0);
    expect(Buffer.compare(docx, renderCvDocx({ ...document, photo: Buffer.from([1, 2, 3]), photoType: 'png' }))).toBe(0);
    expect(readZip(docx).some((entry: any) => entry.name.startsWith('word/media/'))).toBe(false);
  });

  // Case 7.
  it('names the CV that leaves with one rule: submit.mjs chooseCv, the fill kit and the candidate’s page apply cvToSend', () => {
    const KEY = (name: string) => `assisted-application-uploads/order_DOCX01/${name}`;
    const inplace = { status: 'ready', docxKey: KEY('ai-cv-inplace-r1-1.docx') };
    const draft = (extra: Record<string, unknown> = {}) => ({ tailoredCv: { status: 'ready', pdfKey: KEY('ai-cv-r1-1.pdf'), inplace }, ...extra });
    const original = KEY('1700000000000-abc-cv.pdf');
    const order = { cvStorageKey: original, cvFileCheck: { key: original, verdict: 'ok', detectedType: 'docx' } };
    expect(cvToSend(draft(), { cvChoice: 'inplace' }, order)).toEqual({ cv: 'inplace', key: inplace.docxKey, extension: 'docx' });
    // The candidate's own file fell back (line choices the Cloud Functions could not page-check): the tailored CV leaves.
    expect(cvToSend(draft({ tailoredCv: { status: 'ready', pdfKey: KEY('ai-cv-r1-1.pdf'), inplace: { ...inplace, status: 'fallback' } } }), { cvChoice: 'inplace' }, order))
      .toEqual({ cv: 'tailored', key: KEY('ai-cv-r1-1.pdf'), extension: 'pdf' });
    expect(cvToSend(draft(), {}, order)).toEqual({ cv: 'tailored', key: KEY('ai-cv-r1-1.pdf'), extension: 'pdf' });
    // The original is named by the type of its bytes (the order's check of that very key), as the runner names it.
    expect(cvToSend(draft(), { cvChoice: 'original' }, order)).toEqual({ cv: 'original', key: original, extension: 'docx' });
    // A check of another key, or none: the key's extension; no extension: pdf.
    expect(cvToSend(draft(), { cvChoice: 'original' }, { ...order, cvFileCheck: { key: KEY('old.doc'), detectedType: 'doc' } }).extension).toBe('pdf');
    expect(cvToSend(draft(), { cvChoice: 'original' }, { cvStorageKey: KEY('1-cv.DOC') }).extension).toBe('doc');
    expect(cvToSend(draft(), { cvChoice: 'original' }, { cvStorageKey: KEY('1-curriculum') }).extension).toBe('pdf');
    // No tailored CV past the gate: the original.
    expect(cvToSend({ tailoredCv: { status: 'failed' } }, {}, order)).toMatchObject({ cv: 'original', extension: 'docx' });
  });

  // Case 8.
  it('follows the separators of the Typst templates (a change there must reach the writer)', () => {
    const cvTemplate = readFileSync(new URL('../functions/src/templates/assisted-cv.typ', import.meta.url), 'utf8');
    const letterTemplate = readFileSync(new URL('../functions/src/templates/assisted-letter.typ', import.meta.url), 'utf8');
    for (const separator of ['d.contact.join("  ·  ")', 'meta.join(" · ")', '[, ]', 'upper(title)']) expect(cvTemplate).toContain(separator);
    expect(letterTemplate).toContain('[#d.enclosuresLabel #d.enclosures.join(", ")]');
  });

  // Case 9.
  it('is never read by the send path: no Word copy can be chosen, attached or handed to the fill kit', () => {
    for (const path of ['scripts/assisted-application/lib/submit.mjs', 'scripts/assisted-application/agent.mjs', 'functions/src/assistedApplicationFillKit.js', 'functions/src/assistedApplicationAutomationAdmin.js']) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      expect([path, /assistedApplicationDocx\.js/.test(source)]).toEqual([path, false]);
      expect([path, /['"`](?:letter|cv)\.docx['"`]/.test(source)]).toEqual([path, false]);
    }
  });

  // Case 10.
  it('names a document as it leaves, the Word copy with the same name', () => {
    expect(applicationFileName('cv', { name: 'Élodie Marchetti', extension: 'pdf' })).toBe('CV_Elodie_Marchetti.pdf');
    expect(applicationFileName('letter', { name: 'Luka Kovačević', language: 'de', extension: 'docx' })).toBe('Motivationsschreiben_Luka_Kovacevic.docx');
    expect(applicationFileName('letter', { name: 'Élodie Marchetti', language: 'fr', extension: 'pdf' })).toBe('Lettre_de_motivation_Elodie_Marchetti.pdf');
    expect(applicationFileName('letter', { name: 'Anna Müller-Rossi', language: 'en', extension: 'pdf' })).toBe('Cover_letter_Anna_Muller_Rossi.pdf');
    expect(applicationFileName('letter', { name: 'Marco Bianchi', language: 'xx', extension: 'pdf' })).toBe('Lettera_di_presentazione_Marco_Bianchi.pdf');
  });
});
