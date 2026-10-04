import { describe, expect, it, vi } from 'vitest';
import { jsPDF } from 'jspdf';
import { PNG_1X1 as PNG, pdfPaintsImage } from './helpers/pdfImages';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));

const { renderCvPdf, renderLetterPdf, pdfRendererMode } = await import('../functions/src/assistedApplicationPdfRenderer.js');
const { buildCvDocument } = await import('../functions/src/assistedApplicationCvDocument.js');
const { sanitizeTailoredCv } = await import('../functions/src/assistedApplicationTailoredCv.js');
const { applyLetterConventions, letterEnclosures, letterPdfBlocks, parseLetterText, sanitizeProfile } = await import('../functions/src/assistedApplicationAiDraftCore.js');
const { checkPdfForAts } = await import('../scripts/assisted-application/lib/pdf-ats-check.mjs');

// Invented candidates of the study 2026-10-02 (report-cv-lettera).
const CASES = [
  {
    key: 'apprentice_de', language: 'de', type: 'apprentice', sector: 'it', maxPages: 1,
    identity: { name: 'Luka Kovačević', email: 'bewerbung-7f3k@frontaliereticino.ch', phone: '+41 79 555 01 23' },
    title: 'Lernende/r Informatiker/in EFZ Applikationsentwicklung',
    profile: {
      dateOfBirth: '14. März 2010', nationality: 'Schweiz / Kroatien', address: { street: 'Musterweg 12', postalCode: '8400', city: 'Winterthur' },
      languages: [{ language: 'Deutsch', level: 'Muttersprache' }, { language: 'Englisch', level: 'B1' }], skills: ['Python', 'Scratch'],
      experience: [
        { role: 'Informatiker EFZ Applikationsentwicklung', employer: 'Muster Informatik AG', location: 'Winterthur', start: '04.2026', end: '04.2026', kind: 'trial_apprenticeship', highlights: ['Kleine Webseite mit HTML und CSS gebaut'] },
        { role: 'Zeitungsverträger', employer: 'Regionalzeitung Winterthur', start: '2025', end: 'heute', kind: 'side_job', highlights: ['Jeden Samstag 80 Zeitungen verteilt'] },
      ],
      education: [{ degree: 'Sekundarschule A', institution: 'Schulhaus Rychenberg', start: '2023', end: '2026' }],
      aptitudeTests: [{ name: 'Multicheck ICT', date: 'März 2026', results: 'Schulisches Potenzial 78 %' }],
      interests: ['Fussball', 'Gitarre'], references: [{ name: 'Herr Peter Muster', role: 'Klassenlehrer', organisation: 'Schulhaus Rychenberg', contact: '+41 52 555 00 00' }],
    },
    // The birth date the Swiss way (decision 5 of the personal data).
    facts: ['Luka Kovačević', '14.03.2010', 'Muster Informatik AG', 'Regionalzeitung Winterthur', '80 Zeitungen', '78 %', 'Herr Peter Muster', '04.2026'],
    headings: ['PERSÖNLICHE ANGABEN', 'SCHULBILDUNG'],
  },
  {
    key: 'nurse_fr', language: 'fr', type: 'qualified', sector: 'health', maxPages: 2,
    identity: { name: 'Élodie Marchetti', email: 'candidature-2q9x@frontaliereticino.ch', phone: '+33 6 55 55 01 02' },
    title: 'Infirmier/ère diplômé/e', summary: "Infirmière en médecine interne depuis 2019, référente douleur, diplôme reconnu par la Croix-Rouge suisse (CRS).",
    profile: {
      headline: 'Infirmière', workPermit: 'Permis G (frontalière)', availability: 'Préavis de 2 mois', location: 'Annemasse (F)',
      languages: [{ language: 'Français', level: 'langue maternelle' }, { language: 'Italien', level: 'B2' }],
      experience: [
        { role: 'Infirmière en médecine interne', employer: 'Centre Hospitalier Exemple', location: 'Annecy', start: '09.2019', end: "aujourd'hui", kind: 'job', highlights: ['Prise en charge de 10 à 12 patients par poste', "Référente douleur de l'unité depuis 2022"] },
        { role: 'Infirmière remplaçante', employer: 'Agence Intérim Santé Exemple', start: '2018', end: '2019', kind: 'job', highlights: ['Missions en EHPAD et en chirurgie'] },
      ],
      education: [{ degree: "Diplôme d'État d'infirmier", institution: 'IFSI Exemple', start: '2015', end: '2018' }],
      recognitions: [{ title: 'Reconnaissance du diplôme par la Croix-Rouge suisse (CRS)', issuer: 'CRS', date: '2024' }],
    },
    facts: ['Élodie Marchetti', 'Permis G (frontalière)', 'Centre Hospitalier Exemple', '10 à 12 patients', 'Croix-Rouge suisse', "09.2019 – aujourd'hui"],
    headings: ['DONNÉES PERSONNELLES', 'PROFIL'],
  },
  {
    key: 'developer_it', language: 'it', type: 'qualified', sector: 'it', maxPages: 2,
    identity: { name: 'Marco Bianchi', email: 'candidatura-8h2m@frontaliereticino.ch', phone: '+39 333 555 0101' },
    title: 'Sviluppatore full-stack', summary: 'Sviluppatore full-stack con 6 anni di esperienza su applicazioni web in TypeScript, React e Node.js.',
    profile: {
      headline: 'Sviluppatore full-stack', location: 'Como (I)', linkedin: 'linkedin.com/in/marco-bianchi-example', website: 'github.com/marcob-example',
      languages: [{ language: 'Italiano', level: 'madrelingua' }, { language: 'Inglese', level: 'C1' }, { language: 'Tedesco', level: 'B1' }],
      experience: [
        { role: 'Sviluppatore full-stack', employer: 'Esempio Software Srl', location: 'Milano', start: '03/2021', end: 'oggi', kind: 'job', highlights: ['Portale B2B in React e Node.js usato da 400 clienti', 'Tempo di build ridotto del 40% con Docker multi-stage'] },
        { role: 'Sviluppatore front-end', employer: 'Agenzia Web Esempio', location: 'Como', start: '09/2019', end: '02/2021', kind: 'job', highlights: ['Siti e-commerce per 15 clienti'] },
      ],
      education: [{ degree: 'Laurea in Informatica', institution: "Università degli Studi dell'Insubria", start: '2016', end: '2019' }],
      projects: [{ name: 'timesheet', url: 'github.com/marcob-example/timesheet', description: 'App open source per fogli ore in TypeScript' }],
    },
    facts: ['Marco Bianchi', 'Esempio Software Srl', '400 clienti', '40%', '15 clienti', 'Insubria', 'github.com/marcob-example', '03.2021 – oggi'],
    headings: ['PROFILO', 'ESPERIENZA PROFESSIONALE'],
  },
];

function documentOf(test: any) {
  const profile = sanitizeProfile(test.profile);
  const cv = sanitizeTailoredCv({ headline: test.title, summary: test.summary || '', competencies: [], experience: [], skills: profile.skills }, {
    profile, cvText: JSON.stringify(test.profile), language: test.language, type: test.type, sector: test.sector, title: test.title,
  });
  return { profile, document: buildCvDocument(cv, { identity: test.identity, profile, language: test.language, type: test.type, sector: test.sector }) };
}

describe('tailored CV PDFs pass the ATS checks (Typst, embedded font)', () => {
  for (const test of CASES) {
    it(`${test.key}: text, fonts, no icons, name first, no date column, heading first, facts, pages`, async () => {
      const { document } = documentOf(test);
      const { pdf, renderer } = await renderCvPdf(document);
      expect(renderer).toBe('typst');
      const check = await checkPdfForAts(pdf, { name: test.identity.name, facts: test.facts, headings: test.headings, maxPages: test.maxPages });
      expect(check.failures).toEqual([]);
    }, 60_000);
  }

  // P4 (owner decisions of 2026-10-03): the personal data the candidate gave, as the CV prints them, in the real render.
  it('prints the status, the nationality and the birth date the candidate gave in the PDF’s text', async () => {
    const profile = {
      ...sanitizeProfile({
        headline: 'Pflegefachfrau', location: 'Como (I)', dateOfBirth: '1998-03-12', nationality: 'italiana', languages: [{ language: 'Deutsch', level: 'C1' }],
        experience: [{ role: 'Pflegefachfrau', employer: 'Ospedale Civico', location: 'Lugano', start: '2019', end: '2025', kind: 'job', highlights: ['Akutpflege auf einer Station mit 24 Betten'] }],
      }),
      // Derived at every read (candidateWithEdits), never kept by sanitizeProfile.
      permitStatus: 'permit_b',
    };
    const cv = sanitizeTailoredCv({ headline: 'Pflegefachfrau', summary: 'Pflegefachfrau mit Erfahrung in der Akutpflege.', competencies: [], experience: [], skills: [] }, {
      profile, cvText: JSON.stringify(profile), language: 'de', type: 'qualified', sector: 'health', title: 'Pflegefachfrau',
    });
    const identity = { name: 'Giulia Verdi', email: 'bewerbung-4k2m@frontaliereticino.ch', phone: '+39 333 555 0199' };
    const { pdf, renderer } = await renderCvPdf(buildCvDocument(cv, { identity, profile, language: 'de', type: 'qualified', sector: 'health' }));
    expect(renderer).toBe('typst');
    const check = await checkPdfForAts(pdf, { name: identity.name, facts: ['Aufenthaltsbewilligung B', 'Italien (EU)', '12.03.1998'], headings: ['PERSÖNLICHE ANGABEN'] });
    expect(check.failures).toEqual([]);
  }, 60_000);

  it('catches what the study found: a standard font not embedded, a date column', async () => {
    const { document } = documentOf(CASES[0]);
    const legacy = await renderCvPdf(document, { mode: 'legacy' });
    expect(legacy.renderer).toBe('legacy');
    expect((await checkPdfForAts(legacy.pdf, { name: 'Luka Kovacevic' })).failures).toContain('fonts');
    const column = new jsPDF();
    column.text('03/2021 – oggi', 20, 40);
    column.text('Sviluppatore full-stack, Esempio Software Srl', 80, 40);
    column.text('Portale B2B in React e Node.js usato da 400 clienti e altro testo per superare la soglia minima di testo. '.repeat(3), 20, 60, { maxWidth: 170 });
    const failures = (await checkPdfForAts(new Uint8Array(column.output('arraybuffer')))).failures;
    expect(failures.some((failure: string) => failure.startsWith('dateColumn'))).toBe(true);
  }, 60_000);

  it('says whether the PDF carries the photo, and drops a photo Typst cannot read instead of its own layout', async () => {
    const { document } = documentOf(CASES[1]);
    expect(await renderCvPdf(document)).toMatchObject({ renderer: 'typst', photo: false });
    const printed = await renderCvPdf({ ...document, photo: PNG, photoType: 'png' });
    expect(printed).toMatchObject({ renderer: 'typst', photo: true });
    expect(await pdfPaintsImage(printed.pdf)).toBe(true);
    // An unreadable image costs the image only: compiled once more without it, the embedded font kept.
    const logged: string[] = [];
    const unreadable = await renderCvPdf({ ...document, photo: Buffer.from('not an image'), photoType: 'png' }, { log: (...args: unknown[]) => { logged.push(args.join(' ')); } });
    expect(unreadable).toMatchObject({ renderer: 'typst', photo: false });
    expect(logged).toHaveLength(1);
    expect(await pdfPaintsImage(unreadable.pdf)).toBe(false);
    expect((await checkPdfForAts(unreadable.pdf, { name: CASES[1].identity.name, facts: CASES[1].facts, headings: CASES[1].headings })).failures).toEqual([]);
    // The standard-font writer prints no photo, and says so.
    const legacy = await renderCvPdf({ ...document, photo: PNG, photoType: 'png' }, { mode: 'legacy' });
    expect(legacy).toMatchObject({ renderer: 'legacy', photo: false });
    expect(await pdfPaintsImage(legacy.pdf)).toBe(false);
  }, 60_000);

  it('falls back to the standard-font writer when Typst fails, and obeys the Remote Config switch', async () => {
    const { document } = documentOf(CASES[1]);
    // A document Typst cannot compile, with or without the photo.
    const broken = await renderCvPdf({ ...document, language: 'not a language', photo: PNG, photoType: 'png' }, { log: () => {} });
    expect(broken).toMatchObject({ renderer: 'legacy', photo: false });
    expect(broken.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await pdfRendererMode({ env: { ASSISTED_APPLICATION_PDF_RENDERER: 'legacy' } })).toBe('legacy');
    expect(await pdfRendererMode({ env: {} })).toBe('typst');
    expect(await pdfRendererMode({ env: { K_SERVICE: 'x' }, readConfig: async () => 'legacy' })).toBe('legacy');
  }, 60_000);
});

// Where each text starts on the page, in mm from the left edge (pdf.js text items).
async function textStarts(pdf: Uint8Array) {
  const { getDocumentProxy } = await import('unpdf');
  const document = await getDocumentProxy(new Uint8Array(pdf));
  const items = (await (await document.getPage(1)).getTextContent()).items as any[];
  return items.filter((item) => 'str' in item && item.str.trim()).map((item) => ({ text: item.str as string, mm: item.transform[4] * 25.4 / 72 }));
}
const startOf = (items: Array<{ text: string, mm: number }>, text: string) => items.filter((item) => item.text.includes(text)).at(-1)?.mm ?? -1;

const ENGLISH = {
  key: 'developer_en', language: 'en', identity: { name: 'Marco Bianchi', email: 'candidatura-8h2m@frontaliereticino.ch', phone: '+39 333 555 0101' },
  title: 'Full-stack developer', profile: { location: 'Como (I)' },
};

describe('letter PDFs (Typst): Swiss layout per language', () => {
  for (const test of [...CASES, ENGLISH]) {
    it(`${test.key}: embedded font, sender first, salutation, closing and enclosures`, async () => {
      const profile = sanitizeProfile(test.profile);
      const letter = applyLetterConventions({ paragraphs: ['Erster Absatz mit 81 % und CHF 80\'000.', 'Zweiter Absatz.'] }, { language: test.language, contactPerson: 'Frau Sandra Beispiel' });
      const blocks = letterPdfBlocks({
        identity: test.identity, profile, posting: { contactPerson: 'Frau Sandra Beispiel', streetAddress: 'Technikumstrasse 9', postalCode: '8400', location: 'Winterthur' },
        companyName: 'Alpina Systems AG', language: test.language, letter, title: test.title, now: new Date(), enclosures: letterEnclosures(test.language, ['Zeugnisse']),
      });
      const { pdf, renderer } = await renderLetterPdf(blocks);
      expect(renderer).toBe('typst');
      // The label carries its colon; the extracted text has plain spaces where the letter has protected ones.
      const enclosureLine = `${blocks.enclosuresLabel} ${blocks.enclosures.join(', ')}`.replace(/\s+/g, ' ');
      const check = await checkPdfForAts(pdf, { name: test.identity.name, facts: [letter.salutation, letter.closing, enclosureLine, "80'000"], maxPages: 1 });
      expect(check.failures).toEqual([]);
    }, 60_000);
  }

  it('prints each formula as the sources print it, a closing sentence in the body and a bare closing above the signature', async () => {
    const render = async (language: string, letter: any, enclosures: string[] = []) => {
      const blocks = letterPdfBlocks({
        identity: CASES[1].identity, profile: sanitizeProfile({ location: 'Viale Varese 5, Como' }), posting: { contactPerson: 'Madame Claire Dupont' },
        companyName: 'Clinique Exemple SA', language, letter, title: 'infirmière', now: new Date(Date.UTC(2026, 2, 1, 12)), enclosures,
      });
      const { pdf } = await renderLetterPdf(blocks);
      return { text: (await checkPdfForAts(pdf, { maxPages: 1 })).text, starts: await textStarts(pdf) };
    };
    const left = (mm: number) => Math.abs(mm - 25) < 1;
    const right = (mm: number) => Math.abs(mm - 117) < 1;

    const french = await render('fr', applyLetterConventions({ paragraphs: ['Vous trouverez ci-joint mon dossier.'] }, { language: 'fr', contactPerson: 'Madame Claire Dupont' }), ['CV']);
    for (const fact of ['Como, le 1er mars 2026', 'Candidature au poste d’infirmière', 'Madame,', 'Je vous prie de recevoir, Madame, mes meilleures salutations.', 'Annexe : CV']) {
      expect(french.text).toContain(fact);
    }
    expect(left(startOf(french.starts, 'Je vous prie'))).toBe(true);
    expect(right(startOf(french.starts, 'Élodie Marchetti'))).toBe(true);

    const italian = await render('it', applyLetterConventions({ paragraphs: ['Le scrivo per il posto di infermiera.'] }, { language: 'it' }), ['Curriculum vitae', 'Diplomi']);
    for (const fact of ['Como, 1° marzo 2026', 'Gentili signore e signori,', 'Le scrivo per il posto di infermiera.', 'Allegati: Curriculum vitae, Diplomi']) expect(italian.text).toContain(fact);
    expect(right(startOf(italian.starts, 'Cordiali saluti'))).toBe(true);
    // The candidate deleted the closing: the last paragraph stays in the body, not in the narrow right column.
    const deleted = await render('it', parseLetterText('Gentile signora Rossi,\n\nprimo paragrafo.\n\nResto a disposizione per un colloquio.'));
    expect(left(startOf(deleted.starts, 'Resto a disposizione'))).toBe(true);

    const english = await render('en', applyLetterConventions({ paragraphs: ['I enclose my application.'] }, { language: 'en', contactPerson: 'Dr Anna Muster' }), ['CV']);
    for (const fact of ['Dear Dr Muster I enclose', 'Kind regards', 'Enclosures: CV']) expect(english.text).toContain(fact);
    expect(english.text).not.toContain('Dear Dr Muster,');
    expect(left(startOf(english.starts, 'Kind regards'))).toBe(true);
  }, 60_000);
});
