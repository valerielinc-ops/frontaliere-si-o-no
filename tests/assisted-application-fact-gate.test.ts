import { describe, expect, it, vi } from 'vitest';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));

const { buildFactIndex, checkGeneratedFacts, claimTokens } = await import('../functions/src/assistedApplicationAiFactCheck.js');
const {
  applyLetterConventions, checkDraftFacts, checkDraftTexts, letterEnclosures, letterQualityIssues, letterSalutation, swissTypography,
} = await import('../functions/src/assistedApplicationAiDraftCore.js');
const { checkTailoredCvFacts, groundedInCv, sanitizeTailoredCv } = await import('../functions/src/assistedApplicationTailoredCv.js');
const { normalizeText } = await import('../functions/src/assistedApplicationAts.js');
const { buildCoverLetterPdf, extractPdfText, wrapText } = await import('../functions/src/assistedApplicationAiDocuments.js');
const { mentionsVocabularyTool, vocabularyTools } = await import('../functions/src/lib/toolVocabulary.js');
const { letterForSubmission } = await import('../scripts/assisted-application/lib/submit.mjs');
const { enclosedDocumentLabels } = await import('../functions/src/assistedApplicationExtraDocuments.js');

// Synthetic candidates of the study 2026-10-02 (report-cv-lettera): invented people, invented postings.
const DEV = {
  text: 'Marco Bianchi\nSviluppatore con 6 anni di esperienza su applicazioni web.\n03/2021 – oggi Sviluppatore full-stack, Esempio Software Srl, Milano: '
    + 'sviluppo di un portale B2B in React e Node.js usato da 400 clienti; riduzione del tempo di build del 40% con Docker multi-stage; mentoring di 2 sviluppatori junior\n'
    + '09/2019 – 02/2021 Sviluppatore front-end, Agenzia Web Esempio, Como: siti e-commerce per 15 clienti; migrazione da jQuery a React\n'
    + 'Competenze: TypeScript, React, Node.js, PostgreSQL, Docker, Git\nLingue: italiano (madrelingua), inglese C1, tedesco B1',
  posting: 'Cerchiamo uno/a Sviluppatore/trice Full-Stack. Requisiti: almeno 5 anni di esperienza con TypeScript, React e Node.js; esperienza con PostgreSQL e Docker; '
    + 'conoscenza di Kubernetes e AWS costituisce un plus; tedesco B1. Permesso G o B.',
  order: ['Sviluppatore/trice Full-Stack (TypeScript) 100%', 'Esempio Fintech SA', 'Marco Bianchi'].join('\n'),
  answers: '',
  place: 'Lugano',
};
const NURSE = {
  text: 'Élodie Marchetti\nPermis G (frontalière) · Préavis de 2 mois\n09.2019 – aujourd\'hui Infirmière en médecine interne, Centre Hospitalier Exemple, Annecy: '
    + 'prise en charge de 10 à 12 patients par poste; référente douleur de l\'unité depuis 2022; encadrement de 6 étudiants infirmiers par an\n'
    + 'Reconnaissance du diplôme par la Croix-Rouge suisse (CRS), 2024\nCompétences: soins aigus, dossier patient informatisé (DPI)',
  posting: 'Nous recherchons un/e Infirmier/ère diplômé/e 80-100%. Profil: diplôme reconnu par la CRS, minimum 3 ans d\'expérience en soins aigus, maîtrise du DPI.',
  order: ['Infirmier/ère diplômé/e 80-100%', 'Clinique du Léman Exemple SA', 'Élodie Marchetti'].join('\n'),
  answers: '',
  place: 'Genève',
};
const APPRENTICE = {
  text: 'Luka Kovačević\nSekundarschule A, Schulhaus Rychenberg\n04.2026 Schnupperlehre Informatiker EFZ Applikationsentwicklung, Muster Informatik AG, Winterthur: '
    + '3 Tage im Entwicklungsteam, kleine Webseite mit HTML und CSS gebaut\nMulticheck ICT: Fachspezifische Fähigkeiten 81 %\n'
    + 'Kenntnisse: Python (Grundkenntnisse), Scratch, Microsoft Office\nSprachen: Deutsch, Kroatisch, Englisch B1',
  posting: 'Lehrstelle Informatiker/in EFZ Applikationsentwicklung. Du hast erste Erfahrungen mit Python oder JavaScript. Gute Leistungen in Mathematik und Englisch. '
    + 'Bewerbung mit Zeugnissen der letzten 3 Semester.',
  order: ['Lernende/r Informatiker/in EFZ Applikationsentwicklung', 'Alpina Systems AG', 'Luka Kovačević'].join('\n'),
  answers: '',
  place: 'Winterthur',
};

const verdict = (texts: Record<string, string>, sources: any) => {
  const result = checkDraftFacts(texts, sources);
  return { ok: result.ok, unsupported: result.unsupported.map((item: any) => `${item.kind}:${item.token}`), advisories: result.advisories.map((item: any) => `${item.kind}:${item.token}`) };
};

describe('closed tool vocabulary (career-ops + Reactive Resume, MIT)', () => {
  it('names the tools a shape rule cannot see, with their aliases', () => {
    expect(vocabularyTools('Deploy su Kubernetes e AWS; React Native, Postgres, SAP S/4 HANA, .NET').map((hit: any) => hit.name))
      .toEqual(['Kubernetes', 'AWS', 'React Native', 'PostgreSQL', 'SAP', '.NET']);
    expect(mentionsVocabularyTool('Esperienza con k8s', 'Kubernetes')).toBe(true);
    expect(mentionsVocabularyTool('MS Office avanzato', 'Excel')).toBe(true); // a suite backs its members
  });

  it('counts a name that is also an ordinary word only with its capitalisation', () => {
    expect(vocabularyTools('let us go, the spring of 2026, Maria R. Rossi, des Teams').length).toBe(0);
    expect(vocabularyTools('Backend in Go und Spring').map((hit: any) => hit.name)).toEqual(['Go', 'Spring']);
    expect(claimTokens('Ho usato Kubernetes e ISO 13485.').map((claim: any) => claim.token)).toEqual(['Kubernetes', 'ISO 13485']);
  });
});

describe('fact gate: the 17 cases of the study 2026-10-02', () => {
  it('passes the three good letters', () => {
    expect(verdict({ coverLetter: 'sviluppo applicazioni web in TypeScript, React e Node.js da 6 anni. In Esempio Software Srl ho sviluppato un portale B2B usato da 400 clienti e seguo 2 sviluppatori junior. Il mio tedesco è a livello B1.' }, DEV))
      .toMatchObject({ ok: true, unsupported: [] });
    expect(verdict({ coverLetter: 'Infirmière en médecine interne depuis 2019, je prends en charge 10 à 12 patients par poste. Mon diplôme est reconnu par la Croix-Rouge suisse depuis 2024.' }, NURSE))
      .toMatchObject({ ok: true, unsupported: [] });
    expect(verdict({ coverLetter: 'In meiner Schnupperlehre bei der Muster Informatik AG habe ich eine kleine Webseite mit HTML und CSS gebaut. Im Multicheck ICT habe ich 81 % erreicht. Ich möchte die Lehre als Informatiker EFZ beginnen.' }, APPRENTICE))
      .toMatchObject({ ok: true, unsupported: [] });
  });

  it('blocks a figure only the posting gives, unless the sentence quotes the requirement', () => {
    expect(verdict({ coverLetter: 'In Esempio Software Srl ho guidato un team di 5 sviluppatori.' }, DEV).unsupported).toEqual(['number:5']);
    expect(verdict({ coverLetter: "J'ai plus de 3 ans d'expérience en soins aigus." }, NURSE).unsupported).toEqual(['number:3']);
    expect(verdict({ coverLetter: 'Pur non avendo ancora i 5 anni di esperienza richiesti, lavoro ogni giorno con React.' }, DEV).ok).toBe(true);
    expect(verdict({ coverLetter: 'Je suis intéressée par ce poste à 80 %.' }, NURSE).ok).toBe(true); // the workload is in the order line
    // Outside the candidate's claims the posting still backs a figure ("why this company").
    expect(checkDraftFacts({ whyCompany: 'Cercate 5 anni di esperienza: il vostro team cresce.' }, DEV).ok).toBe(true);
    // Review of PR 10919: a requirement word alone does not make the posting's figure a quote.
    const bare = { text: '', answers: '', candidate: '', order: '', posting: '5 anni richiesti' };
    expect(checkDraftFacts({ coverLetter: 'Ho 5 anni di esperienza; sono gli anni richiesti.' }, bare).unsupported).toContainEqual(expect.objectContaining({ kind: 'number', token: '5' }));
    expect(verdict({ coverLetter: 'I do not have the 5 years this role requires yet.' }, DEV).ok).toBe(true);
    // The follow-up leaves in the candidate's name too.
    expect(verdict({ followup: 'Le ricordo che ho guidato un team di 5 sviluppatori.' }, DEV).unsupported).toEqual(['number:5']);
  });

  it('blocks a tool of the vocabulary the CV does not name, wherever the posting names it', () => {
    expect(verdict({ coverLetter: 'Uso quotidianamente Kubernetes e AWS in produzione.' }, DEV).unsupported).toEqual(['tool:Kubernetes', 'tool:AWS']);
    expect(verdict({ coverLetter: 'Ich programmiere gerne mit Python und JavaScript.' }, APPRENTICE).unsupported).toEqual(['tool:JavaScript']);
    expect(verdict({ coverLetter: 'Ho lavorato con Git e Docker.' }, DEV).ok).toBe(true);
    // Review of PR 10919: the job title is a name; it never backs a tool claimed outside it.
    const titled = { text: '', answers: '', candidate: '', order: 'Kubernetes Engineer', place: '', posting: 'Kubernetes Engineer' };
    expect(checkDraftFacts({ coverLetter: 'Uso quotidiano di Kubernetes.' }, titled).unsupported).toContainEqual(expect.objectContaining({ kind: 'tool', token: 'Kubernetes' }));
    expect(checkDraftFacts({ coverLetter: 'Mi candido come Kubernetes Engineer.' }, titled).ok).toBe(true);
  });

  it('blocks an employer or a job title no source names', () => {
    expect(verdict({ coverLetter: 'Ho lavorato presso Initech come Head of Engineering.' }, DEV).unsupported).toEqual(['employer:Initech', 'title:Head of Engineering']);
    expect(verdict({ coverLetter: 'In Initech Systems SA ho sviluppato un portale.' }, DEV).unsupported).toEqual(['employer:Initech Systems SA']);
    expect(verdict({ coverLetter: 'Ho lavorato in Esempio Software Srl come Sviluppatore full-stack.' }, DEV).ok).toBe(true);
    // German capitalises every noun: after "als" an unknown title is reported, not blocked.
    const de = verdict({ coverLetter: 'Ich arbeite als Teamleiter Entwicklung.' }, APPRENTICE);
    expect(de.ok).toBe(true);
    expect(de.advisories).toContain('title:Teamleiter Entwicklung');
  });

  it('reports a capitalised word only the posting has, without blocking it', () => {
    const result = verdict({ coverLetter: 'Ich habe gute Noten in Mathematik und Englisch. Gerne sende ich die Zeugnisse der letzten Semester.' }, APPRENTICE);
    expect(result.ok).toBe(true);
    expect(result.advisories).toEqual(expect.arrayContaining(['posting_echo:Mathematik', 'posting_echo:Semester']));
    expect(result.advisories).not.toContain('posting_echo:Englisch'); // the CV names it
  });
});

describe('fact gate of the tailored CV', () => {
  const profile = {
    headline: 'Sviluppatore web', location: 'Como',
    experience: [
      { role: 'Sviluppatore full-stack', employer: 'Esempio Software Srl', location: 'Milano', start: '03/2021', end: 'oggi', highlights: ['Portale B2B in React e Node.js usato da 400 clienti', 'Build ridotta del 40% con Docker multi-stage'] },
      { role: 'Sviluppatore front-end', employer: 'Agenzia Web Esempio', location: 'Como', start: '09/2019', end: '02/2021', highlights: ['Siti e-commerce per 15 clienti'] },
    ],
    education: [], certifications: [], languages: [], skills: ['TypeScript', 'React', 'Node.js', 'PostgreSQL', 'Docker', 'Git'],
  };
  const raw = (patch: any = {}) => ({
    headline: 'Sviluppatore full-stack', summary: 'Sviluppatore full-stack con React e Node.js.', competencies: ['React', 'Git'],
    experience: [{ index: 0, bullets: ['Portale B2B in React usato da 400 clienti'] }, { index: 1, bullets: ['Siti e-commerce per 15 clienti'] }],
    skills: ['TypeScript', 'Git', 'Kubernetes'],
    sectionTitles: { summary: 'Profilo', competencies: 'Competenze chiave', experience: 'Esperienza', education: 'Formazione', certifications: 'Certificazioni', skills: 'Competenze tecniche', languages: 'Lingue' },
    ...patch,
  });

  it('checks the tools of the headline and the summary (claimSources)', () => {
    const cv = sanitizeTailoredCv(raw({ summary: 'Sviluppatore full-stack, uso quotidiano di Kubernetes e AWS in produzione.' }), { profile, cvText: DEV.text, language: 'it' });
    const facts = checkTailoredCvFacts(cv, { cvText: DEV.text, profile, answers: {} });
    expect(facts.ok).toBe(false);
    expect(facts.unsupported.map((item: any) => item.token)).toEqual(['Kubernetes', 'AWS']);
  });

  it('keeps the role’s own highlights when a bullet names a vocabulary tool or another role’s figure', () => {
    const tool = sanitizeTailoredCv(raw({ experience: [{ index: 0, bullets: ['Deploy su Kubernetes con Docker multi-stage'] }] }), { profile, cvText: DEV.text, language: 'it' });
    expect(tool.experience[0]).toMatchObject({ rewritten: false, bullets: profile.experience[0].highlights });
    // "15 clienti" belongs to the front-end job: moved to the full-stack one it is not trusted (idea of Resume-Matcher).
    const moved = sanitizeTailoredCv(raw({ experience: [{ index: 0, bullets: ['Portale B2B usato da 15 clienti'] }] }), { profile, cvText: DEV.text, language: 'it' });
    expect(moved.experience[0].rewritten).toBe(false);
    expect(moved.dropped).toContain('Portale B2B usato da 15 clienti');
    expect(sanitizeTailoredCv(raw(), { profile, cvText: DEV.text, language: 'it' }).experience.map((role: any) => role.rewritten)).toEqual([true, true]);
  });

  it('grounds a short tool the CV names ("Git") and a tool named by an alias ("k8s")', () => {
    const cv = sanitizeTailoredCv(raw(), { profile, cvText: DEV.text, language: 'it' });
    expect(cv.skills).toEqual(['TypeScript', 'Git']);
    expect(cv.dropped).toContain('Kubernetes');
    const normalized = ` ${normalizeText('Orchestrazione container con k8s e Postgres.')} `;
    expect(groundedInCv('Kubernetes', normalized, 'Orchestrazione container con k8s e Postgres.')).toBe(true);
    expect(groundedInCv('PostgreSQL', normalized, 'Orchestrazione container con k8s e Postgres.')).toBe(true);
    expect(groundedInCv('AWS', normalized, 'Orchestrazione container con k8s e Postgres.')).toBe(false);
  });
});

describe('Swiss letter conventions in code', () => {
  it('writes the salutation from the honorific the posting gives, never from the first name', () => {
    expect(letterSalutation('de', 'Frau Sandra Beispiel')).toBe('Sehr geehrte Frau Beispiel');
    expect(letterSalutation('de', 'Herr Dr. Peter Muster')).toBe('Sehr geehrter Herr Muster');
    expect(letterSalutation('de', 'Sandra Beispiel')).toBe('Guten Tag Sandra Beispiel');
    expect(letterSalutation('de', '')).toBe('Sehr geehrte Damen und Herren');
    expect(letterSalutation('fr', 'Madame Dupont')).toBe('Madame,');
    expect(letterSalutation('fr', 'Claude Dupont')).toBe('Madame, Monsieur,');
    expect(letterSalutation('it', 'Signora Laura Esempio')).toBe('Gentile signora Esempio,');
    expect(letterSalutation('it', 'Laura Esempio')).toBe('Gentile Laura Esempio,');
    expect(letterSalutation('it', '')).toBe('Gentili signore, egregi signori,');
    expect(letterSalutation('it', 'Signora Laura de Luca')).toBe('Gentile signora de Luca,');
    expect(letterSalutation('de', 'Herr Peter von Arx, Leiter HR')).toBe('Sehr geehrter Herr von Arx');
  });

  it('sets the closing, the lowercase start in Italian and the Swiss typography', () => {
    const it_ = applyLetterConventions({ salutation: 'Egregio Signore', paragraphs: ['Sono sviluppatore da 6 anni.', 'Altro.'], closing: 'Distinti saluti' }, { language: 'it', contactPerson: 'Laura Esempio' });
    expect(it_).toMatchObject({ salutation: 'Gentile Laura Esempio,', closing: 'Cordiali saluti' });
    expect(it_.paragraphs[0]).toBe('sono sviluppatore da 6 anni.');
    // A company name stays capitalised.
    expect(applyLetterConventions({ paragraphs: ['Esempio Fintech SA cerca…'] }, { language: 'it' }).paragraphs[0]).toBe('Esempio Fintech SA cerca…');
    const de = applyLetterConventions({ paragraphs: ['Ich habe 81 % erreicht und grosse Freude. Grüße ändern sich: Straße.'] }, { language: 'de', contactPerson: '' });
    expect(de.paragraphs[0]).toBe('Ich habe 81 % erreicht und grosse Freude. Grüsse ändern sich: Strasse.');
    expect(de.closing).toBe('Freundliche Grüsse');
    expect(swissTypography('Lohn CHF 80000, 40 %', 'fr')).toBe('Lohn CHF 80000, 40 %');
  });

  it('checks the letter in code: filler phrases and length are advisories, a placeholder blocks', () => {
    const filler = letterQualityIssues('Hiermit bewerbe ich mich als Informatiker. Ich würde mich freuen.', 'de');
    expect(filler.map((issue: any) => `${issue.severity}:${issue.kind}`)).toEqual(['advisory:filler_phrase', 'advisory:filler_phrase', 'advisory:too_short']);
    const texts = { coverLetter: `Gentile [Nome],\n\n${'parola '.repeat(200)}` };
    const result = checkDraftTexts(texts, DEV, { language: 'it' });
    expect(result.ok).toBe(false);
    expect(result.unsupported.map((item: any) => item.kind)).toContain('placeholder');
    expect(letterEnclosures('de', ['Zeugnisse der letzten 3 Semester'])).toEqual(['Lebenslauf', 'Zeugnisse der letzten 3 Semester']);
  });
});

describe('letter PDF', () => {
  it('writes a letter the standard font lacks with its base letter, never "?"', async () => {
    const pdf = buildCoverLetterPdf({ senderLines: ['Luka Kovačević', 'Łódź'], paragraphs: ['Test'], signature: 'Luka Kovačević', enclosuresLabel: 'Beilagen', enclosures: ['Lebenslauf', 'Multicheck ICT'] });
    const text = await extractPdfText(pdf);
    expect(text).toContain('Luka Kovacevic');
    expect(text).toContain('Lódz'); // ó is in WinAnsi, ź is not
    expect(text).not.toContain('?');
    expect(text).toContain('Beilagen: Lebenslauf, Multicheck ICT');
  });

  it('never breaks a line inside a no-break space', () => {
    const lines = wrapText(`${'Wort '.repeat(14)}81 % erreicht`, 10.5, 120);
    expect(lines.some((line: string) => line.endsWith('81'))).toBe(false);
  });
});

describe('letter at submission', () => {
  const bucket = (stored: string) => ({ file: () => ({ download: async () => [Buffer.from(stored)] }) });
  const order = { applicantName: 'Marco Bianchi', companyName: 'Esempio Fintech SA', jobTitle: 'Sviluppatore', locale: 'it' };

  it('rebuilds the letter with the documents that leave, or sends the stored one of an older draft', async () => {
    const draft = {
      language: 'it', coverLetter: { salutation: 'Gentile Laura Esempio,', paragraphs: ['sviluppo applicazioni web.'], closing: 'Cordiali saluti' },
      letterAddress: { contactPerson: 'Laura Esempio', streetAddress: 'Via Esempio 3', postalCode: '6900', location: 'Lugano' },
      requiredDocuments: [{ id: 'diplomi', label: 'Diplomi', kind: 'diploma', required: true }],
      job: { title: 'Sviluppatore' }, profile: { location: 'Como' },
    };
    const flow = { documents: { diplomi: { files: [{ key: 'assisted-application-uploads/order_X/diplomi.pdf', name: 'diplomi.pdf', detectedType: 'pdf' }] } } };
    const rebuilt = await letterForSubmission({ bucket: bucket('stored'), order, orderId: 'order_X', draft, flow, nowMs: Date.now() });
    const text = await extractPdfText(rebuilt);
    expect(text).toContain('Via Esempio 3');
    expect(text).toContain('Allegati: Curriculum vitae, Diplomi');
    // Review of PR 10919: a waived document (no file) is not listed.
    const waived = await extractPdfText(await letterForSubmission({ bucket: bucket('stored'), order, orderId: 'order_X', draft, flow: { documents: { diplomi: { waivedAt: 1 } } }, nowMs: Date.now() }));
    expect(waived).toContain('Allegati: Curriculum vitae');
    expect(waived).not.toContain('Diplomi');
    expect(enclosedDocumentLabels({ requiredDocuments: [{ id: 'diploma', label: 'Diploma', kind: 'diploma', required: true }] }, null, 'order-1')).toEqual(['Diploma']);
    expect(enclosedDocumentLabels({ requiredDocuments: [{ id: 'diploma', label: 'Diploma', kind: 'diploma', required: true }] }, { documents: { diploma: { waivedAt: 1 } } }, 'order-1')).toEqual([]);
    const older = await letterForSubmission({ bucket: bucket('stored'), order, orderId: 'order_X', draft: { ...draft, letterAddress: undefined, coverLetterPdfKey: 'k' }, flow: {}, nowMs: Date.now() });
    expect(older.toString()).toBe('stored');
  });
});

describe('index without options keeps the old behaviour (interview prep, follow-ups)', () => {
  it('lets any source back a figure and checks no tool', () => {
    const index = buildFactIndex([DEV.text, DEV.posting]);
    expect(checkGeneratedFacts({ answer: 'Il team cerca 5 anni di esperienza con Kubernetes.' }, index)).toEqual({ ok: true, unsupported: [], advisories: [] });
  });
});
