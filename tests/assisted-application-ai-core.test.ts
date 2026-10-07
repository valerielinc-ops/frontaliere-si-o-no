import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildCoverLetterPdf,
  docxXmlToText,
  extractCvText,
  extractDocxText,
  pdfItemsText,
  readZipEntry,
  renderPdf,
  textWidth,
  wrapText,
} from '../functions/src/assistedApplicationAiDocuments.js';
import { buildFormAnswers, checkDraftFacts, ensureRequiredQuestions, salutationQuestion, splitName } from '../functions/src/assistedApplicationAiDraftCore.js';
import { documentsSystemPrompt, documentsUserText, matchSystemPrompt, matchUserText } from '../functions/src/assistedApplicationAiPrompts.js';
import { permitOptions } from '../functions/src/lib/permitStatus.js';
import { buildFactIndex, checkGeneratedFacts } from '../functions/src/assistedApplicationAiFactCheck.js';
import {
  classifyApplicationChannel,
  fetchJobPosting,
  fetchWorkdayPosting,
  htmlToText,
  isFetchablePublicUrl,
  isPrivateAddress,
  postingAtsRedirect,
  resolveApplyUrl,
  resolvesToPublicHost,
  workdayPostingApiUrl,
} from '../functions/src/assistedApplicationAiJob.js';

/** Minimal ZIP writer (deflate), enough to build a DOCX fixture. */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content, 'utf8');
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

const DOCUMENT_XML = '<?xml version="1.0"?><w:document><w:body>'
  + '<w:p><w:r><w:t>Maria Rossi</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>Esperienza:</w:t></w:r><w:r><w:tab/><w:t>2019 &amp; 2021 &#x2013; Lugano</w:t></w:r></w:p>'
  + '</w:body></w:document>';

describe('CV text extraction', () => {
  it('reads word/document.xml out of a DOCX and keeps paragraphs', () => {
    const docx = zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': DOCUMENT_XML });
    expect(readZipEntry(docx, 'word/missing.xml')).toBeNull();
    expect(extractDocxText(docx)).toBe('Maria Rossi\nEsperienza: 2019 & 2021 – Lugano');
  });

  it('decodes XML entities and breaks', () => {
    expect(docxXmlToText('<w:p><w:t>A&lt;B</w:t><w:br/><w:t>C&quot;</w:t></w:p>')).toBe('A<B\nC"');
  });

  it('bounds the inflated size of a DOCX entry (zip-bomb guard)', () => {
    const bomb = zip({ 'word/document.xml': 'x'.repeat(200_000) });
    expect(() => readZipEntry(bomb, 'word/document.xml', 1000)).toThrow();
  });

  it('returns no text for a legacy .doc', async () => {
    await expect(extractCvText(Buffer.from([0xd0, 0xcf]), 'doc')).resolves.toBe('');
  });
});

describe('cover letter PDF', () => {
  it('wraps on measured Helvetica widths', () => {
    const lines = wrapText('Sono disponibile a partire dal mese prossimo per un colloquio conoscitivo presso la vostra sede.', 10.5, 150);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(textWidth(line, 10.5)).toBeLessThanOrEqual(150);
  });

  it('writes a valid PDF whose xref points at every object', () => {
    const pdf = renderPdf([{ text: 'Hello' }, { text: 'World', bold: true }], { title: 'Test' });
    const body = pdf.toString('latin1');
    expect(body.startsWith('%PDF-1.4')).toBe(true);
    const startxref = Number(body.match(/startxref\n(\d+)/)?.[1]);
    expect(body.slice(startxref, startxref + 4)).toBe('xref');
    const offsets = [...body.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
    offsets.forEach((offset, index) => expect(body.slice(offset).startsWith(`${index + 1} 0 obj`)).toBe(true));
  });

  it('round-trips Italian, German and French letters through a PDF reader', async () => {
    const pdf = buildCoverLetterPdf({
      senderLines: ['Maria Rossi', 'Como', 'maria@example.com'],
      recipientLines: ['Müller AG', '8000 Zürich'],
      placeDate: 'Como, 30 settembre 2026',
      subject: 'Bewerbung als Pflegefachfrau',
      salutation: 'Sehr geehrte Damen und Herren',
      paragraphs: ['Perché è così? Très élégant, naïve – “quoted” … €.', 'Zweiter Absatz. '.repeat(80)],
      closing: 'Freundliche Grüsse',
      signature: 'Maria Rossi',
      title: 'Motivationsschreiben – Maria Rossi',
    });
    const text = await extractCvText(pdf, 'pdf');
    expect(text).toContain('Bewerbung als Pflegefachfrau');
    expect(text).toContain('Perché è così? Très élégant, naïve');
    expect(text).toContain('Freundliche Grüsse');
    expect(text).toContain('Como, 30 settembre 2026');
  });

  it('tells apart the text blocks of a PDF that pdf.js leaves unseparated, by where they stand', () => {
    // A real order of 2026-10-07, a CV laid out in boxes: the years of three jobs, each in its own box, and a
    // school under its diploma. pdf.js marks no break between two boxes: «2022 - 202520192018»,
    // «TuristicoIstituto Tecnico». The fact gate found neither the years nor the school.
    const item = (str: string, x: number, y: number, width: number, extra: object = {}) => ({ str, x, y, width, height: 8, fontSize: 8, hasEOL: false, ...extra });
    const boxes = [
      item('Contact', 43, 561.6, 66, { height: 16, fontSize: 16 }),
      item('2022 - 2025', 512.6, 476.5, 46.8), item('2019', 542.2, 332.4, 17.3), item('2018', 548.6, 182.4, 17.3),
      item('Diploma di scuola superiore - Turistico', 279, 611.7, 159.1), item('Istituto Tecnico Esempio', 279, 596.8, 129.8),
    ];
    expect(pdfItemsText(boxes)).toBe('Contact\n2022 - 2025\n2019\n2018\nDiploma di scuola superiore - Turistico\nIstituto Tecnico Esempio');
    const sources = { text: pdfItemsText(boxes), posting: '', order: 'Commessa\nEsempio SA\nMaria Rossi', answers: '' };
    const letter = { coverLetter: 'Dal 2022 al 2025 ho lavorato in ufficio, dal 2018 in agenzia. Ho studiato presso Istituto Tecnico Esempio.' };
    expect(checkDraftFacts(letter, sources).unsupported).toEqual([]);
    const glued = boxes.map((box) => box.str).join('');
    expect(checkDraftFacts(letter, { ...sources, text: glued }).unsupported.map((flag: any) => flag.token)).toEqual(['2025', '2018', 'Istituto Tecnico Esempio']);
    // What pdf.js separated stays as it is: its line breaks (on the last item of a line, or on an empty item
    // that opens the next one) and its word gaps (an item of one space).
    expect(pdfItemsText([item('Back office,', 279, 444.3, 50), item(' ', 329, 444.3, 2), item('accoglienza', 331, 444.3, 48, { hasEOL: true }), item('al cliente', 279, 432.3, 40)]))
      .toBe('Back office, accoglienza\nal cliente');
    expect(pdfItemsText([item('Maria', 76.2, 645.9, 91), item('', 43.7, 618.1, 0, { hasEOL: true }), item('Rossi', 43.7, 618.1, 60)])).toBe('Maria\nRossi');
    // One word split in two items (a kerning pair, a font change) stays one word; two columns of a line are two words.
    expect(pdfItemsText([item('Infer', 100, 300, 20), item('miera', 120.2, 300, 21)])).toBe('Infermiera');
    expect(pdfItemsText([item('Receptionist', 100, 300, 50), item('2019', 400, 300, 17.3)])).toBe('Receptionist 2019');
    // A superscript stays on its line; items without a position are joined as before.
    expect(pdfItemsText([item('1', 100, 300, 4), item('er', 104, 303, 6, { height: 5, fontSize: 5 })])).toBe('1er');
    expect(pdfItemsText([{ str: 'a' }, { str: 'b', hasEOL: true }, { str: 'c' }] as any)).toBe('ab\nc');
    // pdf.js' own items carry the position in `transform`: read the same way (review of #12225).
    const raw = (str: string, x: number, y: number, width: number) => ({ str, transform: [8, 0, 0, 8, x, y], width, height: 8, hasEOL: false });
    expect(pdfItemsText([raw('Receptionist', 100, 300, 50), raw('2019', 400, 300, 17.3), raw('Hotel Esempio', 100, 280, 52)] as any)).toBe('Receptionist 2019\nHotel Esempio');
  });

  it('reads a real PDF whose text boxes are form XObjects with its blocks apart', async () => {
    // How a design tool exports a CV: each text box a form XObject, drawn at its own place. pdf.js marks no
    // break between two of them, and unpdf's own joining gives «Contact2022 - 202520192018Diploma …».
    const text = await extractCvText(boxedPdf([
      { x: 279, y: 512, text: 'Contact', size: 16 },
      { x: 512.6, y: 476.5, text: '2022 - 2025' }, { x: 542.2, y: 332.4, text: '2019' }, { x: 548.6, y: 182.4, text: '2018' },
      { x: 279, y: 611.7, text: 'Diploma di scuola superiore - Turistico' }, { x: 279, y: 596.8, text: 'Istituto Tecnico Esempio' },
      { x: 279, y: 300, text: 'Receptionist' }, { x: 540, y: 300, text: '2019' },
    ]), 'pdf');
    expect(text).toBe('Contact\n2022 - 2025\n2019\n2018\nDiploma di scuola superiore - Turistico\nIstituto Tecnico Esempio\nReceptionist 2019');
  });
});

/** A one-page PDF whose text boxes are form XObjects, each drawn at its own place. */
function boxedPdf(boxes: Array<{ x: number; y: number; text: string; size?: number }>): Buffer {
  const stream = (dictionary: string, content: string) => `<< ${dictionary} /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << ${boxes.map((_, index) => `/B${index} ${6 + index} 0 R`).join(' ')} >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    stream('', boxes.map(({ x, y }, index) => `q 1 0 0 1 ${x} ${y} cm /B${index} Do Q`).join('\n')),
    ...boxes.map(({ text, size = 8 }) => stream('/Type /XObject /Subtype /Form /BBox [0 0 400 40] /Resources << /Font << /F1 4 0 R >> >>', `BT /F1 ${size} Tf (${text}) Tj ET`)),
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(body, 'latin1');
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

describe('fact gate', () => {
  const index = buildFactIndex([
    'Maria Rossi · +41 79 123 45 67 · maria.rossi@example.com · linkedin.com/in/maria-rossi\n'
      + 'Infermiera, Ospedale Civico 2018 – 2023. Reparto da 24 letti, riduzione errori del 15%.\nStipendio CHF 6\'500.',
    'Offerta: 80-100%. Lugano.',
  ]);

  it('accepts numbers, e-mails, phones and URLs that the sources contain', () => {
    const result = checkGeneratedFacts({
      letter: 'Dal 2018 al 2023 ho gestito un reparto da 24 letti e ridotto gli errori del 15%, con un grado 80-100%. '
        + 'Scrivetemi a maria.rossi@example.com, +41 79 123 45 67, www.linkedin.com/in/maria-rossi. CHF 6500.',
    }, index);
    expect(result).toEqual({ ok: true, unsupported: [], advisories: [] });
  });

  it('flags invented metrics, addresses and links', () => {
    const result = checkGeneratedFacts({
      letter: 'Ho 7 anni di esperienza e ho ridotto i costi del 30%. Contatti: maria@fake.ch, +41 91 000 00 00, https://portfolio.example.org',
    }, index);
    expect(result.ok).toBe(false);
    expect(result.unsupported.map((item) => `${item.kind}:${item.token}`)).toEqual([
      'email:maria@fake.ch',
      'url:https://portfolio.example.org',
      'phone:+41 91 000 00 00',
      'number:7',
      'number:30',
    ]);
  });

  describe('tools in the letter and the e-mail', () => {
    const sources = {
      text: 'Maria Rossi\nInfermiera, Ospedale Civico 2018 – 2023. Rianimazione BLS, sistema qualità ISO 9001. Tedesco B2.',
      posting: 'Ospedale ABC SA cerca un/a infermiere/a. Requisiti: esperienza con SAP e PowerPoint, ACLS, norma ISO 13485. Luogo di lavoro: Bellinzona. Rif. INF-45',
      order: ['Infermiere/a', 'Ospedale ABC SA', 'Maria Rossi', 'maria.rossi@example.com', '', 'Infermiere/a'].join('\n'),
      answers: '',
    };
    const warnings = (texts: Record<string, string>, extra: Record<string, string> = {}) =>
      checkDraftFacts(texts, { ...sources, ...extra }).unsupported.map((item: any) => `${item.field}:${item.kind}:${item.token}`);

    it('flags a tool, a certificate or a standard that only the posting names', () => {
      expect(warnings({
        coverLetter: 'Ho esperienza con SAP e PowerPoint, il corso ACLS e la norma ISO 13485.',
        emailBody: 'Conosco bene SAP.',
      })).toEqual(['coverLetter:tool:SAP', 'coverLetter:tool:PowerPoint', 'coverLetter:tool:ACLS', 'coverLetter:tool:ISO 13485', 'emailBody:tool:SAP']);
    });

    it('never flags the company, the job title, the place, the reference or the CV’s own tools', () => {
      expect(checkDraftFacts({
        coverLetter: 'Gentile team HR dell’Ospedale ABC SA,\n\ncon la presente mi candido come Infermiere/a a Bellinzona (TI). '
          + 'Dal 2018 al 2023 ho lavorato all’Ospedale Civico, con BLS, ISO-9001 e tedesco B2. In allegato il mio CV.\n\nCordiali saluti',
        emailSubject: 'Candidatura per la posizione di Infermiere/a – Maria Rossi (Rif. INF-45)',
        emailBody: 'Gentili Signori,\n\nin allegato la mia candidatura.\n\nMaria Rossi\nmaria.rossi@example.com',
      }, { ...sources, place: 'Bellinzona' })).toEqual({ ok: true, unsupported: [], advisories: [] });
    });

    it('takes the candidate’s own word for a tool, and checks tools only where they are a claim', () => {
      expect(warnings({ coverLetter: 'Uso SAP ogni giorno.' }, { answers: 'Uso SAP da due anni' })).toEqual([]);
      expect(warnings({ coverLetter: 'Uso SAP ogni giorno.' }, { candidate: 'Uso SAP ogni giorno.' })).toEqual([]);
      // "Why this company" talks about the employer; an interview question may name the posting's tools.
      expect(warnings({ whyCompany: 'Il vostro reparto lavora con SAP.', question: 'Come userebbe SAP?' })).toEqual([]);
    });

    it('reads the employer’s initials as its name, not as a tool', () => {
      const eoc = { order: ['Infermiere/a', 'Ente Ospedaliero Cantonale', 'Maria Rossi'].join('\n'), posting: 'L’EOC cerca un/a infermiere/a.' };
      expect(warnings({ coverLetter: 'Vorrei lavorare all’EOC.' }, eoc)).toEqual([]);
      expect(warnings({ coverLetter: 'Vorrei lavorare all’EOC con SAP.' }, eoc)).toEqual(['coverLetter:tool:SAP']);
    });
  });
});

describe('application channel', () => {
  it('recognises the ATS behind the apply link', () => {
    expect(classifyApplicationChannel({ applyUrl: 'https://sunrise.wd3.myworkdayjobs.com/Sunrise/job/x/apply' })).toMatchObject({ type: 'workday', requiresAccount: true });
    expect(classifyApplicationChannel({ applyUrl: 'https://jobs.lever.co/tsmg/abc/apply' })).toMatchObject({ type: 'lever', requiresAccount: false });
    expect(classifyApplicationChannel({ applyUrl: 'https://recruitingapp-5181.umantis.com/Vacancies/1' }).type).toBe('umantis');
    expect(classifyApplicationChannel({ applyUrl: 'https://careers.example.ch/jobs/1' }).type).toBe('employer_site');
    expect(classifyApplicationChannel({}).type).toBe('unknown');
  });

  it('uses an e-mail address only when the posting itself contains it', () => {
    expect(classifyApplicationChannel({ applyUrl: 'mailto:jobs@example.ch?subject=CV' })).toMatchObject({ type: 'email', email: 'jobs@example.ch' });
    expect(classifyApplicationChannel({
      applyUrl: 'https://careers.example.ch/jobs/1',
      postingText: 'Invia il CV a HR@Example.ch entro il 10.10.',
      applicationEmail: 'hr@example.ch',
    })).toMatchObject({ type: 'email', email: 'hr@example.ch', applyUrl: 'https://careers.example.ch/jobs/1' });
    expect(classifyApplicationChannel({
      applyUrl: 'https://careers.example.ch/jobs/1',
      postingText: 'Candidati online.',
      applicationEmail: 'invented@example.ch',
    }).type).toBe('employer_site');
  });

  it('prefers the employer’s application portal, e-mail only when the posting offers no portal', () => {
    const text = 'Bewerbung online oder an jobs@spital.ch.';
    // An applicant-tracking portal wins over the address the posting also names.
    expect(classifyApplicationChannel({ applyUrl: 'https://spital.wd3.myworkdayjobs.com/de-DE/Careers/job/x/apply', postingText: text, applicationEmail: 'jobs@spital.ch' }))
      .toMatchObject({ type: 'workday', email: '' });
    expect(classifyApplicationChannel({ applyUrl: 'https://jobs.lever.co/spital/abc/apply', postingText: text, applicationEmail: 'jobs@spital.ch' }).type).toBe('lever');
    // Only the employer's own page, a job board or LinkedIn: the address is the way to apply.
    expect(classifyApplicationChannel({ applyUrl: 'https://www.spital.ch/jobs/pflege', postingText: text, applicationEmail: 'jobs@spital.ch' }).type).toBe('email');
    expect(classifyApplicationChannel({ applyUrl: 'https://www.jobs.ch/de/stellenangebote/detail/123/', postingText: text, applicationEmail: 'jobs@spital.ch' }).type).toBe('email');
    expect(classifyApplicationChannel({ applyUrl: 'https://www.linkedin.com/jobs/view/1', postingText: text, applicationEmail: 'jobs@spital.ch' }).type).toBe('email');
  });

  it('knows Coop’s WhatsApp applications (PastaHR): an address the posting gives comes first', () => {
    const pasta = 'https://prod.pastahr.com/en/r/COFU2003?utm_medium=prospective-job-description';
    expect(classifyApplicationChannel({ applyUrl: pasta })).toMatchObject({ type: 'pastahr', label: 'PastaHR (WhatsApp)', requiresAccount: false });
    expect(classifyApplicationChannel({ applyUrl: pasta, postingText: 'Bewerbung an lehrstellen@coop.ch', applicationEmail: 'lehrstellen@coop.ch' }).type).toBe('email');
  });
});

describe('apply redirect (Coop: Prospective.ch → SAP SuccessFactors)', () => {
  const posting = 'https://jobs.coopjobs.ch/offene-stellen/baecker-in-konditor-in-schwerpunkt-baeckerei/20d53107-db26-4a35-8f4c-b4d15bb4bb31';
  const redirect = 'https://ohws.prospective.ch/public/v1/redirect/20d53107-db26-4a35-8f4c-b4d15bb4bb31/ats/';
  const ats = 'https://career2.successfactors.eu/career?company=Coop&career_ns=job_application&career_job_req_id=170044&jobPipeline=coop-internet';
  const publicHost = async () => [{ address: '93.184.216.34', family: 4 }];
  // jobs.coopjobs.ch as saved on 2026-10-02: the bookmark first, then the apply link.
  const html = `<a class="text-btn" role="button">Später bewerben</a><h1>Bäcker:in</h1><a class="main-btn apply" target="_blank" href="${redirect}"> Jetzt bewerben </a>`;
  const portal = (calls: string[]) => async (url: string, init: any = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    if (url === posting) return new Response(html, { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8' } });
    if (url === redirect) return new Response(null, { status: 303, headers: { location: ats } });
    return new Response('', { status: 404 });
  };

  it('follows «Jetzt bewerben» to the ATS, without loading the ATS page', async () => {
    const calls: string[] = [];
    await expect(resolveApplyUrl(posting, { fetchImpl: portal(calls) as any, resolve: publicHost })).resolves.toEqual({ applyUrl: ats, via: 'prospective' });
    expect(calls).toEqual([`GET ${posting}`, `HEAD ${redirect}`]);
    const channel = classifyApplicationChannel({ applyUrl: (await resolveApplyUrl(posting, { fetchImpl: portal([]) as any, resolve: publicHost })).applyUrl });
    expect(channel).toMatchObject({ type: 'successfactors', requiresAccount: true, host: 'career2.successfactors.eu' });
  });

  it('follows the posting’s own apply link, never another job’s redirect on the same page', async () => {
    // Review of #10980: a "similar jobs" link to another posting comes first in the page.
    const other = 'https://ohws.prospective.ch/public/v1/redirect/11111111-2222-3333-4444-555555555555/ats/';
    const otherAts = 'https://career2.successfactors.eu/career?company=Coop&career_job_req_id=999999';
    const page = `<aside><a href="${other}">Verkäufer:in Food — Jetzt bewerben</a></aside><main><a class="main-btn apply" target="_blank" href="${redirect}"> Jetzt bewerben </a></main>`;
    const calls: string[] = [];
    const fetchImpl = async (url: string, init: any = {}) => {
      calls.push(`${init.method || 'GET'} ${url}`);
      if (url === posting) return new Response(page, { status: 200, headers: { 'content-type': 'text/html' } });
      if (url === redirect) return new Response(null, { status: 303, headers: { location: ats } });
      if (url === other) return new Response(null, { status: 303, headers: { location: otherAts } });
      return new Response('', { status: 404 });
    };
    await expect(resolveApplyUrl(posting, { fetchImpl: fetchImpl as any, resolve: publicHost })).resolves.toEqual({ applyUrl: ats, via: 'prospective' });
    expect(calls).not.toContain(`HEAD ${other}`);
    // Without an id in the posting's address: the one link labelled as the apply button, else nothing.
    const later = 'https://ohws.prospective.ch/public/v1/redirect/66666666-7777-8888-9999-000000000000/ats/';
    expect(postingAtsRedirect('https://careers.example.ch/job/bäcker', `<a href="${other}">Bäcker:in Rickenbach</a><a role="button" href="${later}">Später bewerben</a><a href="${redirect}">Jetzt bewerben</a>`)).toBe(redirect);
    expect(postingAtsRedirect('https://careers.example.ch/job/bäcker', `<a href="${other}">Jetzt bewerben</a><a href="${redirect}">Jetzt bewerben</a>`)).toBe('');
    // A posting whose id has no redirect on its page: nothing, not the first one found.
    expect(postingAtsRedirect(posting, `<a href="${other}">Jetzt bewerben</a>`)).toBe('');
  });

  it('keeps the posting’s address when there is nothing to follow, or it cannot be followed safely', async () => {
    const plain = async () => new Response('<a href="/apply">Jetzt bewerben</a>', { status: 200, headers: { 'content-type': 'text/html' } });
    await expect(resolveApplyUrl('https://careers.example.ch/jobs/1', { fetchImpl: plain as any, resolve: publicHost })).resolves.toEqual({ applyUrl: 'https://careers.example.ch/jobs/1', via: '' });
    // Already an ATS: no request at all.
    const none: string[] = [];
    await expect(resolveApplyUrl(ats, { fetchImpl: portal(none) as any, resolve: publicHost })).resolves.toEqual({ applyUrl: ats, via: '' });
    expect(none).toEqual([]);
    // The redirect leads to a private address: never followed.
    const toPrivate = async (url: string) => (url === posting
      ? new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
      : new Response(null, { status: 303, headers: { location: 'https://internal.example/x' } }));
    const resolve = async (host: string) => [{ address: host === 'internal.example' ? '10.0.0.5' : '93.184.216.34', family: 4 }];
    await expect(resolveApplyUrl(posting, { fetchImpl: toPrivate as any, resolve })).resolves.toEqual({ applyUrl: posting, via: '' });
    // A network error keeps the posting.
    const failing = async () => { throw new Error('ECONNRESET'); };
    await expect(resolveApplyUrl(posting, { fetchImpl: failing as any, resolve: publicHost })).resolves.toEqual({ applyUrl: posting, via: '' });
  });
});

describe('job posting fetch', () => {
  it('rejects non-public targets before any request', async () => {
    expect(isFetchablePublicUrl('http://example.ch/job')).toBe(false);
    expect(isFetchablePublicUrl('https://169.254.169.254/computeMetadata')).toBe(false);
    expect(isFetchablePublicUrl('https://metadata.google.internal/')).toBe(false);
    expect(isFetchablePublicUrl('https://localhost/')).toBe(false);
    expect(isFetchablePublicUrl('https://careers.example.ch/job')).toBe(true);
    for (const address of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.20.1.1', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    await expect(resolvesToPublicHost('https://evil.example/', async () => [{ address: '10.1.2.3', family: 4 }])).resolves.toBe(false);
    await expect(resolvesToPublicHost('https://ok.example/', async () => [{ address: '93.184.216.34', family: 4 }])).resolves.toBe(true);
  });

  it('reads the published job-detail file first', async () => {
    const calls: string[] = [];
    const posting = await fetchJobPosting({ jobId: 'acme-123', jobUrl: 'https://acme.ch/jobs/1' }, {
      fetchImpl: async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({
          description: 'Cerchiamo un infermiere.',
          requirements: ['Diploma SUP'],
          applyUrl: 'https://acme.wd3.myworkdayjobs.com/x/apply',
          titleByLocale: { it: 'Infermiere' },
          addressLocality: 'Lugano',
          baseSalary: { currency: 'CHF', value: { minValue: 70000, maxValue: 90000, unitText: 'YEAR' } },
        }), { status: 200 });
      },
    });
    expect(calls).toEqual(['https://cdn.frontaliereticino.ch/data/job-detail/acme-123.json']);
    expect(posting).toMatchObject({ source: 'job_detail', text: 'Cerchiamo un infermiere.\n\n- Diploma SUP', location: 'Lugano', salary: 'CHF 70000–90000 / YEAR' });
  });

  it('falls back to the employer page but never follows a redirect to a private host', async () => {
    const page = `<html><body><script>x()</script><h1>Job</h1><p>${'Descrizione del ruolo. '.repeat(20)}</p></body></html>`;
    const resolve = async (host: string) => [{ address: host === 'internal.example' ? '10.0.0.5' : '93.184.216.34', family: 4 }];
    const ok = await fetchJobPosting({ jobId: '', jobUrl: 'https://acme.ch/jobs/1' }, {
      resolve,
      fetchImpl: async () => new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    expect(ok.source).toBe('job_page');
    expect(ok.text).not.toContain('x()');
    const blocked = await fetchJobPosting({ jobId: '', jobUrl: 'https://acme.ch/jobs/1' }, {
      resolve,
      fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://internal.example/secret' } }),
    });
    expect(blocked.source).toBe('none');
  });

  it('reads a Workday posting from Workday’s own JSON: its page is an empty shell', async () => {
    const posting = 'https://acme.wd3.myworkdayjobs.com/en-US/Careers/job/Lugano/Verkaufsberater_R15163';
    const api = 'https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/Careers/job/Lugano/Verkaufsberater_R15163';
    expect(workdayPostingApiUrl(posting)).toBe(api);
    // Without the locale, without the place, and from the steps of the application.
    expect(workdayPostingApiUrl('https://acme.wd3.myworkdayjobs.com/Careers/job/Lugano/Verkaufsberater_R15163/apply/applyManually?source=x')).toBe(api);
    expect(workdayPostingApiUrl('https://acme.wd103.myworkdayjobs.com/de-DE/Careers/job/Verkaufsberater_R15163/apply'))
      .toBe('https://acme.wd103.myworkdayjobs.com/wday/cxs/acme/Careers/job/Verkaufsberater_R15163');
    // A locale written in lower case or with an underscore is still the locale, not the site.
    expect(workdayPostingApiUrl('https://acme.wd3.myworkdayjobs.com/de_de/Careers/job/Lugano/Verkaufsberater_R15163')).toBe(api);
    // The same career site under Workday's other name (read on 2026-10-07: wd502.myworkdaysite.com answers the
    // same JSON and the same «not found» error): the tenant is in the path, after «recruiting».
    expect(workdayPostingApiUrl('https://wd502.myworkdaysite.com/de-CH/recruiting/acme/Careers/job/Lugano/Verkaufsberater_R15163/apply'))
      .toBe('https://wd502.myworkdaysite.com/wday/cxs/acme/Careers/job/Lugano/Verkaufsberater_R15163');
    expect(workdayPostingApiUrl('https://wd502.myworkdaysite.com/recruiting/acme/Careers/job/Verkaufsberater_R15163'))
      .toBe('https://wd502.myworkdaysite.com/wday/cxs/acme/Careers/job/Verkaufsberater_R15163');
    // A host that names the tenant on myworkdaysite.com (the channel's pattern admits it) is read like the first.
    expect(workdayPostingApiUrl('https://acme.myworkdaysite.com/Careers/job/Verkaufsberater_R15163'))
      .toBe('https://acme.myworkdaysite.com/wday/cxs/acme/Careers/job/Verkaufsberater_R15163');
    // A career site's home, another portal, plain http: no posting of Workday's.
    for (const other of [
      'https://acme.wd3.myworkdayjobs.com/en-US/Careers', 'https://wd502.myworkdaysite.com/recruiting/acme/Careers', 'https://wd502.myworkdaysite.com/Careers/job/a/b',
      'https://jobs.lever.co/acme/1', 'http://acme.wd3.myworkdayjobs.com/Careers/job/a/b', 'not a url',
    ]) {
      expect(workdayPostingApiUrl(other)).toBe('');
    }

    const resolve = async () => [{ address: '93.184.216.34', family: 4 }];
    const info = { title: 'Verkaufsberater', jobDescription: `<p>${'Beratung und Verkauf im Geschäft. '.repeat(12)}</p>`, location: 'Lugano', startDate: '2026-08-05', canApply: true, posted: true };
    const calls: Array<[string, string]> = [];
    const fetchImpl = (answer: () => Response) => async (url: string, init: any = {}) => {
      calls.push([url, init.headers?.Accept]);
      return url === api ? answer() : new Response('<html><body><div id="root"></div></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const open = fetchImpl(() => new Response(JSON.stringify({ jobPostingInfo: info }), { status: 200 }));
    await expect(fetchWorkdayPosting(open, posting, resolve)).resolves.toEqual({ gone: false, info });
    // Workday answers 406 to anything but JSON.
    expect(calls).toEqual([[api, 'application/json']]);
    // The posting is gone: Workday's own error, never any other 404 (an address this code derived badly).
    const gone = fetchImpl(() => new Response(JSON.stringify({ errorCode: 'S21', httpStatus: 404, message: 'not found: Job_Posting_Anchor_ID=Verkaufsberater_R15163' }), { status: 404 }));
    await expect(fetchWorkdayPosting(gone, posting, resolve)).resolves.toEqual({ gone: true, info: null });
    for (const unreadable of [new Response('Not Found', { status: 404 }), new Response(JSON.stringify({ widget: 'redirect' }), { status: 200 }), new Response('', { status: 503 })]) {
      await expect(fetchWorkdayPosting(fetchImpl(() => unreadable), posting, resolve)).resolves.toBeNull();
    }
    await expect(fetchWorkdayPosting(open, 'https://jobs.lever.co/acme/1', resolve)).resolves.toBeNull();
    await expect(fetchWorkdayPosting(open, posting, async () => [{ address: '10.0.0.5', family: 4 }])).resolves.toBeNull();

    // A posting that left our dataset: the page has no text, the JSON has the posting and its date.
    const read = await fetchJobPosting({ jobId: '', jobUrl: posting }, { resolve, fetchImpl: open });
    expect(read).toMatchObject({ source: 'job_page', location: 'Lugano', datePosted: '2026-08-05', postingDateSource: 'reported' });
    expect(read.text).toContain('Beratung und Verkauf im Geschäft.');
    // No JSON: the page, as for any other employer (here an empty shell, so no posting).
    expect((await fetchJobPosting({ jobId: '', jobUrl: posting }, { resolve, fetchImpl: gone })).source).toBe('none');
  });

  it('turns HTML into readable text', () => {
    expect(htmlToText('<ul><li>Uno</li><li>Due &amp; tre</li></ul><style>p{}</style>')).toBe('- Uno\n- Due & tre');
  });
});

// umantis, 2026-10-03: «Title: Ms / Mr / Other» is required on the form and came back as a second round at submit time.
describe('given names and surname for a form', () => {
  it('keeps with the surname the particles that open it, and a given name for the first field', () => {
    // A real order of 2026-10-07: the particle of the surname was typed in the form's first-name field.
    const split = (name: string) => { const { firstName, lastName } = splitName(name); return `${firstName} | ${lastName}`; };
    expect(split('Amina El Amrani')).toBe('Amina | El Amrani');
    expect(split('Maria De Luca')).toBe('Maria | De Luca');
    expect(split('Hans von Arx')).toBe('Hans | von Arx');
    expect(split('Anna Maria van der Berg')).toBe('Anna Maria | van der Berg');
    expect(split('Jean Pierre Le Goff')).toBe('Jean Pierre | Le Goff');
    expect(split('Karim Ben Ali')).toBe('Karim | Ben Ali');
    expect(split('Giulia Dalla Chiesa')).toBe('Giulia | Dalla Chiesa');
    // Without a particle the last word is the surname, as before.
    expect(split('Maria Luisa Rossi')).toBe('Maria Luisa | Rossi');
    expect(split('Maria  Rossi ')).toBe('Maria | Rossi');
    expect(split('Maria')).toBe('Maria | ');
    expect(split('')).toBe(' | ');
    // The first word is a given name even when it could be a particle: never a name without one.
    expect(split('Ben Smith')).toBe('Ben | Smith');
    expect(split('Al Di Meola')).toBe('Al | Di Meola');
    expect(split('La Rosa')).toBe('La | Rosa');
    // The form answers of a draft follow it; the split the candidate chose on the review page wins.
    const fields = (identity: any) => Object.fromEntries(buildFormAnswers({ identity, profile: {}, documents: {}, answers: {}, locale: 'it' }).map((field: any) => [field.key, field.value]));
    expect(fields({ name: 'Amina El Amrani', email: 'a@example.com', phone: '' })).toMatchObject({ firstName: 'Amina', lastName: 'El Amrani' });
    expect(fields({ name: 'Amina El Amrani', firstName: 'Amina El', lastName: 'Amrani', email: 'a@example.com', phone: '' })).toMatchObject({ firstName: 'Amina El', lastName: 'Amrani' });
  });
});

describe('form of address', () => {
  it('asks it on the first review of a portal application, optional and in the candidate’s language', () => {
    const portal = { type: 'employer_site', applyUrl: 'https://careers.example/vacancies/1' };
    expect(salutationQuestion({ channel: portal, locale: 'it' })).toMatchObject({ id: 'salutation', type: 'choice', options: ['Signor', 'Signora', 'Altro'], required: false, source: 'rule' });
    expect(salutationQuestion({ channel: portal, locale: 'de' })?.options).toEqual(['Herr', 'Frau', 'Andere']);
    expect(salutationQuestion({ channel: portal, locale: 'fr' })?.options).toEqual(['Monsieur', 'Madame', 'Autre']);
    expect(salutationQuestion({ channel: portal, locale: 'en' })?.options).toEqual(['Mr', 'Ms', 'Other']);
    expect(salutationQuestion({ channel: portal, locale: 'xx' })?.options).toEqual(['Signor', 'Signora', 'Altro']);
    // A regional locale reads its language.
    expect(salutationQuestion({ channel: portal, locale: 'de-CH' })?.options).toEqual(['Herr', 'Frau', 'Andere']);
    expect(salutationQuestion({ channel: portal, locale: 'FR-ch' })?.options).toEqual(['Monsieur', 'Madame', 'Autre']);
  });

  it('never asks it for an e-mail application, twice, or once the candidate has answered', () => {
    const portal = { type: 'lever' };
    expect(salutationQuestion({ channel: { type: 'email' }, locale: 'it' })).toBeNull();
    expect(salutationQuestion({ channel: { type: 'unknown' }, locale: 'it' })).toBeNull();
    expect(salutationQuestion({ channel: { type: ' Email ' }, locale: 'it' })).toBeNull();
    expect(salutationQuestion({ channel: null, locale: 'it' })).toBeNull();
    expect(salutationQuestion({ channel: portal, answers: { salutation: 'Signora' }, locale: 'it' })).toBeNull();
    // The portal's own question, read ahead, already asks it.
    expect(salutationQuestion({ channel: portal, questions: [{ id: 'portal_anrede', question: 'Anrede' }], locale: 'de' })).toBeNull();
    expect(salutationQuestion({ channel: portal, questions: [{ id: 'portal_x', question: '', label: 'Civilité' }], locale: 'fr' })).toBeNull();
    // …or by its options, whatever its words (umantis: «Quale titolo desideri indicare?» Ms / Mr / Other).
    expect(salutationQuestion({ channel: portal, questions: [{ id: 'portal_title', question: 'Quale titolo desideri indicare?', options: ['Ms', 'Mr', 'Other'] }], locale: 'it' })).toBeNull();
    expect(salutationQuestion({ channel: portal, questions: [{ id: 'portal_a', question: 'Bitte wählen', options: ['Herr', 'Frau', 'Divers'] }], locale: 'de' })).toBeNull();
    // Review of #11028: the bare word "title" asks something else, and the form may still require «Title: Ms/Mr/Other».
    expect(salutationQuestion({ channel: { type: 'umantis' }, questions: [{ question: 'What is your job title?' }], locale: 'en' })).toMatchObject({ id: 'salutation' });
    expect(salutationQuestion({ channel: portal, questions: [{ id: 'titolo', question: 'Qual è il tuo titolo di studio?', options: ['Diploma', 'Laurea'] }], locale: 'it' })).toMatchObject({ id: 'salutation' });
    // One option that looks like a form of address is no form of address.
    expect(salutationQuestion({ channel: portal, questions: [{ id: 'x', question: 'Reparto', options: ['M', 'Chirurgia'] }], locale: 'it' })).toMatchObject({ id: 'salutation' });
  });
});

// Owner decisions of 2026-10-03 (P4): one permit question, with the fixed options, whoever asks it.
describe('permit status question', () => {
  const quote = { workPermitQuote: 'Permesso G o B richiesto.' };
  const model = (extra: Record<string, any>) => ({ id: 'x', question: '?', why: '', type: 'text', options: [], required: false, validation: null, source: 'match', ...extra });

  it('asks it on the posting’s request when the CV is silent: the six statuses in the candidate’s language, required', () => {
    for (const [locale, question, why] of [
      ['it', 'Hai la cittadinanza svizzera o un permesso svizzero valido oggi?', 'L’annuncio lo chiede e il CV non lo indica.'],
      ['de', 'Hast du das Schweizer Bürgerrecht oder eine heute gültige Schweizer Bewilligung?', 'Das Inserat fragt danach und der Lebenslauf nennt es nicht.'],
      ['fr', 'Avez-vous la nationalité suisse ou un permis suisse valable aujourd’hui ?', 'L’annonce le demande et le CV ne l’indique pas.'],
      ['en', 'Are you a Swiss citizen, or do you hold a Swiss permit valid today?', 'The ad asks for it and the CV does not state it.'],
    ]) {
      const [asked] = ensureRequiredQuestions([], { requirements: quote, profile: {}, locale });
      expect(asked).toMatchObject({ id: 'work_permit', question, why, type: 'choice', options: permitOptions(locale), required: true, source: 'rule' });
    }
    // Answered already, or the CV states it: not asked by the backstop.
    expect(ensureRequiredQuestions([], { requirements: quote, profile: {}, answers: { work_permit: 'G' } })).toEqual([]);
    expect(ensureRequiredQuestions([], { requirements: quote, profile: { workPermit: 'Permesso G' } })).toEqual([]);
  });

  it('gives a model’s permit question, under any id, the fixed options; required only on the posting’s request', () => {
    const [own] = ensureRequiredQuestions([model({ id: 'work_permit', question: 'Hai un permesso?', type: 'choice', options: ['Permesso G', 'Non ancora'], required: true })], { requirements: {}, profile: {}, locale: 'it' });
    expect(own).toMatchObject({ id: 'work_permit', options: permitOptions('it'), required: false, why: 'Facoltativo: lo riportiamo nel CV solo se lo scegli tu.', source: 'match' });
    const renamed = ensureRequiredQuestions([model({ id: 'permesso_lavoro', question: 'Hai un permesso di lavoro svizzero?' }), model({ id: 'work_permit', question: 'Permesso?' })], { requirements: quote, profile: {}, locale: 'it' });
    expect(renamed).toEqual([expect.objectContaining({ id: 'work_permit', required: true, options: permitOptions('it'), source: 'match' })]);
    // Nobody is asked the nationality or the date of birth; a driving licence stays the model's question.
    const kept = ensureRequiredQuestions([
      model({ id: 'nazionalita', question: 'Qual è la tua nazionalità?' }), model({ id: 'data_nascita', question: 'Data di nascita?' }),
      model({ id: 'driving_licence', question: 'Hai la patente B?', type: 'yes_no' }),
    ], { requirements: {}, profile: {}, locale: 'it' });
    expect(kept.map((question: any) => question.id)).toEqual(['driving_licence']);
  });

  it('shows a legacy answer as its label in the candidate’s language', () => {
    const fields = buildFormAnswers({ identity: { name: 'Maria Rossi', email: 'm@example.com', phone: '' }, profile: {}, documents: {}, answers: { work_permit: 'none' }, locale: 'fr' });
    expect(fields.find((field: any) => field.key === 'workPermit')).toMatchObject({ value: 'Je n’ai aujourd’hui aucun permis suisse', needsConfirmation: false });
  });

  it('tells the match that a permit an EU/EFTA national does not hold yet is no knock-out (decision of 2026-10-04)', () => {
    const payload = (nationality: string) => JSON.parse(matchUserText({ profile: { nationality }, requirements: {}, answers: {}, postingExcerpt: '' }).split('\n\n<<<')[0]);
    expect(payload('italiana').euEftaNational).toBe(true);
    expect(payload('Norwegen').euEftaNational).toBe(true);
    expect(payload('albanese').euEftaNational).toBe(false);
    expect(payload('').euEftaNational).toBe(false);
    expect(matchSystemPrompt('it')).toContain('A Swiss permit that an EU/EFTA national (euEftaNational true) does not hold yet is no knock-out clearly missing');
    // The model asks the permit only under its id, never the nationality or the birth date.
    expect(matchSystemPrompt('it')).toContain('always this id: the code sets its options and whether it is required); never ask the nationality or the date of birth');
  });

  it('gives the letter the permit by its official name only when it may be named', () => {
    const payload = (profile: Record<string, any>, language = 'it') => JSON.parse(documentsUserText({ candidateName: '', profile, requirements: {}, matches: [], answers: {}, feedback: [], posting: {}, postingExcerpt: '', language }).split('\n\n<<<')[0]).swissPermit;
    expect(payload({ permitStatus: 'permit_b', nationality: '' }, 'de')).toEqual({ status: 'permit_b', name: 'Aufenthaltsbewilligung B' });
    expect(payload({ permitStatus: 'permit_g', nationality: 'albanese' })).toEqual({ status: 'permit_g', name: '' });
    expect(payload({ permitStatus: 'none' })).toEqual({ status: 'none', name: '' });
    expect(payload({})).toEqual({ status: '', name: '' });
    expect(documentsSystemPrompt('it')).toContain('Never write that a permit is to be requested, applied for, pending, due, guaranteed or not needed');
  });

  it('asks the letter for the job titles as the profile writes them: the fact gate reads a translated title as one never held', () => {
    // A real draft of 2026-10-07: an Italian CV, an English letter, «as Administrative Clerk» for «Impiegata
    // Amministrativa». The gate stopped the draft at the owner; the prompt had never been told.
    expect(documentsSystemPrompt('en')).toContain('write each exactly as the profile gives it, in the profile\'s own language, never translated or adapted');
    const sources = { text: 'Maria Rossi\n2022 - 2025\nImpiegata Amministrativa\nEsempio Italia - Legnano', posting: '', order: 'Christmas Assistant\nAcme Cosmetics\nMaria Rossi', answers: '' };
    const flags = (coverLetter: string) => checkDraftFacts({ coverLetter }, sources).unsupported.map((flag: any) => `${flag.kind}:${flag.token}`);
    expect(flags('From 2022 to 2025, as Administrative Clerk at Esempio Italia, I managed the back office.')).toEqual(['title:Administrative Clerk']);
    expect(flags('From 2022 to 2025, as Impiegata Amministrativa at Esempio Italia, I managed the back office.')).toEqual([]);
  });
});

describe('application e-mail subject', () => {
  // Giro di prova 2026-09-30: the model's subject was just "Infermiere/a 80-100%".
  it('names the position and the candidate, and keeps a reference the posting asks for', async () => {
    const { applicationEmailSubject } = await import('../functions/src/assistedApplicationAiPrompts.js');
    expect(applicationEmailSubject('it', 'Infermiere/a diplomato/a 80-100%', 'Luigi Prova', 'Infermiere/a 80-100%'))
      .toBe('Candidatura per la posizione di Infermiere/a diplomato/a 80-100% – Luigi Prova');
    expect(applicationEmailSubject('de', 'Pflegefachperson HF', 'Maria Rossi', 'Bewerbung Kennziffer 4711'))
      .toBe('Bewerbung als Pflegefachperson HF – Maria Rossi (Kennziffer 4711)');
    // «de» elides before a vowel (CSFO, SECO: «au poste d’assistante»).
    expect(applicationEmailSubject('fr', 'Infirmier', 'Luca Bianchi', 'Candidature réf. INF-2026-17'))
      .toBe('Candidature au poste d’Infirmier – Luca Bianchi (réf. INF-2026-17)');
    // "Referenzen" is not a reference number.
    expect(applicationEmailSubject('de', 'Koch', 'Anna Keller', 'Bewerbung mit Referenzen')).toBe('Bewerbung als Koch – Anna Keller');
    expect(applicationEmailSubject('en', 'Nurse', '', '')).toBe('Application for the position of Nurse');
  });
});
