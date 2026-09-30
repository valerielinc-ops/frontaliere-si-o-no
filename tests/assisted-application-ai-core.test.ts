import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildCoverLetterPdf,
  docxXmlToText,
  extractCvText,
  extractDocxText,
  readZipEntry,
  renderPdf,
  textWidth,
  wrapText,
} from '../functions/src/assistedApplicationAiDocuments.js';
import { buildFactIndex, checkGeneratedFacts } from '../functions/src/assistedApplicationAiFactCheck.js';
import {
  classifyApplicationChannel,
  fetchJobPosting,
  htmlToText,
  isFetchablePublicUrl,
  isPrivateAddress,
  resolvesToPublicHost,
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
});

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
    expect(result).toEqual({ ok: true, unsupported: [] });
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

  it('turns HTML into readable text', () => {
    expect(htmlToText('<ul><li>Uno</li><li>Due &amp; tre</li></ul><style>p{}</style>')).toBe('- Uno\n- Due & tre');
  });
});
