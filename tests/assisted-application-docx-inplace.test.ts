import { beforeEach, describe, expect, it, vi } from 'vitest';
import mammoth from 'mammoth';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { buildInPlaceDocx, cvChoiceOf, docxInPlaceMode, paragraphInventory } = await import('../functions/src/assistedApplicationDocxInPlace.js');
const { crc32, entryData, readZip, writeZip } = await import('../functions/src/lib/zipArchive.js');
const { sanitizeTailoredCv } = await import('../functions/src/assistedApplicationTailoredCv.js');
const { handleAssistedApplicationReview } = await import('../functions/src/assistedApplicationReview.js');
const { mintReviewToken } = await import('../functions/src/assistedApplicationReviewToken.js');
const { inPlaceCvRecord } = await import('../scripts/assisted-application/lib/docx-inplace.mjs');
const { chooseCv } = await import('../scripts/assisted-application/lib/submit.mjs');

// An invented candidate (study 2026-10-02), as in the line-by-line review test.
const CV_TEXT = 'Marco Bianchi\nSviluppatore con 6 anni di esperienza su applicazioni web.\nSviluppatore full-stack, Esempio Software Srl, Milano, 03/2021 – oggi: sviluppo di un portale B2B in React e Node.js usato da 400 clienti; riduzione del tempo di build del 40% con Docker multi-stage; mentoring di 2 sviluppatori junior\nCompetenze: Docker, Node.js, React, SQL';
const profile = {
  fullName: 'Marco Bianchi', email: 'marco.bianchi@example.com', location: 'Como', summary: 'Sviluppatore con 6 anni di esperienza su applicazioni web.',
  languages: [], education: [], certifications: [], skills: ['Docker', 'Node.js', 'React', 'SQL'],
  experience: [{ role: 'Sviluppatore full-stack', employer: 'Esempio Software Srl', location: 'Milano', start: '03/2021', end: 'oggi', kind: 'job', highlights: [
    'Sviluppo di un portale B2B in React e Node.js usato da 400 clienti', 'Riduzione del tempo di build del 40% con Docker multi-stage', 'Mentoring di 2 sviluppatori junior',
  ] }],
};
const raw = {
  headline: 'Sviluppatore full-stack', summary: 'Sviluppatore full-stack con esperienza in React e Node.js.', competencies: ['React'], skills: ['React', 'SQL'],
  experience: [{ index: 0, bullets: [
    { text: 'Portale B2B in React e Node.js usato da 400 clienti', source: 0, requirement: 0 },
    { text: 'Build ridotta del 40% con Docker multi-stage', source: 1, requirement: 1 },
    { text: 'Affiancamento di 2 sviluppatori junior', source: 2, requirement: -1 },
    { text: 'Portale e build per 400 clienti con Docker', source: -1, requirement: -1 },
  ] }],
};
const tailored = () => sanitizeTailoredCv(raw, { profile, cvText: CV_TEXT, language: 'it' });

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (text: string, { style = '', rPr = '', attrs = '' } = {}) => `<w:p${attrs}>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const BODY = [
  p('Marco Bianchi', { style: 'Title' }),
  p('marco.bianchi@example.com · Como'),
  p('Profilo', { style: 'Heading1' }),
  // One paragraph in two runs of the same formatting (Word's rsid splits).
  '<w:p><w:r w:rsidR="00A1"><w:t xml:space="preserve">Sviluppatore con 6 anni </w:t></w:r><w:proofErr w:type="spellStart"/><w:r w:rsidR="00A2"><w:t>di esperienza su applicazioni web.</w:t></w:r></w:p>',
  p('Esperienza', { style: 'Heading1' }),
  '<w:tbl><w:tr><w:tc>',
  p('Sviluppatore full-stack', { rPr: '<w:rPr><w:b/></w:rPr>' }),
  p('Esempio Software Srl, Milano, 03/2021 – oggi'),
  '</w:tc></w:tr></w:tbl>',
  '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:bookmarkStart w:id="0" w:name="_GoBack"/><w:r><w:t>Sviluppo di un portale B2B in React e Node.js usato da 400 clienti</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>',
  // A bullet written by hand, with a tab after it.
  '<w:p><w:r><w:t>•</w:t></w:r><w:r><w:tab/><w:t>Riduzione del tempo di build del 40% con Docker multi-stage</w:t></w:r></w:p>',
  // Inline bold: rewriting it would lose the bold.
  '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Mentoring</w:t></w:r><w:r><w:t xml:space="preserve"> di 2 sviluppatori junior</w:t></w:r></w:p>',
  p('Competenze: Docker, Node.js, React, SQL'),
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>',
].join('');
const documentXml = (body = BODY) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`;
const PICTURE = Buffer.from(Array.from({ length: 600 }, (_, index) => (index * 7) % 251));

function entry(name: string, data: Buffer) {
  return { name, method: 0, flags: 0, time: 0, date: 0x5b42, crc: crc32(data), size: data.length, compressed: data, internalAttributes: 0, externalAttributes: 0 };
}

/** A synthetic DOCX: the parts Word needs, a picture and the document. */
function makeDocx(xml = documentXml(), extra: Array<[string, string]> = []) {
  const parts: Array<[string, Buffer]> = [
    ['[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')],
    ['_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')],
    ['word/document.xml', Buffer.from(xml)],
    ['word/media/image1.png', PICTURE],
    ...extra.map(([name, text]) => [name, Buffer.from(text)] as [string, Buffer]),
  ];
  // The picture deflated, the rest stored: both methods Word writes.
  return writeZip(parts.map(([name, data]) => entry(name, data)), new Map([['word/media/image1.png', PICTURE]]));
}

const documentOf = (docx: Buffer) => entryData(readZip(docx).find((item) => item.name === 'word/document.xml')!, 8 * 1024 * 1024).toString('utf8');
const texts = (docx: Buffer) => paragraphInventory(documentOf(docx)).map((paragraph: any) => paragraph.text);

describe('zip archive', () => {
  it('copies the entries it does not replace byte for byte, and reads sizes from the central directory', () => {
    const docx = makeDocx();
    const before = readZip(docx);
    const after = readZip(writeZip(before, new Map([['word/document.xml', Buffer.from(documentXml(p('Nuovo')))]])));
    expect(after.map((item: any) => item.name)).toEqual(before.map((item: any) => item.name));
    const picture = (entries: any[]) => entries.find((item) => item.name === 'word/media/image1.png');
    expect(Buffer.compare(picture(after).compressed, picture(before).compressed)).toBe(0);
    expect(entryData(picture(after), 1_000_000)).toEqual(PICTURE);
    // A local header with a data descriptor (sizes zero there) is still read.
    const described = Buffer.from(docx);
    described.writeUInt16LE(0x0008, 6);
    described.writeUInt32LE(0, 18);
    expect(readZip(described)[0].size).toBe(before[0].size);
  });

  it('refuses what Word does not write and a wrong checksum', () => {
    expect(() => readZip(Buffer.from('not a zip'))).toThrow('not_a_zip');
    const broken = readZip(makeDocx()).find((item: any) => item.name === 'word/document.xml')!;
    expect(() => entryData({ ...broken, crc: broken.crc ^ 1 }, 1_000_000)).toThrow('bad_crc');
    expect(() => entryData(broken, 10)).toThrow('entry_too_large');
  });
});

describe('in-place DOCX (phase 5)', () => {
  it('writes the adapted lines into the paragraphs they rewrite, and nothing else', async () => {
    const original = makeDocx();
    const result = buildInPlaceDocx(original, tailored(), { profile });
    expect(result.status).toBe('ready');
    expect(result.patched).toEqual(['summary', 'r0-l0', 'r0-l1', 'skills']);
    expect(result.skipped).toEqual([{ id: 'r0-l2', reason: 'mixed_formatting' }, { id: 'r0-l3', reason: 'no_anchor' }]);
    const before = texts(original);
    const after = texts(result.docx);
    expect(after).toEqual([
      before[0], before[1], before[2],
      'Sviluppatore full-stack con esperienza in React e Node.js.',
      before[4], before[5], before[6],
      'Portale B2B in React e Node.js usato da 400 clienti',
      // The hand-written bullet and its tab are kept.
      '•\tBuild ridotta del 40% con Docker multi-stage',
      before[9],
      // Skills only reordered: the posting's first, none added.
      'Competenze: React, SQL, Docker, Node.js',
    ]);
    const xml = documentOf(result.docx);
    // Numbering, bookmark and the role's bold heading untouched.
    expect(xml).toContain('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:bookmarkStart w:id="0" w:name="_GoBack"/>');
    expect(xml).toContain(p('Sviluppatore full-stack', { rPr: '<w:rPr><w:b/></w:rPr>' }));
    expect(xml).toContain(p('Esempio Software Srl, Milano, 03/2021 – oggi'));
    // An independent reader opens the file.
    const { value } = await mammoth.extractRawText({ buffer: result.docx });
    expect(value).toContain('Build ridotta del 40% con Docker multi-stage');
    expect(value).toContain('Esempio Software Srl, Milano, 03/2021 – oggi');
  });

  it('reorders a skills line whose label has its own formatting, the label runs kept as they are', () => {
    const label = '<w:r><w:rPr><w:b/></w:rPr><w:t>Tecniche:</w:t></w:r>';
    const body = BODY.replace(p('Competenze: Docker, Node.js, React, SQL'), `<w:p>${label}<w:r><w:t xml:space="preserve"> Docker, Node.js, React, SQL</w:t></w:r></w:p>`);
    const result = buildInPlaceDocx(makeDocx(documentXml(body)), tailored(), { profile });
    expect(result.patched).toContain('skills');
    expect(texts(result.docx).at(-1)).toBe('Tecniche: React, SQL, Docker, Node.js');
    expect(documentOf(result.docx)).toContain(`<w:p>${label}<w:r><w:t xml:space="preserve"> React, SQL, Docker, Node.js</w:t></w:r></w:p>`);
  });

  it('locks dates, employers, titles, headings and contacts, whatever the anchor says', () => {
    const cv = {
      summary: '', skills: [],
      experience: [{ rewritten: true, lines: [
        { id: 'r0-l0', text: 'Esempio Fintech SA, Lugano, 2019 – 2021', original: 'Esempio Software Srl, Milano, 03/2021 – oggi' },
        { id: 'r0-l1', text: 'Marco Bianchi, ingegnere', original: 'marco.bianchi@example.com · Como' },
      ] }],
    };
    const result = buildInPlaceDocx(makeDocx(), cv, { profile });
    expect(result).toMatchObject({ status: 'ready', patched: [] });
    expect(result.skipped).toEqual([{ id: 'r0-l0', reason: 'date' }, { id: 'r0-l1', reason: 'contact' }]);
  });

  it('follows the candidate’s choices: their CV’s line stays, their own words go in', () => {
    const result = buildInPlaceDocx(makeDocx(), tailored(), {
      profile,
      choices: { summary: { use: 'original' }, 'r0-l0': { use: 'own', text: 'Portale B2B per 400 clienti' }, 'r0-l1': { use: 'original' } },
    });
    const after = texts(result.docx);
    expect(result.patched).toEqual(['r0-l0', 'skills']);
    expect(after[3]).toBe('Sviluppatore con 6 anni di esperienza su applicazioni web.');
    expect(after[7]).toBe('Portale B2B per 400 clienti');
    expect(after[8]).toBe('•\tRiduzione del tempo di build del 40% con Docker multi-stage');
  });

  it('keeps the CV’s line when the new one is too long for its place, and the page within budget', () => {
    const long = buildInPlaceDocx(makeDocx(), tailored(), {
      profile, choices: { 'r0-l0': { use: 'own', text: 'Portale B2B in React e Node.js usato da 400 clienti, con integrazione continua e monitoraggio' } },
    });
    expect(long.skipped).toContainEqual({ id: 'r0-l0', reason: 'too_long' });
    // Six lines of about 100 characters that each grow by 15: the two that grow most give way.
    const names = ['Alfa', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];
    const line = (name: string) => `Coordinamento del progetto ${name} per il reparto vendite, con report mensili alla direzione commerciale`;
    const cv = { summary: '', skills: [], experience: [{ rewritten: true, lines: names.map((name, index) => ({ id: `r0-l${index}`, original: line(name), text: `${line(name)} e ai clienti` })) }] };
    const result = buildInPlaceDocx(makeDocx(documentXml(names.map((name) => p(line(name))).join(''))), cv, { profile: { experience: [] } });
    expect(result.patched).toHaveLength(4);
    expect(result.skipped.filter((item: any) => item.reason === 'page_budget')).toHaveLength(2);
  });

  it('sends the candidate back to the template when the layout cannot be kept', () => {
    const cv = tailored();
    const textBox = BODY.replace('</w:tc>', '<w:p><w:r><w:drawing><wps:txbx><w:txbxContent><w:p><w:r><w:t>Marco</w:t></w:r></w:p></w:txbxContent></wps:txbx></w:drawing></w:r></w:p></w:tc>');
    expect(buildInPlaceDocx(makeDocx(documentXml(textBox)), cv, { profile })).toEqual({ status: 'fallback', reason: 'text_box' });
    const columns = BODY.replace('<w:pgSz', '<w:cols w:num="2" w:space="708"/><w:pgSz');
    expect(buildInPlaceDocx(makeDocx(documentXml(columns)), cv, { profile })).toEqual({ status: 'fallback', reason: 'columns' });
    const tracked = BODY.replace('<w:r><w:t>Sviluppo', '<w:ins w:id="1" w:author="x"><w:r><w:t>Nuovo</w:t></w:r></w:ins><w:r><w:t>Sviluppo');
    expect(buildInPlaceDocx(makeDocx(documentXml(tracked)), cv, { profile })).toEqual({ status: 'fallback', reason: 'tracked_changes' });
    // Table borders named insideH/insideV are not insertions.
    const borders = BODY.replace('<w:tbl>', '<w:tbl><w:tblPr><w:tblBorders><w:insideH w:val="single"/></w:tblBorders></w:tblPr>');
    expect(buildInPlaceDocx(makeDocx(documentXml(borders)), cv, { profile }).status).toBe('ready');
    expect(buildInPlaceDocx(makeDocx(documentXml(), [['word/diagrams/data1.xml', '<dgm:dataModel/>']]), cv, { profile })).toEqual({ status: 'fallback', reason: 'smartart' });
    expect(buildInPlaceDocx(Buffer.from('%PDF-1.7'), cv, { profile })).toEqual({ status: 'fallback', reason: 'unreadable' });
  });

  it('is off unless the switch says on', () => {
    expect(docxInPlaceMode({ env: {} })).toBe('off');
    expect(docxInPlaceMode({ env: { ASSISTED_APPLICATION_DOCX_INPLACE: ' ON ' } })).toBe('on');
    expect(docxInPlaceMode({ env: { ASSISTED_APPLICATION_DOCX_INPLACE: 'yes' } })).toBe('off');
  });
});

function fakeBucket() {
  const files = new Map<string, Buffer>();
  return {
    files,
    file: (key: string) => ({
      save: async (buffer: Buffer) => { files.set(key, Buffer.from(buffer)); },
      download: async () => [files.get(key)],
      delete: async () => { files.delete(key); },
    }),
  };
}

describe('in-place DOCX in the runner', () => {
  const noOffice = vi.fn(async (command: string) => {
    if (command === 'bash' || command === 'sudo') throw new Error('not here');
    throw new Error(`unexpected ${command}`);
  });
  const common = (bucket: ReturnType<typeof fakeBucket>) => ({
    cv: tailored(), profile, identity: { name: 'Marco Bianchi' }, bucket, orderId: 'order_X', round: 1, nowMs: 1, run: noOffice,
  });

  it('is skipped when the switch is off or the CV is a PDF', async () => {
    const bucket = fakeBucket();
    expect(await inPlaceCvRecord({ ...common(bucket), mode: 'off', cvBuffer: makeDocx(), cvType: 'docx', cvKey: 'cv.docx' })).toBeNull();
    expect(await inPlaceCvRecord({ ...common(bucket), mode: 'on', cvBuffer: Buffer.from('%PDF'), cvType: 'pdf', cvKey: 'cv.pdf' })).toBeNull();
  });

  it('installs LibreOffice only when the file can be patched: a layout it cannot keep costs nothing', async () => {
    const run = vi.fn(async () => { throw new Error('not here'); });
    const columns = BODY.replace('<w:pgSz', '<w:cols w:num="2" w:space="708"/><w:pgSz');
    expect(await inPlaceCvRecord({ ...common(fakeBucket()), run, mode: 'on', cvBuffer: makeDocx(documentXml(columns)), cvType: 'docx', cvKey: 'cv.docx' }))
      .toEqual({ status: 'fallback', reason: 'columns', baseType: 'docx' });
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps the page count with the length budget when LibreOffice is not there; a DOC needs it', async () => {
    const bucket = fakeBucket();
    const record = await inPlaceCvRecord({ ...common(bucket), mode: 'on', cvBuffer: makeDocx(), cvType: 'docx', cvKey: 'cv.docx' });
    expect(record).toMatchObject({ status: 'ready', baseKey: 'cv.docx', baseType: 'docx', pageCheck: 'budget', patched: ['summary', 'r0-l0', 'r0-l1', 'skills'] });
    expect(bucket.files.has(record.docxKey)).toBe(true);
    expect(await inPlaceCvRecord({ ...common(bucket), mode: 'on', cvBuffer: Buffer.from('doc'), cvType: 'doc', cvKey: 'cv.doc' }))
      .toEqual({ status: 'fallback', reason: 'doc_needs_libreoffice', baseType: 'doc' });
  });

  it('falls back to the template when LibreOffice counts one more page; one fewer is fine', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const fs = await import('node:fs/promises');
    const pdfWith = async (pages: number) => { const pdf = await PDFDocument.create(); for (let i = 0; i < pages; i += 1) pdf.addPage(); return Buffer.from(await pdf.save()); };
    // LibreOffice that counts `before` pages for the candidate's file, `after` for the patched one.
    const office = (before: number, after: number) => {
      let conversions = 0;
      return vi.fn(async (command: string, args: string[]) => {
        if (command === 'bash') return { stdout: '/usr/bin/soffice' };
        if (command !== 'soffice') throw new Error(`unexpected ${command}`);
        conversions += 1;
        const outdir = args[args.indexOf('--outdir') + 1];
        await fs.writeFile(`${outdir}/cv.pdf`, await pdfWith(conversions === 1 ? before : after));
        return { stdout: '' };
      });
    };
    const grew = fakeBucket();
    expect(await inPlaceCvRecord({ ...common(grew), run: office(1, 2), mode: 'on', cvBuffer: makeDocx(), cvType: 'docx', cvKey: 'cv.docx' }))
      .toMatchObject({ status: 'fallback', reason: 'more_pages', pages: 2, pagesBefore: 1 });
    expect(grew.files.size).toBe(0);
    // A shorter line pulled the last line back from page 2.
    const shrank = fakeBucket();
    expect(await inPlaceCvRecord({ ...common(shrank), run: office(2, 1), mode: 'on', cvBuffer: makeDocx(), cvType: 'docx', cvKey: 'cv.docx' }))
      .toMatchObject({ status: 'ready', pageCheck: 'libreoffice', pages: 1, pagesBefore: 2 });
  });
});

const SECRET = 'i'.repeat(40);
const T0 = Date.UTC(2026, 9, 2, 10, 0, 0);
const ORDER = 'order_INPLACE1';
const BASE = `assisted_applications/${ORDER}`;

describe('the third CV on the review page and at submission', () => {
  let store: ReturnType<typeof createMemoryFirestore>;
  let bucket: ReturnType<typeof fakeBucket>;
  const deps = () => ({ db: store.db, bucket, runEffect: vi.fn(async () => ({ ok: true })), getSecret: async () => SECRET, signUrl: async (key: string) => `https://signed.example/${key}`, nowMs: T0 });
  const token = () => mintReviewToken({ secret: SECRET, orderId: ORDER, round: 1, nowMs: T0 });
  const post = (body: Record<string, any>) => handleAssistedApplicationReview({ method: 'POST', body: { t: token(), ...body } }, deps());
  const get = () => handleAssistedApplicationReview({ method: 'GET', query: { t: token() } }, deps());

  beforeEach(() => {
    bucket = fakeBucket();
    const base = makeDocx();
    const first = buildInPlaceDocx(base, tailored(), { profile });
    bucket.files.set(`assisted-application-uploads/${ORDER}/1-cv.docx`, base);
    bucket.files.set(`assisted-application-uploads/${ORDER}/ai-cv-inplace-r1-1.docx`, first.docx);
    store = createMemoryFirestore({
      [BASE]: { paymentStatus: 'paid', submissionStatus: 'in_progress', jobTitle: 'Sviluppatore', companyName: 'Esempio Fintech SA', locale: 'it', applicantName: 'Marco Bianchi', cvStorageKey: `assisted-application-uploads/${ORDER}/1-cv.docx` },
      [`${BASE}/automation/flow`]: { state: 'candidate_review', round: 1, deadlineAt: null, answers: {}, feedback: [] },
      [`${BASE}/ai_drafts/current`]: {
        status: 'ready', round: 1, language: 'it', profile, job: { title: 'Sviluppatore' }, factSources: { text: CV_TEXT },
        channel: { type: 'lever', applyUrl: 'https://jobs.lever.co/x/1/apply' }, coverLetter: { subject: 'Candidatura', text: 'Gentili signore, egregi signori,\n\ntesto.\n\nCordiali saluti' },
        applicationEmail: { to: '', subject: 'x', body: 'y' }, formAnswers: [], questions: [],
        tailoredCv: {
          status: 'ready', pdfKey: `assisted-application-uploads/${ORDER}/ai-cv-r1-1.pdf`, language: 'it', cv: tailored(),
          inplace: { status: 'ready', docxKey: `assisted-application-uploads/${ORDER}/ai-cv-inplace-r1-1.docx`, baseKey: `assisted-application-uploads/${ORDER}/1-cv.docx`, baseType: 'docx', patched: first.patched, skipped: first.skipped, pageCheck: 'libreoffice', pages: 1 },
        },
      },
    });
  });

  it('offers the candidate’s own file as a third choice, and sends it when chosen', async () => {
    const { body } = await get();
    expect(body.tailoredCv).toMatchObject({ choice: 'tailored', inplace: { url: `https://signed.example/assisted-application-uploads/${ORDER}/ai-cv-inplace-r1-1.docx`, patched: 4, kept: 2 } });
    expect(await post({ action: 'cv_choice', cvChoice: 'inplace' })).toMatchObject({ status: 200, body: { cvChoice: 'inplace' } });
    const flow = store.read(`${BASE}/automation/flow`);
    const draft = store.read(`${BASE}/ai_drafts/current`);
    expect(cvChoiceOf(draft, flow)).toBe('inplace');
    const sent = await chooseCv({ draft, flow, bucket, cvBuffer: Buffer.from('x'), cvType: 'docx' });
    expect(sent).toMatchObject({ cvType: 'docx', cvSent: 'inplace' });
    expect(texts(sent.cvBuffer)).toContain('Portale B2B in React e Node.js usato da 400 clienti');
  });

  it('refuses the third choice when the draft has none, and reads a stale choice as the tailored CV', async () => {
    const draft = store.read(`${BASE}/ai_drafts/current`);
    store.docs.set(`${BASE}/ai_drafts/current`, { ...draft, tailoredCv: { ...draft.tailoredCv, inplace: { status: 'fallback', reason: 'text_box' } } });
    expect(await post({ action: 'cv_choice', cvChoice: 'inplace' })).toMatchObject({ status: 400, body: { error: 'invalid_cv_choice' } });
    expect(cvChoiceOf(store.read(`${BASE}/ai_drafts/current`), { cvChoice: 'inplace' })).toBe('tailored');
  });

  it('writes the line-by-line choices into the candidate’s own file too', async () => {
    const saved = await post({ action: 'cv_lines', choices: { 'r0-l0': { use: 'original' }, 'r0-l1': { use: 'own', text: 'Tempi di build dimezzati con Docker' } } });
    expect(saved.status).toBe(200);
    const { inplace } = store.read(`${BASE}/ai_drafts/current`).tailoredCv;
    expect(inplace).toMatchObject({ status: 'ready', baseKey: `assisted-application-uploads/${ORDER}/1-cv.docx`, pageCheck: 'budget' });
    expect(inplace.docxKey).not.toBe(`assisted-application-uploads/${ORDER}/ai-cv-inplace-r1-1.docx`);
    const after = texts(bucket.files.get(inplace.docxKey)!);
    expect(after[7]).toBe('Sviluppo di un portale B2B in React e Node.js usato da 400 clienti');
    expect(after[8]).toBe('•\tTempi di build dimezzati con Docker');
  }, 60_000);
});
