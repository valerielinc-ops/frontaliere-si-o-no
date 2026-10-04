import { describe, expect, it, vi } from 'vitest';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));

const { buildFactIndex, checkGeneratedFacts, claimTokens } = await import('../functions/src/assistedApplicationAiFactCheck.js');
const {
  applicationEmailText, applyLetterConventions, checkDraftFacts, checkDraftTexts, enclosuresLabel, isBareClosing, letterEnclosures, letterPdfBlocks,
  letterQualityIssues, letterSalutation, letterText, localityOf, parseLetterText, printedTitles, sanitizeProfile, swissTypography,
} = await import('../functions/src/assistedApplicationAiDraftCore.js');
const { applicationEmailSubject, formatLetterDate, letterPlaceDate, letterSubject } = await import('../functions/src/assistedApplicationAiPrompts.js');
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

describe('names quoted whole', () => {
  it('takes the posting’s title for a name whatever its apostrophes, middle dots and hyphens', () => {
    // A real draft of 2026-10-03: the title has «d'opérateur·trice», the generated letter «d’opérateur·trice». The
    // title's own «CFC» (the diploma the apprenticeship leads to) was taken for a skill the CV does not show.
    const apprentice = {
      text: 'Noé Exemple\nÉcole secondaire, Annemasse\nStage de 3 jours au support informatique, Atelier Exemple Sàrl\nCompétences: Windows, Microsoft Office',
      posting: "Apprentissage d'opérateur∙trice en informatique CFC. Motivé∙e par un apprentissage ? Bulletins des trois dernières années scolaires.",
      order: ["Apprentissage d'opérateur·trice en informatique CFC", 'Manufacture Exemple SA', 'Noé Exemple'].join('\n'),
      answers: '',
      place: 'Genève',
    };
    const quoted = 'L’apprentissage d’opérateur·trice en informatique CFC chez Manufacture Exemple SA correspond à mon projet.';
    expect(verdict({ coverLetter: quoted, emailBody: quoted, motivationShort: quoted }, apprentice)).toMatchObject({ ok: true, unsupported: [] });
    // The posting's own middle dot, a straight apostrophe, a line break inside the title: the same name.
    expect(verdict({ coverLetter: "L'apprentissage d'opérateur∙trice en\ninformatique CFC m’intéresse." }, apprentice).unsupported).toEqual([]);
    // Outside the title the same letters are still the candidate's claim.
    expect(verdict({ coverLetter: 'Je suis titulaire d’un CFC.' }, apprentice).unsupported).toContain('tool:CFC');
    expect(verdict({ coverLetter: 'Opérateur en informatique CFC depuis 2020.' }, apprentice).unsupported).toContain('tool:CFC');

    const technician = {
      text: 'Dario Ferri\nTecnico di sistemi, Esempio Servizi Srl, Como\nCompetenze: Windows Server, Linux',
      posting: 'Cerchiamo un Tecnico SAP-HANA 100%.',
      order: ['Tecnico SAP-HANA 100%', 'Esempio Sistemi SA', 'Dario Ferri'].join('\n'),
      answers: '',
      place: 'Lugano',
    };
    // A non-breaking hyphen (U+2011) or an en dash in the quote is the title's hyphen.
    expect(verdict({ coverLetter: 'Mi candido per la posizione di Tecnico SAP‑HANA 100%.' }, technician).unsupported).toEqual([]);
    expect(verdict({ coverLetter: 'Mi candido per la posizione di Tecnico SAP–HANA 100%.' }, technician).unsupported).toEqual([]);
    expect(verdict({ coverLetter: 'Lavoro ogni giorno con SAP.' }, technician).unsupported).toContain('tool:SAP');
  });
});

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

// A real order of 2026-10-03 (a hotel concierge posting): six flags, nothing invented. An invented person here.
describe('fact gate: false alarms of 2026-10-03', () => {
  const CONSULTANT = {
    // The PDF's text layer glues the level to the next word of its table ("B1Intermedio:").
    text: 'Dario Ferri\nConsulente assicurativo e previdenziale, Vesta, Varese, 2019 – 2024\nConsulente finanziario, Studio Alfa, Como, 2015 – 2019\n'
      + 'Addetto alla ristorazione e al catering, 2010 – 2015\nCompetenze: contatto con i clienti, strumenti digitali\n'
      + 'Lingue\nItaliano\nLINGUA MADRE\nInglese\nB1Intermedio:\nFrancese\nB1Intermedio:\nTedesco\nB1Intermedio:',
    posting: 'Concierge (m/w/d). Several years of experience as a Concierge within the 5-star hotel industry. Sound knowledge and practical experience with LQA and Forbes standards. '
      + 'Business fluent German and English. Excellent knowledge of the Engadin region, or the motivation to acquire it quickly.',
    order: ['Concierge (m/w/d)', 'Grand Hotel Esempio', 'Dario Ferri'].join('\n'),
    answers: '',
    place: 'Pontresina',
  };
  const LETTER = 'I worked as an insurance and pension consultant at Vesta. Previously, I was an insurance and financial consultant. '
    + 'My languages include English, German and French at B1 intermediate level. '
    + 'I am motivated to get to know the Engadin quickly and to learn the hotel\'s LQA and Forbes standards.';
  const SHORT = 'I bring client-facing and service-coordination skills, as well as English, German and French at B1 level. I am motivated to learn the Engadin and the hotel\'s LQA and Forbes standards.';

  it('passes the honest letter: a level glued in the CV, a name before a new sentence, languages, a standard to learn', () => {
    expect(verdict({ coverLetter: LETTER, motivationShort: SHORT }, CONSULTANT)).toMatchObject({ ok: true, unsupported: [] });
  });

  it('still blocks the same words when they are a claim', () => {
    // The standard claimed as experience, not as something to learn.
    expect(verdict({ coverLetter: 'I have applied the LQA and Forbes standards for years.' }, CONSULTANT).unsupported).toContain('tool:LQA');
    // A level the CV does not give, glued or not ("B1Intermedio" never backs a C1, nor a B12).
    expect(verdict({ coverLetter: 'I speak German at C1 level.' }, CONSULTANT).unsupported).toContain('tool:C1');
    expect(verdict({ coverLetter: 'I am certified B12.' }, CONSULTANT).unsupported).toContain('tool:B12');
    // An employer no source names, before a new sentence too.
    expect(verdict({ coverLetter: 'I worked at Globex. Previously, I was a consultant.' }, CONSULTANT).unsupported).toContain('employer:Globex');
    // A job title the CV does not have stays a claim; a language the CV does not name stays one too.
    expect(verdict({ coverLetter: 'I worked as Head Concierge for years.' }, { ...CONSULTANT, order: 'x\ny\nDario Ferri' }).unsupported).toContain('title:Head Concierge');
    expect(verdict({ coverLetter: 'I worked as Japanese interpreter.' }, CONSULTANT).unsupported).toContain('title:Japanese');
  });

  it('backs a language only by its own name as a whole word, in any of the four languages', () => {
    // Review of #11020: the five-letter stem of "Chinese" is in "machine learning".
    const course = { ...CONSULTANT, text: `${CONSULTANT.text}\nCorso di machine learning, 2022` };
    expect(verdict({ coverLetter: 'I worked as Chinese interpreter.' }, course).unsupported).toContain('title:Chinese');
    expect(verdict({ coverLetter: 'I worked as Chinese interpreter.' }, { ...CONSULTANT, text: `${CONSULTANT.text}\nCinese\nA2` }).unsupported).toEqual([]);
    // The CV's own form of the name: «Français courant», «madrelingua italiana».
    expect(verdict({ coverLetter: 'I worked as French interpreter.' }, { ...CONSULTANT, text: 'Dario Ferri\nFrançais courant' }).unsupported).toEqual([]);
    expect(verdict({ coverLetter: 'I worked as Italian interpreter.' }, { ...CONSULTANT, text: 'Dario Ferri\nMadrelingua italiana' }).unsupported).toEqual([]);
    // A country is not its language.
    expect(verdict({ coverLetter: 'I worked as Russian interpreter.' }, { ...CONSULTANT, text: 'Dario Ferri\nNato in Russia' }).unsupported).toContain('title:Russian');
  });

  it('keeps an employer name that carries an abbreviation, and one after a sentence end', () => {
    const sources = { ...CONSULTANT, text: `${CONSULTANT.text}\nPortiere, Hotel St. Moritz Palace, 2008\nImpiegato, Alpina Systems AG, 2007` };
    expect(verdict({ coverLetter: 'I worked at Hotel St. Moritz Palace for a season.' }, sources).unsupported).toEqual([]);
    expect(verdict({ coverLetter: 'I left Varese. Alpina Systems AG was my first employer.' }, sources).unsupported).toEqual([]);
  });
});

// Close-out of 2026-10-03: two of the exemptions above let invented claims through. Invented people and postings;
// the sentences are the decisive ones of 360 probes in the four languages.
describe('fact gate: a gap counts only where it is said honestly', () => {
  // A CV that names none of the tools, a posting that names them all.
  const OPS = {
    text: 'Dario Ferri\nConsulente assicurativo, Vesta, Varese, 2019 – 2024\nCompetenze: contatto con i clienti, strumenti digitali, Docker',
    posting: 'We run Kubernetes on AWS and keep the books in SAP. Sound knowledge of LQA and Forbes standards. Terraform is a plus.',
    order: ['Consultant', 'Grand Hotel Esempio', 'Dario Ferri'].join('\n'),
    answers: '',
    place: 'Pontresina',
  };
  const flagged = (sentence: string) => verdict({ coverLetter: sentence }, OPS).unsupported;
  const gaps = (sentence: string) => {
    const result = verdict({ coverLetter: sentence }, OPS);
    return result.unsupported.length ? result.unsupported : result.advisories.filter((item: string) => item.startsWith('gap:'));
  };

  it('flags the six claims the looser gate passed', () => {
    expect(flagged('I learned Kubernetes and AWS in my last job.')).toEqual(['tool:Kubernetes', 'tool:AWS']);
    expect(flagged('I acquired solid SAP skills over six years.')).toEqual(['tool:SAP']);
    expect(flagged('Ich setze Kubernetes ohne Probleme produktiv ein.')).toEqual(['tool:Kubernetes']);
    expect(flagged('I have not yet had a failed deployment on AWS in production.')).toEqual(['tool:AWS']);
    expect(flagged('J\'ai pu apprendre Kubernetes dans mon dernier poste.')).toEqual(['tool:Kubernetes']);
    expect(flagged('Non ho difficoltà a lavorare con SAP.')).toEqual(['tool:SAP']);
  });

  it('passes the wish to learn it in the four languages, and reports it to the owner', () => {
    // The real sentence of 2026-10-03 and its equivalents; German sets the infinitive off with a comma.
    for (const sentence of [
      'I am motivated to get to know the Engadin quickly and to learn the hotel\'s LQA and Forbes standards.',
      'Sono motivato a conoscere rapidamente l’Engadina e a imparare gli standard LQA e Forbes dell’hotel.',
      'Ich bin motiviert, das Engadin rasch kennenzulernen und mir die LQA- und Forbes-Standards des Hotels anzueignen.',
      'Je suis motivée à découvrir rapidement l’Engadine et à apprendre les standards LQA et Forbes de l’hôtel.',
    ]) expect(gaps(sentence), sentence).toEqual(['gap:LQA']);
    for (const sentence of [
      'I look forward to learning Kubernetes on the job.',
      'Desidero acquisire competenze su Kubernetes.',
      'Gerne arbeite ich mich in Kubernetes ein.',
      'Je souhaite me former à Kubernetes.',
      // The experience the candidate wants to gain is no experience they have.
      'I am eager to gain experience with Kubernetes.',
      'Desidero acquisire esperienza con Kubernetes.',
      'Ich möchte Erfahrung mit Kubernetes sammeln.',
      'Je souhaite acquérir de l’expérience avec Kubernetes.',
    ]) expect(gaps(sentence), sentence).toEqual(['gap:Kubernetes']);
    expect(gaps('I am eager to learn Kubernetes and AWS.')).toEqual(['gap:Kubernetes', 'gap:AWS']);
    // Only for a tool the posting names: any other one is the candidate's claim, whatever the clause says.
    expect(flagged('I am eager to learn Ansible.')).toEqual(['tool:Ansible']);
  });

  it('passes the lack of it, said about the knowledge, the experience or the use', () => {
    for (const sentence of [
      'I have no experience with Kubernetes yet.',
      'Non ho ancora esperienza con Kubernetes.',
      'Non conosco ancora Kubernetes.',
      'Pur non avendo ancora esperienza con Kubernetes, imparo in fretta.',
      'Ich habe noch keine Erfahrung mit Kubernetes.',
      'Kubernetes habe ich bisher noch nicht eingesetzt.',
      'Je n’ai pas encore utilisé Kubernetes.',
      'Je n’ai pas encore d’expérience avec Kubernetes.',
      'I have not had the opportunity to work with Kubernetes yet.',
      'Non ho ancora avuto modo di lavorare con Kubernetes.',
      'Kubernetes ist für mich Neuland.',
      'Je n’ai pas encore eu l’occasion de travailler avec Kubernetes.',
    ]) expect(gaps(sentence), sentence).toEqual(['gap:Kubernetes']);
  });

  it('flags a past tense, a present use and a past modal before the learn verb', () => {
    for (const sentence of [
      'Ho imparato Kubernetes nel mio ultimo lavoro.',
      'Ich habe Kubernetes in meiner letzten Stelle gelernt.',
      'J\'ai appris Kubernetes dans mon dernier poste.',
      'I use Kubernetes every day.',
      'Uso Kubernetes ogni giorno.',
      'Ich nutze Kubernetes täglich.',
      'J\'utilise Kubernetes tous les jours.',
      'I had to learn Kubernetes on the job.',
      'I was able to learn Kubernetes quickly in my last role.',
      'Ho potuto imparare Kubernetes sul campo.',
      'Ich konnte Kubernetes in meiner letzten Stelle erlernen.',
      // The frame before the German comma is no wish, or it holds a claim of its own.
      'Ich hatte die Gelegenheit, Kubernetes zu erlernen.',
      'Ich bin motiviert und habe bereits begonnen, Kubernetes zu erlernen.',
      // What presupposes it.
      'I am eager to deepen my Kubernetes knowledge.',
      'Desidero approfondire la mia esperienza con Kubernetes.',
      'Desidero acquisire ulteriore esperienza con Kubernetes.',
      'Ich habe Erfahrung mit Kubernetes gesammelt.',
      // The noun of a field is no learn verb; nor is the tool the object of a verb that comes after it.
      'I am eager to apply machine learning on Kubernetes.',
      'Ich möchte maschinelles Lernen auf Kubernetes anwenden.',
      'I am keen to contribute Kubernetes automation and learn your domain.',
      'Voglio portare Kubernetes nel vostro team e imparare dal gruppo.',
    ]) expect(flagged(sentence), sentence).toEqual(['tool:Kubernetes']);
  });

  it('flags every tool of a sentence that mixes a gap with a claim, and a negation that does not say the lack', () => {
    // A sentence keeps its gaps only when every other piece of it is a template or names a backed tool.
    for (const sentence of [
      'I am eager to learn AWS and I use Kubernetes every day.',
      'Non ho esperienza con AWS ma lavoro con Kubernetes ogni giorno.',
      'Ich möchte AWS lernen und setze Kubernetes täglich ein.',
      'Je souhaite apprendre AWS et j\'utilise Kubernetes tous les jours.',
      'I have experience with Kubernetes and want to gain experience with AWS.',
    ]) expect(flagged(sentence), sentence).toEqual(expect.arrayContaining(['tool:Kubernetes', 'tool:AWS']));
    for (const sentence of [
      'I have not only used Kubernetes in production.',
      'I am not new to Kubernetes.',
      'I never lack ideas when I deploy on Kubernetes.',
      'Non uso solo Kubernetes.',
      'Non ho problemi con Kubernetes.',
      'Ich habe Kubernetes nicht nur eingesetzt, sondern auch geschult.',
      'Ich habe keine Probleme mit Kubernetes.',
      'Kubernetes ist für mich kein Neuland.',
      'Je ne manque pas d\'expérience avec Kubernetes.',
      'Je n\'ai pas de problème avec Kubernetes.',
    ]) expect(flagged(sentence), sentence).toEqual(['tool:Kubernetes']);
  });

  // Review of the close-out: a lack or a wish counts only for the tool it governs.
  it('flags the lack next to the claim of another tool, told with any verb; two tools the lack names are both a gap', () => {
    const both = (sentence: string) => {
      const result = verdict({ coverLetter: sentence }, OPS);
      return [...result.unsupported, ...result.advisories.filter((item: string) => item.startsWith('gap:'))];
    };
    for (const sentence of [
      'I have no experience with AWS but I run Kubernetes daily.',
      'I have no experience with AWS and Kubernetes is my daily tool.',
      'Non ho esperienza con AWS ma gestisco Kubernetes ogni giorno.',
      'Ich habe keine AWS-Erfahrung und betreibe Kubernetes täglich.',
      'Mit AWS habe ich noch keine Erfahrung und betreue Kubernetes-Cluster täglich.',
      'Je n\'ai pas d\'expérience avec AWS mais je déploie Kubernetes chaque jour.',
    ]) expect(both(sentence).sort(), sentence).toEqual(['tool:AWS', 'tool:Kubernetes']);
    // Two tools the lack names, before or after it, are both a gap.
    for (const sentence of [
      'I have no experience with Kubernetes and AWS yet.',
      'Non ho ancora esperienza con Kubernetes e AWS.',
      'Mit Kubernetes und AWS habe ich noch keine Erfahrung.',
      'Je n\'ai pas encore d\'expérience avec Kubernetes et AWS.',
    ]) expect(both(sentence), sentence).toEqual(['gap:Kubernetes', 'gap:AWS']);
  });

  it('flags "new to me" denied in any words, and a lack that says "nothing other than" or "not only"', () => {
    for (const sentence of [
      'Kubernetes isn\'t new to me.',
      'Kubernetes is nothing new to me.',
      'I am no longer new to Kubernetes.',
      'Kubernetes non è affatto nuovo per me.',
      'Kubernetes ist für mich keineswegs Neuland.',
      'Kubernetes ist für mich alles andere als Neuland.',
      'Kubernetes n\'est plus nouveau pour moi.',
      'I have never used any orchestrator other than Kubernetes.',
      'I have not used Kubernetes just for side projects but in production.',
      'Non ho mai usato altro che Kubernetes.',
      'Ich habe nie etwas ausser Kubernetes eingesetzt.',
      'Ich habe Kubernetes bisher nicht nur eingesetzt, sondern auch geschult.',
      'Je n\'ai jamais utilisé autre chose que Kubernetes.',
    ]) expect(flagged(sentence), sentence).toEqual(['tool:Kubernetes']);
    for (const sentence of ['Kubernetes is completely new to me.', 'Kubernetes è ancora nuovo per me.', 'SAP est nouveau pour moi.']) {
      expect(gaps(sentence), sentence).toEqual([`gap:${sentence.split(' ')[0]}`]);
    }
  });

  it('flags a wish told in the past, a wish to teach it, and a wish next to a claim told with any verb', () => {
    for (const sentence of [
      'I was happy to learn Kubernetes in my last job.',
      'Ero felice di imparare Kubernetes nel mio ultimo lavoro.',
      'Sono stato felice di imparare Kubernetes nel mio ultimo lavoro.',
      'Ich war motiviert, Kubernetes in meiner letzten Stelle zu erlernen.',
      'J\'étais heureux d\'apprendre Kubernetes dans mon dernier poste.',
      // Teaching it to others is knowing it.
      'I am keen to help your team get to know Kubernetes.',
      'Desidero far conoscere Kubernetes al vostro team.',
      'Ich möchte Ihrem Team helfen, Kubernetes kennenzulernen.',
      'Je souhaite faire découvrir Kubernetes à vos équipes.',
      // The wish, then a claim with a verb no list of having or using names.
      'I am eager to learn and I deploy Kubernetes clusters every day.',
      'I am eager to learn new things and bring solid Kubernetes experience to your team.',
      'Sono motivato a imparare e gestisco Kubernetes ogni giorno.',
      'Ich lerne gerne Neues und betreibe Kubernetes täglich.',
      'Ich möchte Ihre Prozesse kennenlernen und konfiguriere Kubernetes selbständig.',
      'Je souhaite apprendre et je déploie Kubernetes chaque jour.',
    ]) expect(flagged(sentence), sentence).toEqual(['tool:Kubernetes']);
    // The tool claimed before the wish takes the wish's gap with it. A noun between the tool and the German verb
    // that learns it is no verb of its own.
    expect(verdict({ coverLetter: 'Kubernetes betreibe ich täglich und möchte nun AWS lernen.' }, OPS).unsupported).toEqual(['tool:Kubernetes', 'tool:AWS']);
    expect(gaps('Ich möchte Kubernetes Schritt für Schritt kennenlernen.')).toEqual(['gap:Kubernetes']);
  });

  // Repair of 2026-10-04 (lib/honestGap.js): the stretch of the sentence that holds the tool must be a closed
  // template, from a boundary to a boundary; a word no template has makes the tool a claim again.
  it('flags a template with anything around it that no template has, in the four languages', () => {
    for (const sentence of [
      // A lack denied by a verb of saying before it.
      'I wouldn\'t say I\'m new to Kubernetes.',
      'Non direi che Kubernetes è nuovo per me.',
      'Ich würde nicht sagen, dass Kubernetes für mich Neuland ist.',
      'Je ne dirais pas que Kubernetes est nouveau pour moi.',
      // A double negation, a restriction, a lack of a part only: the rest was used.
      'I have never used Kubernetes without delivering on time.',
      'Ich habe noch nie ohne Kubernetes gearbeitet.',
      'I have no experience with orchestrators beyond Kubernetes.',
      'Je n\'ai pas d\'expérience avec des orchestrateurs au-delà de Kubernetes.',
      'I have not yet used Kubernetes in production.',
      'Non ho mai usato Kubernetes in produzione.',
      // No longer, again, still: it was had.
      'I don\'t use Kubernetes anymore.',
      'Ich nutze Kubernetes nicht mehr.',
      'I am eager to learn Kubernetes again.',
      'Je souhaite continuer à apprendre Kubernetes.',
      // A wish told in the past, or to teach it.
      'I was during my internship very eager to learn Kubernetes.',
      'Mein Ziel in der letzten Stelle war, Kubernetes zu lernen, und das gelang mir.',
      'Vorrei accompagnare il vostro team a imparare Kubernetes.',
      // The tool in an adjunct of the learn verb, not its object.
      'I am eager to learn your processes after six years with Kubernetes.',
      'Ich freue mich darauf, mit meiner Kubernetes-Erfahrung Ihre Abläufe kennenzulernen.',
      'Je suis motivé à apprendre vos processus après six ans avec Kubernetes.',
    ]) expect(flagged(sentence), sentence).toEqual(['tool:Kubernetes']);
  });

  it('flags a gap that what follows it in the sentence takes back', () => {
    for (const sentence of [
      'I am eager to learn Kubernetes, which I have used before.',
      'I have not used Kubernetes yet, apart from daily reporting.',
      'I have no experience with Kubernetes, only with its monitoring.',
      'Sono motivato a imparare Kubernetes, che già conosco in parte.',
      'Non ho esperienza con Kubernetes, tranne il monitoraggio.',
      'Ich möchte Kubernetes lernen, das ich schon aus dem Studium kenne.',
      'Ich habe keine Erfahrung mit Kubernetes, die Grundlagen kenne ich aber.',
      'Je souhaite apprendre Kubernetes, que je connais déjà un peu.',
      'Je n\'ai pas encore utilisé Kubernetes, dont je connais pourtant les modules.',
    ]) expect(flagged(sentence), sentence).toEqual(['tool:Kubernetes']);
  });

  it('passes the honest gaps the templates foresee: a list, a pronoun that learns it, a time to come', () => {
    for (const [sentence, tools] of [
      ['Non ho esperienza né con Kubernetes né con AWS.', ['Kubernetes', 'AWS']],
      ['Je n\'ai pas d\'expérience avec Kubernetes ni avec AWS.', ['Kubernetes', 'AWS']],
      ['Ich habe keine Erfahrung mit Kubernetes und auch nicht mit AWS.', ['Kubernetes', 'AWS']],
      ['I have no experience with Kubernetes yet, but I am eager to learn it.', ['Kubernetes']],
      ['Non ho ancora esperienza con Kubernetes, ma sono motivato a impararlo rapidamente.', ['Kubernetes']],
      ['Ich habe noch keine Erfahrung mit Kubernetes, bin aber bereit, es schnell zu lernen.', ['Kubernetes']],
      ['Je n\'ai pas encore d\'expérience avec Kubernetes, mais je suis prêt à l\'apprendre rapidement.', ['Kubernetes']],
      ['My goal is to learn Kubernetes within the first months.', ['Kubernetes']],
      ['Intendo imparare Kubernetes nei primi mesi.', ['Kubernetes']],
      ['Ich bringe die Bereitschaft mit, mich in Kubernetes einzuarbeiten.', ['Kubernetes']],
      ['Je compte apprendre Kubernetes dans les premiers mois.', ['Kubernetes']],
    ] as const) expect(gaps(sentence), sentence).toEqual(tools.map((tool) => `gap:${tool}`));
  });

  // Third review of the close-out: what follows or precedes a template in the sentence carried the claim.
  it('flags a gap when anything else in the sentence is no template and names no backed tool', () => {
    for (const sentence of [
      // A restriction, a source of knowledge, a comparison after the gap.
      'I have no experience with Kubernetes, outside of a two-day workshop at university.',
      'I have not used Kubernetes yet, but I know the basics from my studies.',
      'I am motivated to learn the hotel\'s Kubernetes standards, as I did at my previous five-star hotel.',
      'Non ho mai usato Kubernetes, se non durante uno stage.',
      'Ich habe Kubernetes zwar noch nie eingesetzt, kenne die Grundlagen aber aus dem Studium.',
      'Je n\'ai jamais utilisé Kubernetes, si ce n\'est lors d\'un stage.',
      // A purpose, or what is known already, before or after the wish.
      'Sono motivato a imparare Kubernetes per consolidare le basi acquisite in Vesta.',
      'I already know the basics and am eager to learn Kubernetes.',
      'Die Grundlagen kenne ich schon, und ich möchte Kubernetes lernen.',
      // A dash, a semicolon, a colon, an abbreviation do not end the sentence.
      'I would like to learn Kubernetes – which I used briefly at Vesta.',
      'I have not used Kubernetes yet; I did use it daily during my internship.',
      'Non ho mai usato Kubernetes: lo uso però ogni giorno per la contabilità.',
      'Ich habe noch keine Erfahrung mit Kubernetes, d. h. ich kenne es nur aus dem Studium.',
      'I have no experience with Kubernetes, i.e. I have only used it in training.',
    ]) expect(flagged(sentence), sentence).toEqual(['tool:Kubernetes']);
  });

  it('flags a lack said of a part only: a quantifier, a kind of experience, a hedge, an adverb, a glued word', () => {
    for (const sentence of [
      'Some Kubernetes modules are still new to me.',
      'Although I have not yet worked with all Kubernetes modules, I learn quickly.',
      'Pur non avendo ancora utilizzato tutti i moduli Kubernetes, imparo in fretta.',
      'Einige Kubernetes-Module sind für mich noch neu.',
      'Je n\'ai pas encore utilisé tous les modules Kubernetes.',
      'I have no professional experience with Kubernetes yet.',
      'Ich habe noch keine berufliche Erfahrung mit Kubernetes.',
      'Je n\'ai pas encore d\'expérience professionnelle avec Kubernetes.',
      'I am relatively new to Kubernetes.',
      'Kubernetes è ancora abbastanza nuovo per me.',
      'Kubernetes est encore plutôt nouveau pour moi.',
      'Non ho lavorato con Kubernetes di frequente.',
      'I have no experience with non-Kubernetes systems.',
      'Ich habe noch nie mit Kubernetes-Alternativen gearbeitet.',
      'I have not used Kubernetes so extensively, but I learn fast.',
      'Je n\'ai jamais utilisé Kubernetes, ou si peu.',
      'I do not yet know Kubernetes as well as Docker.',
    ]) expect(flagged(sentence), sentence).toEqual(['tool:Kubernetes']);
  });

  it('passes a gap next to a neutral clause or a wish to learn with no object, never next to anything else', () => {
    for (const sentence of [
      'Although I have not yet worked with Kubernetes, I learn quickly and enjoy new systems.',
      'Kubernetes is new to me, but I adapt quickly to new systems.',
      'I am eager to learn Kubernetes and help your finance team.',
      'Non ho esperienza con Kubernetes, ma sono pronto a colmare questa lacuna.',
      'Mit Kubernetes habe ich bisher noch nicht gearbeitet, bin aber bereit, mich schnell einzuarbeiten.',
      'Je ne maîtrise pas encore Kubernetes, mais je suis prêt à me former.',
      // Review of #11425: an ASCII dash between words is a boundary, as the en and em dashes.
      'I have not used Kubernetes - but I learn quickly.',
      'Although my background does not include Kubernetes, I am a quick learner.',
      'Kenntnisse in Kubernetes bringe ich noch nicht mit, eigne sie mir aber rasch an.',
      'Kubernetes is not a tool I have used so far, though I am a quick learner.',
      'Pur non avendo ancora utilizzato Kubernetes, sono convinto di poterlo imparare rapidamente.',
      'I am eager to learn the basics of Kubernetes.',
    ]) expect(gaps(sentence), sentence).toEqual(['gap:Kubernetes']);
    // Second review of the close-out: a piece about a tool the CV backs carried the claim ("…, as I did with
    // Opera PMS at my previous hotel", "…, se non in un progetto con Docker"). Such a sentence is a claim.
    for (const sentence of [
      'I use Docker every day and I am eager to learn Kubernetes.',
      'Ich nutze Docker täglich und möchte Kubernetes lernen.',
      'Non ho mai usato Kubernetes, se non in un progetto di integrazione con Docker.',
      'I am eager to learn Kubernetes, the orchestrator behind my Docker deployments at Vesta.',
      'Je souhaite apprendre Kubernetes, avec lequel j\'orchestre mes conteneurs Docker.',
      'I am eager to learn Kubernetes and Docker again.',
      'I have not yet used Kubernetes and Docker in the same project.',
    ]) expect(flagged(sentence), sentence).toEqual(['tool:Kubernetes']);
  });

  it('flags a lack whose noun phrase says a part: an adjective, a possessive, a genitive, a name', () => {
    for (const sentence of [
      'I have not yet worked with your specific Kubernetes modules, but I learn quickly.',
      'Mit Ihren internen Kubernetes-Prozessen bin ich noch nicht vertraut.',
      'I do not yet have the required Kubernetes skills.',
      'I have no experience with Kubernetes systems of this size.',
      'Non ho mai usato sistemi Kubernetes del genere.',
      'Je n\'ai jamais travaillé avec des systèmes Kubernetes de cette taille.',
      'I have not used the new Kubernetes system yet.',
      'I am new to Enterprise Kubernetes.',
      'I have not yet worked with today\'s Kubernetes modules.',
      'I have no direct Kubernetes experience.',
      'Ich habe keine direkte Erfahrung mit Kubernetes.',
      // In a wish too: "the new one" says the old one is known.
      'I am eager to learn the new Kubernetes platform.',
    ]) expect(flagged(sentence), sentence).toEqual(['tool:Kubernetes']);
    // An article and a generic noun are the tool itself.
    for (const sentence of ['I have not used the Kubernetes platform yet.', 'Non ho ancora usato il sistema Kubernetes.', 'Je n\'ai pas encore utilisé les modules Kubernetes.']) {
      expect(gaps(sentence), sentence).toEqual(['gap:Kubernetes']);
    }
  });

  it('reads a sentence across an ellipsis, a lowercase word, a line break, and without invisible characters', () => {
    for (const sentence of [
      'I am eager to learn Kubernetes… which I already used daily at Vesta.',
      'I have no experience with Kubernetes yet,\nbut I used it daily at Vesta.',
      'I am eager to learn Kubernetes! after all, I used it daily at Vesta.',
      'Non ho ancora usato Kubernetes… ma lo conosco bene grazie a Docker.',
    ]) expect(flagged(sentence), sentence).toEqual(['tool:Kubernetes']);
    // A soft hyphen or a zero-width space does not hide the tool, nor a rare apostrophe the pronoun.
    expect(flagged('I keep the clusters in Kuber\u00ADnetes every day.')).toEqual(['tool:Kubernetes']);
    expect(flagged('I deploy on Kuber\u200Bnetes every day.')).toEqual(['tool:Kubernetes']);
    // An empty line ends a paragraph, so the gap of the next one stands alone.
    expect(gaps('Ho seguito i clienti di Vesta per anni\n\nNon ho ancora esperienza con Kubernetes.')).toEqual(['gap:Kubernetes']);
  });

  it('reads a text of many short sentences with a tool each in linear time', () => {
    const started = performance.now();
    verdict({ coverLetter: 'Ich möchte Kubernetes lernen. I deploy AWS every day. '.repeat(100) }, OPS);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('reads a long clause in linear time', () => {
    // A letter edited by hand may be one clause of thousands of characters with a tool in every few words.
    const started = performance.now();
    verdict({ coverLetter: `Ich möchte lernen ${'setze Kubernetes '.repeat(4_700)}` }, OPS);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});

describe('fact gate: a token glued to the next word of the CV', () => {
  // "JavaScript", "GoPro" and "SageMaker" start with the name of another tool.
  const GLUED = {
    ...DEV,
    text: `${DEV.text}\nAltro: JavaScript, GoPro, SageMaker\nInformatica\nExcelAvanzato:\nSAPBase:\nSpagnolo\nB2Intermedio:`,
    posting: 'Cerchiamo uno/a Sviluppatore/trice Java. Requisiti: Java, Go, Sage, Access, spagnolo C2.',
  };

  it('never backs a name by the start of a longer one', () => {
    expect(verdict({ coverLetter: 'Sviluppo applicazioni in Java da 6 anni.' }, GLUED).unsupported).toEqual(['tool:Java']);
    expect(verdict({ coverLetter: 'Scrivo servizi in Go e tengo la contabilità con Sage.' }, GLUED).unsupported).toEqual(['tool:Go', 'tool:Sage']);
    expect(verdict({ coverLetter: 'Sviluppo applicazioni in JavaScript da 6 anni.' }, GLUED).unsupported).toEqual([]);
  });

  it('still backs a level, and a tool, glued to the level word of a table', () => {
    expect(verdict({ coverLetter: 'Uso Excel e SAP ogni giorno; il mio spagnolo è a livello B2.' }, GLUED)).toMatchObject({ ok: true, unsupported: [] });
    // The glue backs the token it follows, nothing else.
    expect(verdict({ coverLetter: 'Uso Access ogni giorno; il mio spagnolo è a livello C2.' }, GLUED).unsupported).toEqual(['tool:Access', 'tool:C2']);
    // A level word that ends a longer name is that name: "ReactNative" is React Native, not React.
    const native = { ...GLUED, text: 'Marco Bianchi\nInformatica\nReactNative', posting: 'Cerchiamo uno sviluppatore React.' };
    expect(verdict({ coverLetter: 'Sviluppo interfacce in React.' }, native).unsupported).toEqual(['tool:React']);
  });
});

describe('fact gate: contact data is not a figure of the candidate', () => {
  // The order line holds the candidate's e-mail and phone (scripts/assisted-application/lib/draft.mjs).
  const NURSE_IT = {
    text: 'Maria Rossi\nEmail: maria.rossi85@example.com — Telefono: 079 123 45 67 — linkedin.com/in/maria-rossi-33\n'
      + '01.03.2018 – 28.02.2023 Infermiera di reparto, Ospedale Civico, Lugano: reparto da 24 letti',
    posting: 'Cerchiamo un’infermiera di reparto.',
    order: ['Infermiera', 'Ospedale Esempio', 'Maria Rossi', 'maria.rossi85@example.com', '+41 79 123 45 67', 'Infermiera di reparto'].join('\n'),
    answers: '',
    place: 'Lugano',
  };

  it('never backs a figure by the digits of a phone number, an e-mail address or a link', () => {
    expect(verdict({ coverLetter: 'Ho guidato un team di 45 persone e seguito 67 pazienti.' }, NURSE_IT).unsupported).toEqual(['number:45', 'number:67']);
    expect(verdict({ coverLetter: 'Ho formato 85 colleghi in 33 corsi.' }, NURSE_IT).unsupported).toEqual(['number:85', 'number:33']);
    // Written without the "+41 79 …" form: an Italian mobile, a landline in brackets, a trunk zero in brackets, dots,
    // the prefix in brackets.
    for (const [phone, figure] of [['333 1234567', '333'], ['347 123 4567', '4567'], ['(091) 123 45 67', '45'], ['+41 (0)91 123 45 67', '91'], ['06.12.34.56.78', '56'], ['(+41) 79 123 45 67', '45'],
      // Recheck of the close-out: a spaced slash, a trunk zero alone in brackets, thin spaces, no trunk zero, a German mobile.
      ['091 / 123 45 67', '45'], ['(0)79 123 45 67', '45'], ['+41\u200979\u2009123\u200945\u200967', '45'], ['79 123 45 67', '45'], ['0151 1234 5678', '5678']]) {
      const sources = { ...NURSE_IT, text: `Maria Rossi\nTel. ${phone}\n2018 – 2023 Infermiera di reparto`, order: 'Infermiera\nOspedale Esempio\nMaria Rossi' };
      expect(verdict({ coverLetter: `Ho seguito ${figure} pazienti.` }, sources).unsupported, phone).toEqual([`number:${figure}`]);
    }
    // A label glued to the number, a Liechtenstein number after its label.
    for (const [phone, figure] of [['Tel.079 123 45 67', '45'], ['Cell.333 1234567', '333'], ['Tél.06 12 34 56 78', '56'], ['Tel. 234 56 78', '56']]) {
      const sources = { ...NURSE_IT, text: `Maria Rossi\n${phone}\n2018 – 2023 Infermiera di reparto`, order: 'Infermiera\nOspedale Esempio\nMaria Rossi' };
      expect(verdict({ coverLetter: `Ho seguito ${figure} pazienti.` }, sources).unsupported, phone).toEqual([`number:${figure}`]);
    }
    // Review of #11425: digits inside the candidate's e-mail address back no phone number either.
    const mailOnly = { ...NURSE_IT, text: 'Maria Rossi\nmaria+41791234567@example.com\n2018 – 2023 Infermiera di reparto', order: 'Infermiera\nOspedale Esempio\nMaria Rossi' };
    expect(verdict({ emailBody: 'Mi trovate al +41791234567.' }, mailOnly).unsupported).toEqual(['phone:+41791234567']);
    // Nor inside a link written without its scheme.
    const linkOnly = { ...mailOnly, text: 'Maria Rossi\nlinkedin.com/in/+41791234567\n2018 – 2023 Infermiera di reparto' };
    expect(verdict({ emailBody: 'Mi trovate al +41791234567.' }, linkOnly).unsupported).toEqual(['phone:+41791234567']);
    expect(buildFactIndex([linkOnly.text], { numberSources: [linkOnly.text] }).phones.has('791234567')).toBe(false);
    // A site written without a path.
    const site = { ...NURSE_IT, text: 'Maria Rossi\nSito: mariarossi4521.ch\n2018 – 2023 Infermiera di reparto', order: 'Infermiera\nOspedale Esempio\nMaria Rossi' };
    expect(verdict({ coverLetter: 'Ho seguito 4521 pazienti.' }, site).unsupported).toEqual(['number:4521']);
  });

  it('keeps the years and the dates of the CV, and the letter’s own contact checks', () => {
    expect(verdict({ coverLetter: 'Dal 2018 al 2023 ho lavorato in un reparto da 24 letti.' }, NURSE_IT)).toMatchObject({ ok: true, unsupported: [] });
    expect(verdict({ coverLetter: 'Ho lasciato il reparto il 28.02.2023.' }, NURSE_IT)).toMatchObject({ ok: true, unsupported: [] });
    expect(verdict({ emailBody: 'Mi trovate al +41 79 123 45 67 o a maria.rossi85@example.com.' }, NURSE_IT)).toMatchObject({ ok: true, unsupported: [] });
    expect(verdict({ emailBody: 'Mi trovate al +41 79 999 45 67.' }, NURSE_IT).unsupported).toEqual(['phone:+41 79 999 45 67']);
    // A number never runs into the years of the next line of the CV.
    const stacked = { ...NURSE_IT, text: 'Maria Rossi\nTel. +41 79 123 45 67\n2019 – 2023 Infermiera di reparto\nCell. 333 1234567\n2015 – 2018 Infermiera' };
    expect(verdict({ coverLetter: 'Dal 2015 al 2018 e dal 2019 al 2023 ho lavorato in reparto.' }, stacked)).toMatchObject({ ok: true, unsupported: [] });
    // Review of the close-out: the zeros inside a year are no international prefix ("2005 - 12.2009"), with a hyphen too.
    for (const [range, letter] of [
      ['03.2005 - 12.2009', 'Dal 2005 al 2009 ho lavorato come infermiera.'],
      ['01/2000 - 12/2004', 'Dal 2000 al 2004 ho lavorato come infermiera.'],
      ['10.2003-09.2008', 'Dal 2003 al 2008 ho lavorato come infermiera.'],
      ['01.03.2006 - 28.02.2009', 'Dal 2006 al 2009 ho lavorato come infermiera.'],
    ]) {
      const sources = { ...NURSE_IT, text: `Maria Rossi\n${range} Infermiera, Ospedale Civico, Lugano` };
      expect(verdict({ coverLetter: letter }, sources), range).toMatchObject({ ok: true, unsupported: [] });
    }
    // Nor those of a range of thousands, nor a figure written after the phone on the same line.
    const salary = { ...NURSE_IT, answers: 'Aspettativa salariale: CHF 80 000 - 90 000' };
    expect(verdict({ emailBody: 'La mia aspettativa salariale è di CHF 80 000 - 90 000.' }, salary)).toMatchObject({ ok: true, unsupported: [] });
    const sameLine = { ...NURSE_IT, text: 'Maria Rossi · Tel. +41 79 123 45 67 - 15 anni di esperienza' };
    expect(verdict({ coverLetter: 'Ho 15 anni di esperienza in reparto.' }, sameLine)).toMatchObject({ ok: true, unsupported: [] });
    // Recheck of the close-out: a year one space after the phone, a figure of nine digits that starts with 3, a date in brackets.
    for (const [line, letter] of [
      ['Tel. 091 123 45 67 2015 – 2017 Infermiera', 'Dal 2015 al 2017 ho lavorato in clinica.'],
      ['Gestione di un budget di 300.000.000 CHF', 'Ho gestito un budget di 300 milioni di franchi.'],
      ['Gestione di un budget di CHF 320 000 000', 'Ho gestito un budget di 320 milioni di franchi.'],
      ['(01.03.2021-28.02.2023) Infermiera', 'Dal 2021 al 2023 ho lavorato in reparto.'],
      // A whole number of ten digits does not take the figure after it.
      ['Tél. 06 12 34 56 78 15 anni di esperienza', 'Ho 15 anni di esperienza.'],
      ['Tel. +39 333 1234567 45 dipendenti', 'Ho guidato 45 dipendenti.'],
    ]) {
      const sources = { ...NURSE_IT, text: `Maria Rossi\n${line}`, order: 'Infermiera\nOspedale Esempio\nMaria Rossi' };
      expect(verdict({ coverLetter: letter }, sources), line).toMatchObject({ ok: true, unsupported: [] });
    }
  });

  it('reads the candidate’s own number in the e-mail’s signature as contact data, however it is written', () => {
    // The signature is the order line's own phone (draft.mjs); a number the sources do not hold is still a claim.
    for (const phone of ['079 123 45 67', '(091) 123 45 67', '+41 (0)79 123 45 67', '333 1234567', '+41 79 123 45 67', '(+41) 79 123 45 67']) {
      const sources = { ...NURSE_IT, text: `Maria Rossi\nTel. ${phone}\n2018 – 2023 Infermiera di reparto: reparto da 24 letti`, order: NURSE_IT.order.replace('+41 79 123 45 67', phone) };
      const signed = `In allegato CV e lettera: dal 2018 ho lavorato in un reparto da 24 letti.\n\nMaria Rossi\nmaria.rossi85@example.com\n${phone}`;
      expect(verdict({ emailBody: signed }, sources), phone).toMatchObject({ ok: true, unsupported: [] });
      expect(verdict({ emailBody: 'Mi trovate allo 079 999 88 77.' }, sources).unsupported, phone).toEqual(['number:079 999 88 77']);
    }
    // The CV writes the number with its trunk zero, the signature with the prefix: the same number.
    const national = { ...NURSE_IT, text: 'Maria Rossi\nTel. 079 123 45 67\n2018 – 2023 Infermiera di reparto', order: 'Infermiera\nOspedale Esempio\nMaria Rossi\n079 123 45 67' };
    expect(verdict({ emailBody: 'In allegato CV e lettera.\n\nMaria Rossi\n+41 79 123 45 67' }, national)).toMatchObject({ ok: true, unsupported: [] });
    // A link the CV writes with its scheme, quoted bare in the e-mail.
    for (const link of ['https://www.linkedin.com/in/maria-rossi-33', 'www.linkedin.com/in/maria-rossi-33']) {
      const sources = { ...NURSE_IT, text: `Maria Rossi\n${link}\n2018 – 2023 Infermiera di reparto` };
      expect(verdict({ emailBody: 'Il mio profilo: linkedin.com/in/maria-rossi-33' }, sources), link).toMatchObject({ ok: true, unsupported: [] });
    }
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

  // Close-out of 2026-10-03: the glued-token rule is shared with the letter (backsClaim).
  it('never lists "Java" for a CV that only says "JavaScript", in a skill, a competency or a rewritten bullet', () => {
    const cvText = `${DEV.text}\nAltro: JavaScript`;
    const scripted = { ...profile, skills: ['JavaScript', ...profile.skills] };
    const cv = sanitizeTailoredCv(raw({
      competencies: ['Java', 'JavaScript', 'React'],
      skills: ['Java', 'JavaScript', 'TypeScript'],
      experience: [{ index: 0, bullets: ['Portale B2B in Java usato da 400 clienti'] }, { index: 1, bullets: ['Siti e-commerce per 15 clienti'] }],
    }), { profile: scripted, cvText, language: 'it' });
    expect(cv.competencies).toEqual(['JavaScript', 'React']);
    expect(cv.skills).toEqual(['JavaScript', 'TypeScript']);
    expect(cv.experience.map((role: any) => role.rewritten)).toEqual([false, true]);
    expect(cv.experience[0].bullets).toEqual(profile.experience[0].highlights);
    expect(cv.dropped).toEqual(['Java', 'Portale B2B in Java usato da 400 clienti', 'Java']);
    expect(checkTailoredCvFacts(cv, { cvText, profile: scripted, answers: {} }).ok).toBe(true);
    // The summary is not checked line by line: the gate on the whole tailored CV stops it.
    const claimed = sanitizeTailoredCv(raw({ summary: 'Sviluppatore full-stack con esperienza in Java.' }), { profile: scripted, cvText, language: 'it' });
    const facts = checkTailoredCvFacts(claimed, { cvText, profile: scripted, answers: {} });
    expect(facts.ok).toBe(false);
    expect(facts.unsupported.map((item: any) => item.token)).toEqual(['Java']);
    // A level word glued to the tool in the CV's table still grounds it.
    const table = `${DEV.text}\nInformatica\nExcelAvanzato:`;
    expect(groundedInCv('Excel', ` ${normalizeText(table)} `, table)).toBe(true);
    expect(groundedInCv('Access', ` ${normalizeText(table)} `, table)).toBe(false);
  });

  it('never backs a figure of the tailored CV by the phone number, the e-mail address or the link of the CV', () => {
    const cvText = `${DEV.text}\nTel. 079 123 45 67 · marco.bianchi88@example.com · linkedin.com/in/marco-bianchi-73`;
    const contacts = { ...profile, phone: '079 123 45 67', email: 'marco.bianchi88@example.com', linkedin: 'linkedin.com/in/marco-bianchi-73' };
    const facts = (summary: string) => {
      const cv = sanitizeTailoredCv(raw({ summary }), { profile: contacts, cvText, language: 'it' });
      return checkTailoredCvFacts(cv, { cvText, profile: contacts, answers: {} }).unsupported.map((item: any) => `${item.kind}:${item.token}`);
    };
    expect(facts('Sviluppatore full-stack, a capo di un team di 45 persone in 88 progetti per 73 clienti.')).toEqual(['number:45', 'number:88', 'number:73']);
    // The CV's own figures and years stay.
    expect(facts('Sviluppatore full-stack dal 2019, con 6 anni di esperienza e un portale usato da 400 clienti.')).toEqual([]);
  });
});

// Owner decisions of 2026-10-03 (P4, decision 8) and of 2026-10-04 (citizenship): a Swiss permit or citizenship in a
// text that leaves in the candidate's name is the candidate's own statement.
describe('fact gate: a Swiss permit is named only when the status or the candidate’s texts back it', () => {
  const NURSE_IT = {
    text: 'Giulia Verdi\nInfermiera di reparto, Ospedale Civico, Lugano, 2019 – 2025\nLingue: italiano madrelingua, tedesco B1',
    posting: 'Cerchiamo un’infermiera di reparto. Requisiti: diploma in cure infermieristiche, tedesco B1, permesso G o B.',
    order: ['Infermiera di reparto', 'Clinica Esempio SA', 'Giulia Verdi'].join('\n'),
    answers: '',
    place: 'Mendrisio',
  };
  const sources = (permitStatus?: string, extra: Record<string, string> = {}) => ({ ...NURSE_IT, ...extra, ...(permitStatus === undefined ? {} : { permitStatus }) });
  const letter = (text: string, permitStatus?: string, extra: Record<string, string> = {}) => verdict({ coverLetter: text }, sources(permitStatus, extra));
  const HOLDER = 'Sono titolare del permesso G e lavoro a Lugano.';

  it('flags a permit the candidate did not state, and passes the one they chose or their CV names', () => {
    expect(letter(HOLDER, '')).toMatchObject({ ok: false, unsupported: ['permit:permesso G'] });
    expect(letter(HOLDER, 'permit_g')).toMatchObject({ ok: true, unsupported: [] });
    expect(letter(HOLDER, '', { text: `${NURSE_IT.text}\nPermesso G` })).toMatchObject({ ok: true, unsupported: [] });
    // «none» says no permit is held: the CV's old line backs nothing.
    expect(letter(HOLDER, 'none', { text: `${NURSE_IT.text}\nPermesso G` })).toMatchObject({ ok: false, unsupported: ['permit:permesso G'] });
    // A CV line that speaks of a permit to come, or says it is not held, backs nothing either.
    expect(letter(HOLDER, '', { text: `${NURSE_IT.text}\nPermesso G da richiedere` })).toMatchObject({ ok: false });
    expect(letter(HOLDER, '', { text: `${NURSE_IT.text}\nNon ho ancora il permesso G` })).toMatchObject({ ok: false });
    // A work permit in general: backed by a held status, never by «swiss».
    expect(verdict({ coverLetter: 'Ich habe eine Arbeitsbewilligung.' }, sources('permit_b'))).toMatchObject({ ok: true });
    expect(verdict({ coverLetter: 'Ich habe eine Arbeitsbewilligung.' }, sources('swiss'))).toMatchObject({ ok: false, unsupported: ['permit:Arbeitsbewilligung'] });
  });

  it('flags a permit to come even with the status, and reports the posting’s permit quoted as not held as an honest gap', () => {
    expect(letter('Ho diritto al permesso G per questo lavoro.', 'permit_g')).toMatchObject({ ok: false, unsupported: ['permit:permesso G'] });
    expect(letter('Pur non avendo ancora il permesso G richiesto dall’annuncio, posso iniziare a gennaio.', '')).toEqual({ ok: true, unsupported: [], advisories: ['gap:permesso G'] });
    // A driving licence is no permit: nothing to judge.
    expect(verdict({ coverLetter: 'Titulaire du permis B, je me déplace en voiture.' }, sources('none'))).toMatchObject({ ok: true, unsupported: [] });
  });

  it('judges a draft written before the status as it was', () => {
    expect(letter(HOLDER)).toMatchObject({ ok: true, unsupported: [] });
  });

  it('gates a Swiss citizenship like a permit: the status «swiss» or the candidate’s own texts', () => {
    const SWISS = 'Ho la cittadinanza svizzera e vivo a Mendrisio.';
    expect(letter(SWISS, '')).toMatchObject({ ok: false, unsupported: ['citizenship:cittadinanza svizzera'] });
    expect(letter(SWISS, 'swiss')).toMatchObject({ ok: true });
    expect(letter(SWISS, '', { text: `${NURSE_IT.text}\nNazionalità: svizzera` })).toMatchObject({ ok: true });
    // A permit holder is no Swiss citizen, whatever an older CV says.
    expect(letter(SWISS, 'permit_b', { text: `${NURSE_IT.text}\nNazionalità: svizzera` })).toMatchObject({ ok: false, unsupported: ['citizenship:cittadinanza svizzera'] });
    // The e-mail and the short motivation are claims too; the «why us» text is about the employer.
    const texts = { emailBody: 'Sono cittadina svizzera.', motivationShort: 'Ho la cittadinanza svizzera.', whyCompany: 'Un’azienda con la cittadinanza svizzera dei suoi soci.' };
    expect(verdict(texts, sources('')).unsupported.sort()).toEqual(['citizenship:cittadina svizzera', 'citizenship:cittadinanza svizzera']);
  });

  it('checks the tailored CV with the status its profile carries', () => {
    const profile = sanitizeProfile({ headline: 'Infermiera', experience: [{ role: 'Infermiera di reparto', employer: 'Ospedale Civico', start: '2019', end: '2025', kind: 'job', highlights: ['Reparto di medicina'] }] });
    const cv = sanitizeTailoredCv({ summary: 'Frontaliera con permesso G, infermiera di reparto.', experience: [], competencies: [], skills: [] }, { profile, cvText: NURSE_IT.text, language: 'it' });
    expect(checkTailoredCvFacts(cv, { cvText: NURSE_IT.text, profile: { ...profile, permitStatus: 'none' }, answers: {} })).toMatchObject({ ok: false, unsupported: [expect.objectContaining({ kind: 'permit', token: 'permesso G' })] });
    expect(checkTailoredCvFacts(cv, { cvText: NURSE_IT.text, profile, answers: {} }).ok).toBe(true);
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
    // Canton Ticino (2025) and Graubünden (2026); the Ticino directive asks for one adjective, not two.
    expect(letterSalutation('it', '')).toBe('Gentili signore e signori,');
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

// The formulas checked against the Swiss institutional sources (verification of 2026-10-03): each defect the
// verifier reproduced by running the code is a case here. Invented contacts, invented postings.
describe('letter formulas as the verified Swiss sources write them', () => {
  const NBSP = ' ';

  it('addresses one person only: a department, two people, a surname alone or an address give the unnamed form', () => {
    expect(letterSalutation('de', 'Personalabteilung')).toBe('Sehr geehrte Damen und Herren');
    expect(letterSalutation('de', 'HR Team')).toBe('Sehr geehrte Damen und Herren');
    expect(letterSalutation('it', 'Ufficio del personale')).toBe('Gentili signore e signori,');
    expect(letterSalutation('fr', 'Service du personnel')).toBe('Madame, Monsieur,');
    expect(letterSalutation('en', 'Human Resources')).toBe('Dear Sir or Madam');
    expect(letterSalutation('de', 'jobs@firma-beispiel.ch')).toBe('Sehr geehrte Damen und Herren');
    // Two contacts: never one of them, never a mix (today «Frau Muster / Herr Meier» gave «Frau Meier»).
    expect(letterSalutation('de', 'Frau Muster / Herr Meier')).toBe('Sehr geehrte Damen und Herren');
    expect(letterSalutation('de', 'Frau Muster und Herr Meier')).toBe('Sehr geehrte Damen und Herren');
    expect(letterSalutation('de', 'Frau Muster, Herr Meier')).toBe('Sehr geehrte Damen und Herren');
    expect(letterSalutation('it', 'signora Rossi e signor Bianchi')).toBe('Gentili signore e signori,');
    expect(letterSalutation('fr', 'Madame Dupont et Monsieur Martin')).toBe('Madame, Monsieur,');
    expect(letterSalutation('en', 'Ms Smith & Mr Jones')).toBe('Dear Sir or Madam');
    // A surname alone, without an honorific, is no one to greet.
    expect(letterSalutation('de', 'Müller')).toBe('Sehr geehrte Damen und Herren');
    expect(letterSalutation('it', 'Rossi')).toBe('Gentili signore e signori,');
    expect(letterSalutation('en', 'Müller')).toBe('Dear Sir or Madam');
    // A function after a comma or in brackets is not part of the name; a role before the honorific neither.
    expect(letterSalutation('de', 'Anna Muster (HR)')).toBe('Guten Tag Anna Muster');
    expect(letterSalutation('en', 'Anna Muster (HR)')).toBe('Dear Anna Muster');
    expect(letterSalutation('de', 'Leiter HR, Herr Peter Muster')).toBe('Sehr geehrter Herr Muster');
    expect(letterSalutation('de', 'Teamleiterin Frau Muster')).toBe('Sehr geehrte Frau Muster');
  });

  it('drops academic titles whole and never reads them as a gender; keeps «Dott.ssa» female and the surname particles', () => {
    expect(letterSalutation('de', 'Dr. med. Hans Muster')).toBe('Guten Tag Hans Muster');
    expect(letterSalutation('de', 'Prof. Dr. Anna Muster')).toBe('Guten Tag Anna Muster');
    expect(letterSalutation('de', 'Dipl. Ing. Hans Muster')).toBe('Guten Tag Hans Muster');
    expect(letterSalutation('de', 'lic. iur. Anna Muster')).toBe('Guten Tag Anna Muster');
    expect(letterSalutation('de', 'Frau Dr. med. Anna Muster')).toBe('Sehr geehrte Frau Muster');
    // «Dott.» is a degree, not a man (today «Gentile signor Rossi,»).
    expect(letterSalutation('it', 'Dott. Maria Rossi')).toBe('Gentile Maria Rossi,');
    expect(letterSalutation('it', 'Dott.ssa Maria Rossi')).toBe('Gentile signora Rossi,');
    // Honorific and surname only: the particle is the surname's (today «Frau Arx», «signora Luca»).
    expect(letterSalutation('de', 'Frau von Arx')).toBe('Sehr geehrte Frau von Arx');
    expect(letterSalutation('it', 'signora De Luca')).toBe('Gentile signora De Luca,');
    expect(letterSalutation('it', 'Sig.ra Della Santa')).toBe('Gentile signora Della Santa,');
    // The dative of an address block.
    expect(letterSalutation('de', 'Herrn Peter Müller')).toBe('Sehr geehrter Herr Müller');
  });

  it('reads an abbreviation as an honorific only in its own language, as written', () => {
    // «M.» is Monsieur in French, elsewhere an initial.
    expect(letterSalutation('fr', 'M. Keller')).toBe('Monsieur,');
    expect(letterSalutation('de', 'M. Keller')).toBe('Guten Tag M. Keller');
    expect(letterSalutation('it', 'M. Keller')).toBe('Gentile M. Keller,');
    // «Hr.» and «Fr.» are Herr and Frau in German, with the full stop and that case.
    expect(letterSalutation('de', 'Hr. Meier')).toBe('Sehr geehrter Herr Meier');
    expect(letterSalutation('de', 'Fr. Müller')).toBe('Sehr geehrte Frau Müller');
    expect(letterSalutation('fr', 'Fr. Dupont')).toBe('Madame, Monsieur,');
    expect(letterSalutation('it', 'Hr. Meier')).toBe('Gentili signore e signori,');
  });

  it('writes English as the Federal Chancellery’s guide of 2024: no comma, «Dr» without a full stop and a gender', () => {
    expect(letterSalutation('en', '')).toBe('Dear Sir or Madam');
    expect(letterSalutation('en', 'Ms Jane Muster')).toBe('Dear Ms Muster');
    expect(letterSalutation('en', 'Frau Anna Muster')).toBe('Dear Ms Muster');
    expect(letterSalutation('en', 'Anna Muster')).toBe('Dear Anna Muster');
    expect(letterSalutation('en', 'Dr Anna Muster')).toBe('Dear Dr Muster');
    expect(letterSalutation('en', 'Dr. Anna Muster')).toBe('Dear Dr Muster');
    expect(letterSalutation('en', 'Mrs Jane Smith')).toBe('Dear Mrs Smith');
    expect(applyLetterConventions({ paragraphs: ['I enclose my CV.'] }, { language: 'en', contactPerson: 'Mr John Smith' })).toMatchObject({ salutation: 'Dear Mr Smith', closing: 'Kind regards' });
  });

  it('writes Italian with the courtesy capital, the ordinal first of the month, the singular enclosure and a protected space before %', () => {
    const start = (first: string) => applyLetterConventions({ paragraphs: [first] }, { language: 'it' }).paragraphs[0];
    expect(start('Le scrivo per candidarmi.')).toBe('Le scrivo per candidarmi.');
    expect(start('La ringrazio per l’attenzione.')).toBe('La ringrazio per l’attenzione.');
    expect(start('Vi invio la mia candidatura.')).toBe('Vi invio la mia candidatura.');
    expect(start('Le competenze richieste sono le mie.')).toBe('le competenze richieste sono le mie.');
    expect(start('La vostra azienda mi interessa.')).toBe('la vostra azienda mi interessa.');
    expect(formatLetterDate('it', new Date(Date.UTC(2026, 2, 1, 12)))).toBe('1° marzo 2026');
    expect(formatLetterDate('it', new Date(Date.UTC(2026, 9, 3, 12)))).toBe('3 ottobre 2026');
    expect(enclosuresLabel('it', 1)).toBe('Allegato:');
    expect(enclosuresLabel('it', 2)).toBe('Allegati:');
    expect(swissTypography('Impiego all’80% e al 100 %.', 'it')).toBe(`Impiego all’80${NBSP}% e al 100${NBSP}%.`);
  });

  it('writes French dates with «le» and «1er», elides «de» before a vowel, and drops the flag on the CSFO’s own sentence', () => {
    expect(letterPlaceDate('fr', 'Morges', new Date(Date.UTC(2026, 9, 3, 12)))).toBe('Morges, le 3 octobre 2026');
    expect(letterPlaceDate('fr', 'Morges', new Date(Date.UTC(2026, 2, 1, 12)))).toBe('Morges, le 1er mars 2026');
    expect(letterPlaceDate('fr', '', new Date(Date.UTC(2026, 9, 3, 12)))).toBe('Le 3 octobre 2026');
    expect(letterPlaceDate('de', 'Aarau', new Date(Date.UTC(2026, 1, 11, 12)))).toBe('Aarau, 11. Februar 2026');
    expect(letterSubject('fr', 'infirmière')).toBe('Candidature au poste d’infirmière');
    expect(letterSubject('fr', 'assistant·e de direction')).toBe('Candidature au poste d’assistant·e de direction');
    expect(letterSubject('fr', 'Horloger')).toBe('Candidature au poste d’Horloger');
    expect(letterSubject('fr', 'Responsable RH')).toBe('Candidature au poste de Responsable RH');
    // An aspirated h, an English title: «de». An acronym is read letter by letter: «IT» starts with a vowel.
    expect(letterSubject('fr', 'Hockeyeur')).toBe('Candidature au poste de Hockeyeur');
    expect(letterSubject('fr', 'Head of Sales')).toBe('Candidature au poste de Head of Sales');
    expect(letterSubject('fr', 'Account Manager')).toBe('Candidature au poste de Account Manager');
    expect(letterSubject('fr', 'IT Support')).toBe('Candidature au poste d’IT Support');
    expect(enclosuresLabel('fr', 1)).toBe(`Annexe${NBSP}:`);
    expect(enclosuresLabel('fr', 2)).toBe(`Annexes${NBSP}:`);
    expect(letterQualityIssues('Je serais ravie de venir me présenter dans votre entreprise.', 'fr').map((issue: any) => issue.kind)).not.toContain('filler_phrase');
  });

  it('closes French with a sentence that repeats the salutation, as the body’s last paragraph', () => {
    const letter = applyLetterConventions({ paragraphs: ['Vous trouverez ci-joint mon dossier.', 'Je me réjouis de vous rencontrer.'] }, { language: 'fr', contactPerson: 'Madame Claire Dupont' });
    expect(letter).toMatchObject({ salutation: 'Madame,', closing: 'Je vous prie de recevoir, Madame, mes meilleures salutations.' });
    expect(applyLetterConventions({ paragraphs: ['Texte.'] }, { language: 'fr' }).closing).toBe('Je vous prie de recevoir, Madame, Monsieur, mes meilleures salutations.');
    const blocks = letterPdfBlocks({ identity: { name: 'Élodie Exemple' }, companyName: 'Esempio SA', profile: {}, language: 'fr', letter, title: 'infirmière', now: new Date(), enclosures: ['CV'] });
    expect(blocks.paragraphs).toEqual(['Vous trouverez ci-joint mon dossier.', 'Je me réjouis de vous rencontrer.', 'Je vous prie de recevoir, Madame, mes meilleures salutations.']);
    expect(blocks.closing).toBe('');
    // The stored letter keeps round-tripping through an edit.
    expect(letterText(parseLetterText(letterText(letter)))).toBe(letterText(letter));
    // A bare closing stays above the signature; a letter whose closing the candidate deleted ends its body.
    expect(letterPdfBlocks({ identity: { name: 'Maria Rossi' }, companyName: 'Esempio SA', profile: {}, language: 'it', letter: applyLetterConventions({ paragraphs: ['testo.'] }, { language: 'it' }), title: 'x', now: new Date() }))
      .toMatchObject({ paragraphs: ['testo.'], closing: 'Cordiali saluti' });
    const deleted = parseLetterText('Gentile signora Rossi,\n\nprimo paragrafo.\n\nResto a disposizione per un colloquio.');
    expect(letterPdfBlocks({ identity: { name: 'Maria Rossi' }, companyName: 'Esempio SA', profile: {}, language: 'it', letter: deleted, title: 'x', now: new Date() }))
      .toMatchObject({ paragraphs: ['primo paragrafo.', 'Resto a disposizione per un colloquio.'], closing: '' });
    expect(['Cordiali saluti', 'Cordiali saluti.', 'Freundliche Grüsse', 'Mit freundlichen Grüssen', 'Kind regards', 'Meilleures salutations'].every((closing) => isBareClosing(closing))).toBe(true);
    // A closing sentence the model wrote anyway is not printed twice.
    const twice = applyLetterConventions({ paragraphs: ['Vous trouverez mon dossier.', 'Dans l’attente de votre réponse, je vous prie d’agréer, Madame, Monsieur, mes salutations distinguées.'] }, { language: 'fr' });
    expect(twice.paragraphs).toEqual(['Vous trouverez mon dossier.']);
  });

  it('writes German without a space inside «80%-Pensum» and flags the stock phrases the sources list', () => {
    expect(swissTypography('Ein 80%-Pensum, eine 80 %-Stelle, 80% und 5%-Hürde.', 'de')).toBe(`Ein 80%-Pensum, eine 80%-Stelle, 80${NBSP}% und 5%-Hürde.`);
    const flags = (text: string) => letterQualityIssues(text, 'de').filter((issue: any) => issue.kind === 'filler_phrase').length;
    expect(flags('Mit Interesse habe ich Ihr Inserat gelesen.')).toBe(1);
    expect(flags('Mit grossem Interesse bin ich auf Ihr Inserat gestossen.')).toBe(1);
    expect(flags('Über eine Einladung würde ich mich sehr freuen.')).toBe(1);
    expect(flags('Ich würde mich über eine Einladung freuen.')).toBe(1);
    expect(flags('Ich suche eine neue Herausforderung.')).toBe(1);
    expect(flags('Auf der Suche nach einer neuen Herausforderung.')).toBe(1);
    expect(flags('Ich freue mich auf ein Gespräch.')).toBe(0);
  });

  it('prints a locality in the place line, never a street, a postal code or a country', () => {
    const placeDate = (profile: any) => letterPdfBlocks({ identity: { name: 'Maria Rossi' }, companyName: 'Esempio SA', profile, language: 'it', letter: { salutation: '', paragraphs: [], closing: '' }, title: 'x', now: new Date(Date.UTC(2026, 9, 3, 12)) }).placeDate;
    expect(placeDate({ location: 'Viale Varese 5, Como' })).toBe('Como, 3 ottobre 2026');
    expect(placeDate({ location: 'Bahnhofstrasse 1, 8001 Zürich' })).toBe('Zürich, 3 ottobre 2026');
    expect(placeDate({ location: '22100 Como (CO)' })).toBe('Como, 3 ottobre 2026');
    expect(placeDate({ location: 'Via Roma 3 Como' })).toBe('Como, 3 ottobre 2026');
    expect(placeDate({ location: 'Italia' })).toBe('3 ottobre 2026');
    expect(placeDate({ location: '' })).toBe('3 ottobre 2026');
    // The address's city first, while the address is still the candidate's; a corrected place wins.
    expect(placeDate({ location: 'Via Roma 3, Como', address: { street: 'Via Roma 3', postalCode: '22100', city: 'Como' } })).toBe('Como, 3 ottobre 2026');
    expect(placeDate({ location: '', address: { street: 'Musterweg 12', postalCode: '8400', city: 'Winterthur' } })).toBe('Winterthur, 3 ottobre 2026');
    expect(placeDate({ location: 'Varese', address: { street: 'Via Roma 3', postalCode: '22100', city: 'Como' } })).toBe('Varese, 3 ottobre 2026');
    expect(placeDate({ location: 'Italia', address: { city: 'Como' } })).toBe('Como, 3 ottobre 2026');
    expect(localityOf('CH-8001 Zürich')).toBe('Zürich');
    expect(localityOf('Svizzera')).toBe('');
    // French without a place: «Le …», never a lower-case start.
    expect(letterPdfBlocks({ identity: { name: 'Élodie Exemple' }, companyName: 'Esempio SA', profile: { location: 'Rue du Lac 5' }, language: 'fr', letter: { salutation: '', paragraphs: [], closing: '' }, title: 'x', now: new Date(Date.UTC(2026, 9, 3, 12)) }).placeDate)
      .toBe('Le 3 octobre 2026');
  });

  it('gives an apprenticeship its own subject when the trade can be read from the title, else the general one', () => {
    expect(letterSubject('de', 'Lehrstelle 2027: Informatiker/in EFZ', 'apprentice')).toBe('Bewerbung um die Lehrstelle als Informatiker/in EFZ');
    expect(letterSubject('de', 'Kauffrau/Kaufmann EFZ (Lehrstelle 2027)', 'apprentice')).toBe('Bewerbung um die Lehrstelle als Kauffrau/Kaufmann EFZ');
    expect(letterSubject('fr', 'Apprenti-e employé-e de commerce CFC', 'apprentice')).toBe('Candidature pour la place d’apprentissage d’employé-e de commerce CFC');
    expect(letterSubject('fr', 'Apprenti(e) gestionnaire du commerce de détail CFC', 'apprentice')).toBe('Candidature pour la place d’apprentissage de gestionnaire du commerce de détail CFC');
    expect(letterSubject('it', 'Apprendista impiegato/a di commercio AFC', 'apprentice')).toBe('Candidatura per un posto di tirocinio come impiegato/a di commercio AFC');
    expect(letterSubject('en', 'Apprenticeship Commercial Employee EFZ', 'apprentice')).toBe('Application for the position of Apprenticeship Commercial Employee EFZ');
    // Nothing left, or not the trade alone: the general subject.
    expect(letterSubject('de', 'Lehrstellen 2027', 'apprentice')).toBe('Bewerbung als Lehrstellen 2027');
    expect(letterSubject('de', 'Lehrstelle in der Pflege', 'apprentice')).toBe('Bewerbung als Lehrstelle in der Pflege');
    // Never for a type that is not an apprenticeship.
    expect(letterSubject('de', 'Lehrstelle 2027: Informatiker/in EFZ', 'qualified')).toBe('Bewerbung als Lehrstelle 2027: Informatiker/in EFZ');
    expect(applicationEmailSubject('de', 'Lehrstelle 2027: Informatiker/in EFZ', 'Luka Kovačević', '', 'apprentice')).toBe('Bewerbung um die Lehrstelle als Informatiker/in EFZ – Luka Kovačević');
  });

  it('typesets the subject the PDF prints, and reads the title the letter prints as a name, not a claim', () => {
    const blocks = letterPdfBlocks({ identity: { name: 'Maria Rossi' }, companyName: 'Esempio SA', profile: {}, language: 'it', letter: { salutation: '', paragraphs: [], closing: '' }, title: 'Infermiere/a SUP 80-100%', now: new Date() });
    expect(blocks.subject).toBe(`Candidatura per la posizione di Infermiere/a SUP 80-100${NBSP}%`);
    const nurse = { text: 'Maria Rossi\nInfermiera, Ospedale Civico, 2018 – 2023', posting: 'Cerchiamo Infermiere/a SUP 80-100%.', answers: '', place: 'Lugano' };
    const subject = swissTypography(applicationEmailSubject('it', 'Infermiere/a SUP 80-100%', 'Maria Rossi'), 'it');
    const order = ['Infermiere/a SUP 80-100%', 'Ospedale Esempio SA', 'Maria Rossi'].join('\n');
    expect(checkDraftFacts({ emailSubject: subject }, { ...nurse, order, titles: printedTitles('it', 'Infermiere/a SUP 80-100%').join('\n') }).ok).toBe(true);
    // The apprenticeship's subject, which quotes the trade: its «EFZ» is the title's, not a diploma the CV must show.
    const pupil = { text: 'Luka Kovačević\nSekundarschule A\nKenntnisse: Python', posting: 'Lehrstelle 2027: Informatiker/in EFZ', answers: '', place: 'Winterthur' };
    const title = 'Lehrstelle 2027: Informatiker/in EFZ';
    const apprenticeSubject = applicationEmailSubject('de', title, 'Luka Kovačević', '', 'apprentice');
    expect(checkDraftFacts({ emailSubject: apprenticeSubject }, { ...pupil, order: [title, 'Alpina Systems AG', 'Luka Kovačević'].join('\n') }).unsupported.map((item: any) => item.token)).toContain('EFZ');
    expect(checkDraftFacts({ emailSubject: apprenticeSubject }, { ...pupil, order: [title, 'Alpina Systems AG', 'Luka Kovačević'].join('\n'), titles: printedTitles('de', title, 'apprentice').join('\n') }).ok).toBe(true);
  });

  it('frames the application e-mail like the letter, removing a greeting or a closing the model wrote anyway', () => {
    const signature = ['Maria Rossi', 'candidatura-x1@frontaliereticino.ch'];
    expect(applicationEmailText('Gentili Signori,\nin allegato CV e lettera.\nCordiali saluti', { language: 'it', signature }))
      .toBe('Gentili signore e signori,\n\nin allegato CV e lettera.\n\nCordiali saluti');
    expect(applicationEmailText('Gentile signora Rossi, Le invio in allegato la mia candidatura.\n\nIn attesa di un Suo riscontro, porgo cordiali saluti.\nMaria Rossi', { language: 'it', contactPerson: 'Signora Laura Rossi', signature }))
      .toBe('Gentile signora Rossi,\n\nLe invio in allegato la mia candidatura.\n\nCordiali saluti');
    // German: no comma after the salutation, a capital after it, the letter's closing.
    expect(applicationEmailText('Sehr geehrte Frau Muster,\n\nanbei sende ich Ihnen meine Bewerbung.\n\nMit freundlichen Grüßen\nMaria Rossi', { language: 'de', contactPerson: 'Frau Anna Muster', signature }))
      .toBe('Sehr geehrte Frau Muster\n\nAnbei sende ich Ihnen meine Bewerbung.\n\nFreundliche Grüsse');
    expect(applicationEmailText('Madame, Monsieur, je vous adresse ma candidature.\n\nJe vous prie d’agréer, Madame, Monsieur, l’expression de mes salutations distinguées.', { language: 'fr', signature }))
      .toBe('Madame, Monsieur,\n\nJe vous adresse ma candidature.\n\nJe vous prie de recevoir, Madame, Monsieur, mes meilleures salutations.');
    expect(applicationEmailText('Dear Dr. Muster,\nPlease find attached my application.\nKind regards,\nMaria Rossi\ncandidatura-x1@frontaliereticino.ch', { language: 'en', contactPerson: 'Dr Anna Muster', signature }))
      .toBe('Dear Dr Muster\n\nPlease find attached my application.\n\nKind regards');
    // A sentence that only starts like a greeting is the message.
    expect(applicationEmailText('Madame Dupont m’a recommandé de vous écrire.', { language: 'fr', signature })).toContain('\n\nMadame Dupont m’a recommandé de vous écrire.\n\n');
    expect(applicationEmailText('Cordiali saluti', { language: 'it', signature })).toBe('');
  });
});

// The review of the package (2026-10-03): each case printed a wrong formula, cut the candidate's text or let
// a claim through. Invented contacts, invented postings.
describe('letter formulas: the cases of the review', () => {
  it('keeps a diploma the text claims a claim: the subject quoted whole is a name, the trade alone is not', () => {
    const claimed = (language: string, title: string, cv: string, claim: string) => {
      const sources = { text: cv, posting: title, answers: '', place: 'Lugano', order: [title, 'Esempio SA', cv.split('\n')[0]].join('\n'), titles: printedTitles(language, title, 'apprentice').join('\n') };
      return { claim: checkDraftFacts({ coverLetter: claim }, sources).unsupported.map((item: any) => item.token), subject: checkDraftFacts({ emailSubject: applicationEmailSubject(language, title, cv.split('\n')[0], '', 'apprentice') }, sources).ok };
    };
    expect(claimed('de', 'Lehrstelle 2027: Informatiker/in EFZ', 'Luka Kovačević\nSekundarschule A, 2023 – 2026', 'Ich bin bereits Informatiker/in EFZ und kenne die Abläufe.'))
      .toEqual({ claim: ['EFZ'], subject: true });
    expect(claimed('it', 'Apprendista impiegato/a di commercio AFC', 'Sara Esempio\nScuola media di Lugano, 2023 – 2026', 'Sono impiegato/a di commercio AFC e conosco già il lavoro d’ufficio.'))
      .toEqual({ claim: ['AFC'], subject: true });
    expect(claimed('fr', 'Apprenti·e employé·e de commerce CFC', 'Élodie Exemple\nÉcole secondaire, 2023 – 2026', 'Je suis employé·e de commerce CFC depuis deux ans.'))
      .toEqual({ claim: ['CFC'], subject: true });
    // The subject's own words («tirocinio», «posto», «place», «candidature») back no job title the text claims:
    // the printed titles are names quoted whole, never words of the order line.
    expect(claimed('it', 'Apprendista impiegato/a di commercio AFC', 'Sara Esempio\nScuola media di Lugano, 2023 – 2026', 'Ho già lavorato come Tirocinante in uno studio.').claim)
      .toContain('Tirocinante');
    expect(claimed('fr', 'Apprenti·e employé·e de commerce CFC', 'Élodie Exemple\nÉcole secondaire, 2023 – 2026', 'J’ai déjà travaillé en tant que Placeur dans un cinéma.').claim)
      .toContain('Placeur');
  });

  it('reads a second honorific on the line as a second person, never a mix', () => {
    expect(letterSalutation('de', 'Frau Anna Muster Herr Peter Meier')).toBe('Sehr geehrte Damen und Herren');
    expect(letterSalutation('de', 'Frau Muster\nHerr Meier')).toBe('Sehr geehrte Damen und Herren');
    expect(letterSalutation('de', 'Herr Meier Frau Muster')).toBe('Sehr geehrte Damen und Herren');
    expect(letterSalutation('it', 'Signora Rossi Signor Bianchi')).toBe('Gentili signore e signori,');
    expect(letterSalutation('en', 'Ms Smith Mr Jones')).toBe('Dear Sir or Madam');
    expect(letterSalutation('fr', 'Madame Dupont Monsieur Martin')).toBe('Madame, Monsieur,');
  });

  it('reads a full name after a comma as a second person, and a function before a bare name as no name', () => {
    expect(letterSalutation('de', 'Anna Muster, Peter Meier')).toBe('Sehr geehrte Damen und Herren');
    expect(letterSalutation('it', 'Maria Rossi, Marco Bianchi')).toBe('Gentili signore e signori,');
    expect(letterSalutation('en', 'Jane Smith, John Jones')).toBe('Dear Sir or Madam');
    expect(letterSalutation('de', 'Anna Muster, Herr Peter Meier')).toBe('Sehr geehrte Damen und Herren');
    expect(letterSalutation('it', 'Maria Rossi, Sig. Marco Bianchi')).toBe('Gentili signore e signori,');
    // A function or a department after the comma is no second person.
    expect(letterSalutation('de', 'Peter Meier, Leiter Logistik')).toBe('Guten Tag Peter Meier');
    expect(letterSalutation('de', 'Frau Anna Muster, Teamleiterin Pflege')).toBe('Sehr geehrte Frau Muster');
    expect(letterSalutation('it', 'Maria Rossi, Responsabile Vendite')).toBe('Gentile Maria Rossi,');
    expect(letterSalutation('en', 'Jane Smith, Hiring Manager')).toBe('Dear Jane Smith');
    // A function before a bare name is no part of it.
    expect(letterSalutation('de', 'Geschäftsführer Peter Muster')).toBe('Sehr geehrte Damen und Herren');
    expect(letterSalutation('it', 'Responsabile Marco Bianchi')).toBe('Gentili signore e signori,');
  });

  it('keeps a French first sentence about a person: a greeting with a name is one only alone or before the message', () => {
    const first = (text: string) => applyLetterConventions({ paragraphs: [text, 'Deuxième paragraphe.'] }, { language: 'fr' }).paragraphs[0];
    expect(first('Madame Keller, que j’ai rencontrée au salon des métiers, m’a parlé de votre entreprise.')).toBe('Madame Keller, que j’ai rencontrée au salon des métiers, m’a parlé de votre entreprise.');
    expect(first('Monsieur Rossi, votre collègue, m’a conseillé de postuler à ce poste.')).toBe('Monsieur Rossi, votre collègue, m’a conseillé de postuler à ce poste.');
    expect(applicationEmailText('Madame Keller, responsable de votre filiale de Lausanne, m’a parlé de ce poste.', { language: 'fr', signature: ['Maria Rossi'] }))
      .toBe('Madame, Monsieur,\n\nMadame Keller, responsable de votre filiale de Lausanne, m’a parlé de ce poste.\n\nJe vous prie de recevoir, Madame, Monsieur, mes meilleures salutations.');
    expect(first('Madame Dupont,\nje vous adresse ma candidature.')).toBe('Je vous adresse ma candidature.');
    expect(first('Madame Dupont, je vous adresse ma candidature.')).toBe('Je vous adresse ma candidature.');
    expect(first('Monsieur Martin, suite à votre annonce, j’ai le plaisir de postuler.')).toBe('Suite à votre annonce, j’ai le plaisir de postuler.');
    expect(first('Madame, Monsieur, votre annonce a retenu mon attention.')).toBe('Votre annonce a retenu mon attention.');
  });

  it('removes the greetings and closings models write most, and a signature in its own form', () => {
    const email = (body: string, language: string) => applicationEmailText(body, { language, signature: ['Maria Rossi', 'candidatura-x1@frontaliereticino.ch', '+41 79 000 00 00'] });
    expect(email('Dear Sir/Madam,\n\nPlease find my application attached.', 'en')).toBe('Dear Sir or Madam\n\nPlease find my application attached.\n\nKind regards');
    expect(email('Hi Jane,\n\nplease find my application attached.', 'en')).toBe('Dear Sir or Madam\n\nPlease find my application attached.\n\nKind regards');
    expect(email('Liebes Recruiting-Team,\n\nanbei finden Sie meine Unterlagen.', 'de')).toBe('Sehr geehrte Damen und Herren\n\nAnbei finden Sie meine Unterlagen.\n\nFreundliche Grüsse');
    expect(email('Chère Madame, cher Monsieur,\n\nje vous adresse ma candidature.', 'fr'))
      .toBe('Madame, Monsieur,\n\nJe vous adresse ma candidature.\n\nJe vous prie de recevoir, Madame, Monsieur, mes meilleures salutations.');
    expect(email('Mesdames et Messieurs,\nje vous adresse ma candidature.', 'fr'))
      .toBe('Madame, Monsieur,\n\nJe vous adresse ma candidature.\n\nJe vous prie de recevoir, Madame, Monsieur, mes meilleures salutations.');
    // The code's own Italian greeting, written by the model: «signore» is not cut to «signor».
    expect(email('Gentili signore e signori,\nin allegato CV e lettera.', 'it')).toBe('Gentili signore e signori,\n\nin allegato CV e lettera.\n\nCordiali saluti');
    expect(email('Please find my application attached.\n\nThank you for your consideration.\nBest regards,\nMaria', 'en'))
      .toBe('Dear Sir or Madam\n\nPlease find my application attached.\n\nThank you for your consideration.\n\nKind regards');
    expect(email('in allegato CV e lettera.\n\nRingraziando per l’attenzione, porgo cordiali saluti.', 'it')).toBe('Gentili signore e signori,\n\nin allegato CV e lettera.\n\nCordiali saluti');
    expect(email('Anbei meine Unterlagen.\n\nFreundliche Grüsse\nMaria Rossi\n+41790000000', 'de')).toBe('Sehr geehrte Damen und Herren\n\nAnbei meine Unterlagen.\n\nFreundliche Grüsse');
    expect(email('Anbei meine Unterlagen.\n\nMit freundlichen Grüssen,\nM. Rossi', 'de')).toBe('Sehr geehrte Damen und Herren\n\nAnbei meine Unterlagen.\n\nFreundliche Grüsse');
    // A last line that says more than a courtesy before «porgo … saluti» is the candidate's text.
    expect(email('in allegato CV e lettera.\n\nSono disponibile da gennaio 2027, porgo cordiali saluti.', 'it')).toContain('Sono disponibile da gennaio 2027');
  });

  it('keeps a French last paragraph that asks for something, and still removes the closing formula', () => {
    const paragraphs = (last: string) => applyLetterConventions({ paragraphs: ['Premier paragraphe.', last] }, { language: 'fr' }).paragraphs;
    expect(paragraphs('Veuillez prendre ma candidature en considération.')).toEqual(['Premier paragraphe.', 'Veuillez prendre ma candidature en considération.']);
    expect(paragraphs('Je vous prie de bien vouloir examiner ma candidature avec considération.')).toEqual(['Premier paragraphe.', 'Je vous prie de bien vouloir examiner ma candidature avec considération.']);
    expect(applicationEmailText('Vous trouverez mon dossier ci-joint.\n\nVeuillez prendre ma candidature en considération.', { language: 'fr', signature: [] }))
      .toContain('Veuillez prendre ma candidature en considération.');
    expect(paragraphs('Je vous prie d’agréer, Madame, Monsieur, l’assurance de ma considération distinguée.')).toEqual(['Premier paragraphe.']);
    expect(paragraphs('Veuillez recevoir, Madame, Monsieur, mes salutations distinguées.')).toEqual(['Premier paragraphe.']);
  });

  it('elides «de» by the title’s first word, an acronym on a vowel included', () => {
    expect(letterSubject('fr', 'Employé·e d’office')).toBe('Candidature au poste d’Employé·e d’office');
    expect(letterSubject('fr', 'Aide d’office')).toBe('Candidature au poste d’Aide d’office');
    expect(letterSubject('fr', 'Ingénieur hardware')).toBe('Candidature au poste d’Ingénieur hardware');
    expect(letterSubject('fr', 'Ingénieur·e help desk')).toBe('Candidature au poste d’Ingénieur·e help desk');
    expect(letterSubject('fr', 'ASSC – Assistant·e en soins et santé communautaire')).toBe('Candidature au poste d’ASSC – Assistant·e en soins et santé communautaire');
    // An English first word, an acronym on a consonant or on «H»: «de».
    expect(letterSubject('fr', 'Office Manager')).toBe('Candidature au poste de Office Manager');
    expect(letterSubject('fr', 'HR Business Partner')).toBe('Candidature au poste de HR Business Partner');
    expect(letterSubject('fr', 'SAP Consultant')).toBe('Candidature au poste de SAP Consultant');
  });

  it('prints the locality alone: no stray dash, canton or province code, region or province', () => {
    const placeDate = (location: string) => letterPdfBlocks({ identity: { name: 'Maria Rossi' }, companyName: 'Esempio SA', profile: { location }, language: 'it', letter: { salutation: '', paragraphs: [], closing: '' }, title: 'x', now: new Date(Date.UTC(2026, 9, 3, 12)) }).placeDate;
    expect(placeDate('Via Roma, 3 - Como')).toBe('Como, 3 ottobre 2026');
    expect(placeDate('Via Roma 3 – Como')).toBe('Como, 3 ottobre 2026');
    expect(placeDate('6900 Lugano TI')).toBe('Lugano, 3 ottobre 2026');
    expect(placeDate('Provincia di Como')).toBe('3 ottobre 2026');
    expect(localityOf('Canton Ticino')).toBe('');
    expect(localityOf('Lombardia, Italia')).toBe('');
    expect(localityOf('Varese VA')).toBe('Varese');
    expect(localityOf('St. Gallen')).toBe('St. Gallen');
  });
});

// The re-check of the fix pass (2026-10-04): each case printed a formula twice, a wrong surname or a canton, or
// cut the candidate's text. Invented contacts, invented postings.
describe('letter formulas: the cases of the re-check', () => {
  it('removes a greeting line whatever its words, and the closings joined by «e»', () => {
    const email = (body: string, language: string, contactPerson = '') => applicationEmailText(body, { language, contactPerson, signature: ['Maria Rossi'] });
    const greeted = (greeting: string, contactPerson: string, salutation: string) => expect(email(`${greeting}\nin allegato CV e lettera.`, 'it', contactPerson))
      .toBe(`${salutation}\n\nin allegato CV e lettera.\n\nCordiali saluti`);
    greeted('Gentile sig.ra Bianchi,', 'Sig.ra Laura Bianchi', 'Gentile signora Bianchi,');
    greeted('Gentile dott.ssa Bianchi,', 'Dott.ssa Laura Bianchi', 'Gentile signora Bianchi,');
    greeted('Gentile dottoressa Bianchi,', 'Dott.ssa Laura Bianchi', 'Gentile signora Bianchi,');
    greeted('Egregio sig. Verdi,', 'Sig. Marco Verdi', 'Gentile signor Verdi,');
    greeted('Spettabile azienda,', '', 'Gentili signore e signori,');
    greeted('Gentile responsabile delle risorse umane,', '', 'Gentili signore e signori,');
    expect(email('Dear Hiring Team at Esempio SA,\n\nPlease find my application attached.', 'en')).toBe('Dear Sir or Madam\n\nPlease find my application attached.\n\nKind regards');
    // On the message's own line, before its comma; and the letter's first paragraph alike.
    expect(email('Gentile dott.ssa Bianchi, Le invio la mia candidatura.', 'it', 'Dott.ssa Laura Bianchi')).toBe('Gentile signora Bianchi,\n\nLe invio la mia candidatura.\n\nCordiali saluti');
    expect(applyLetterConventions({ paragraphs: ['Gentile sig.ra Bianchi,', 'sono infermiera da sei anni.'] }, { language: 'it', contactPerson: 'Sig.ra Laura Bianchi' }).paragraphs)
      .toEqual(['sono infermiera da sei anni.']);
    // A first line that only starts like a greeting is the message.
    expect(email('Liebe zum Detail zeichnet meine Arbeit aus.\nAnbei meine Unterlagen.', 'de')).toContain('\n\nLiebe zum Detail zeichnet meine Arbeit aus.\nAnbei meine Unterlagen.\n\n');
    const closed = (last: string) => email(`in allegato CV e lettera.\n\n${last}`, 'it');
    expect(closed('Ringrazio per l’attenzione e porgo cordiali saluti.')).toBe('Gentili signore e signori,\n\nin allegato CV e lettera.\n\nCordiali saluti');
    expect(closed('La ringrazio per l’attenzione e Le porgo distinti saluti.')).toBe('Gentili signore e signori,\n\nin allegato CV e lettera.\n\nCordiali saluti');
    expect(closed('Colgo l’occasione per porgere distinti saluti.')).toBe('Gentili signore e signori,\n\nin allegato CV e lettera.\n\nCordiali saluti');
    expect(email('Please find my application attached.\n\nMany thanks and kind regards', 'en')).toBe('Dear Sir or Madam\n\nPlease find my application attached.\n\nKind regards');
  });

  it('cuts a function run into the contact’s name after two name words, else gives the unnamed form', () => {
    // Two lines of a contact block, flattened: the name, then the function.
    expect(letterSalutation('de', 'Frau Anna Muster\nLeiterin Logistik')).toBe('Sehr geehrte Frau Muster');
    expect(letterSalutation('de', 'Herr Peter Meier\nGeschäftsführer')).toBe('Sehr geehrter Herr Meier');
    expect(letterSalutation('de', 'Herr Peter Meier Teamleiter Einkauf')).toBe('Sehr geehrter Herr Meier');
    expect(letterSalutation('it', 'Signora Maria Rossi\nResponsabile Vendite')).toBe('Gentile signora Rossi,');
    expect(letterSalutation('it', 'Sig. Marco Bianchi\nDirettore')).toBe('Gentile signor Bianchi,');
    expect(letterSalutation('it', 'Signora Maria De Luca Responsabile Vendite')).toBe('Gentile signora De Luca,');
    expect(letterSalutation('en', 'Ms Jane Smith\nHead of Talent')).toBe('Dear Ms Smith');
    expect(letterSalutation('fr', 'Madame Claire Dupont\nDirectrice')).toBe('Madame,');
    // Which words are the name is unknown: one name word, three, or a last word that may be the surname.
    expect(letterSalutation('de', 'Frau Anna Leiter')).toBe('Sehr geehrte Damen und Herren');
    expect(letterSalutation('de', 'Herr Hans Peter Leiter')).toBe('Sehr geehrte Damen und Herren');
    expect(letterSalutation('en', 'Mr John Smith\nOperations Manager')).toBe('Dear Sir or Madam');
    // French greets by the honorific alone: its gender stays.
    expect(letterSalutation('fr', 'Madame Claire Leiter')).toBe('Madame,');
  });

  it('keeps a last line that says more than the closing formula, and still removes the formula', () => {
    const paragraphs = (language: string, last: string) => applyLetterConventions({ paragraphs: ['Primo paragrafo.', last] }, { language }).paragraphs;
    for (const last of [
      'Grazie per l’attenzione, sono disponibile dal 1° marzo 2027, porgo cordiali saluti.',
      'Ringraziando per l’attenzione, resto a disposizione per un colloquio, porgo cordiali saluti.',
      'In attesa di un Suo riscontro, sono disponibile da subito per un colloquio, porgo distinti saluti.',
      'Ringrazio per l’attenzione e sono disponibile per un colloquio e porgo cordiali saluti.',
      'Ringrazio per l’attenzione e sono disponibile per un colloquio, porgo cordiali saluti.',
    ]) expect(paragraphs('it', last)).toEqual(['Primo paragrafo.', last]);
    for (const last of [
      'Je vous prie de bien vouloir m’accorder un entretien et de recevoir mes salutations distinguées.',
      'Dans l’attente de votre réponse, et disponible pour un entretien dès le 1er mars, je vous prie d’agréer mes salutations distinguées.',
      'Veuillez noter que je suis disponible dès le 1er mars et recevez mes salutations.',
      'Je vous adresse mes salutations et reste à votre disposition.',
    ]) expect(paragraphs('fr', last)).toEqual(['Primo paragrafo.', last]);
    expect(paragraphs('it', 'In attesa di un Suo riscontro, Le porgo cordiali saluti.')).toEqual(['Primo paragrafo.']);
    expect(paragraphs('it', 'Ringraziando per l’attenzione e restando in attesa di un Suo riscontro, porgo cordiali saluti.')).toEqual(['Primo paragrafo.']);
    expect(paragraphs('fr', 'Je vous prie de croire, Madame, Monsieur, à l’expression de mes sentiments distingués.')).toEqual(['Primo paragrafo.']);
    expect(paragraphs('fr', 'Veuillez agréer, Madame, Monsieur, mes salutations les plus distinguées.')).toEqual(['Primo paragrafo.']);
    expect(applicationEmailText('in allegato CV e lettera.\nGrazie per l’attenzione, sono disponibile anche il sabato per un colloquio, porgo cordiali saluti.', { language: 'it', signature: [] }))
      .toContain('sono disponibile anche il sabato per un colloquio');
  });

  it('prints no canton for a locality, and reads a part after a dash on its own', () => {
    for (const canton of ['Aargau', 'Argovie', 'Thurgau', 'Turgovia', 'Jura', 'Uri', 'Obwalden', 'Nidwalden', 'Basel-Landschaft', 'Bâle-Campagne', 'Basilea Campagna']) {
      expect(localityOf(canton)).toBe('');
    }
    expect(localityOf('Bellinzona – Ticino')).toBe('Bellinzona');
    expect(localityOf('Ticino – Bellinzona')).toBe('Bellinzona');
    expect(localityOf('Aarau, Aargau')).toBe('Aarau');
    expect(localityOf('Liestal BL')).toBe('Liestal');
  });
});

// The second re-check (2026-10-04): a courtesy with a second object printed twice, a line that only starts like a
// greeting was dropped, three closings still printed twice. Invented contacts, invented texts.
describe('letter formulas: the cases of the second re-check', () => {
  const paragraphs = (language: string, last: string) => applyLetterConventions({ paragraphs: ['Primo paragrafo.', last] }, { language }).paragraphs;
  const email = (body: string, language: string) => applicationEmailText(body, { language, signature: ['Maria Rossi'] });

  it('removes an Italian courtesy with a second object, and keeps a second clause with a verb of its own', () => {
    for (const last of [
      'Ringraziando per l’attenzione dedicata e per la disponibilità, porgo cordiali saluti.',
      'Ringraziando per l’attenzione e per il tempo dedicatomi, porgo distinti saluti.',
      'La ringrazio per l’attenzione e la disponibilità e Le porgo cordiali saluti.',
    ]) expect(paragraphs('it', last)).toEqual(['Primo paragrafo.']);
    for (const last of [
      'Ringraziando per l’attenzione e sperando di discutere del mio progetto, porgo cordiali saluti.',
      'Ringraziando per l’attenzione e per la possibilità di presentare il mio progetto, porgo cordiali saluti.',
    ]) expect(paragraphs('it', last)).toEqual(['Primo paragrafo.', last]);
  });

  it('reads a line that only starts like a greeting as the message: a colon after «Dear» alone, «Liebe» before a name alone', () => {
    expect(email('Liebe zum Detail und Teamgeist:\n- Erfahrung im Verkauf', 'de'))
      .toBe('Sehr geehrte Damen und Herren\n\nLiebe zum Detail und Teamgeist:\n- Erfahrung im Verkauf\n\nFreundliche Grüsse');
    expect(email('Liebe zum Detail und Teamgeist,\nzeichnen meine Arbeit aus.', 'de')).toContain('\n\nLiebe zum Detail und Teamgeist,\nzeichnen meine Arbeit aus.\n\n');
    expect(email('Gentile e disponibile con la clientela:\n- vendita al banco', 'it')).toContain('\n\nGentile e disponibile con la clientela:\n- vendita al banco\n\n');
    // The greetings still go.
    expect(email('Dear hiring team of Esempio SA:\nplease find my application attached.', 'en')).toBe('Dear Sir or Madam\n\nPlease find my application attached.\n\nKind regards');
    expect(email('Lieber Herr Meier,\nanbei meine Unterlagen.', 'de')).toBe('Sehr geehrte Damen und Herren\n\nAnbei meine Unterlagen.\n\nFreundliche Grüsse');
    expect(email('Liebes Team der Muster AG,\nanbei meine Unterlagen.', 'de')).toBe('Sehr geehrte Damen und Herren\n\nAnbei meine Unterlagen.\n\nFreundliche Grüsse');
  });

  it('removes the French, German and English closings joined to a courtesy, and keeps a line that says more', () => {
    for (const [language, last] of [
      ['fr', 'Je vous remercie de votre attention et vous prie d’agréer, Madame, Monsieur, mes salutations distinguées.'],
      ['fr', 'Je vous remercie de votre attention et vous prie de recevoir, Madame, Monsieur, mes meilleures salutations.'],
      ['de', 'Ich freue mich auf Ihre Rückmeldung und grüsse Sie freundlich.'],
      ['de', 'Ich freue mich auf Ihre Rückmeldung und grüße Sie freundlich.'],
      ['en', 'Thanks and regards'],
      ['en', 'Thank you and best regards'],
    ]) expect(paragraphs(language, last)).toEqual(['Primo paragrafo.']);
    // The e-mail reads the closing before the typography: «grüße» as the model wrote it.
    expect(email('Anbei meine Unterlagen.\n\nIch freue mich auf Ihre Rückmeldung und grüße Sie freundlich.', 'de'))
      .toBe('Sehr geehrte Damen und Herren\n\nAnbei meine Unterlagen.\n\nFreundliche Grüsse');
    for (const [language, last] of [
      ['fr', 'Je vous remercie de votre attention, je suis disponible dès le 1er mars et vous prie d’agréer mes salutations distinguées.'],
      ['fr', 'Je vous remercie de votre attention et me réjouis de vous rencontrer et vous prie d’agréer mes salutations distinguées.'],
      ['de', 'Ich freue mich auf ein persönliches Gespräch und grüsse Sie freundlich.'],
      ['de', 'Ich freue mich auf Ihre Rückmeldung, bin ab März verfügbar und grüsse Sie freundlich.'],
      ['en', 'Thanks again for considering my application and regards'],
    ]) expect(paragraphs(language, last)).toEqual(['Primo paragrafo.', last]);
  });
});

// The third re-check (2026-10-04): the Italian wish to meet and the German closing in inverted order printed
// twice. Invented texts.
describe('letter formulas: the cases of the third re-check', () => {
  const paragraphs = (language: string, last: string) => applyLetterConventions({ paragraphs: ['Primo paragrafo.', last] }, { language }).paragraphs;

  it('removes the Italian wish to meet from a closed list, and keeps a wish with a verb outside it', () => {
    for (const last of [
      'Ringraziando per l’attenzione e sperando di poterLa incontrare, porgo distinti saluti.',
      'Ringraziando per l’attenzione e sperando di poterVi incontrare presto di persona, porgo cordiali saluti.',
      'La ringrazio per l’attenzione e nella speranza di poterLa incontrare per un colloquio, Le porgo distinti saluti.',
      'Ringraziando per l’attenzione e sperando di poterla incontrare in un colloquio, porgo cordiali saluti.',
      'Nella speranza di poterLa incontrare, porgo distinti saluti.',
      'Ringraziando per l’attenzione e in attesa di un Vostro riscontro, porgo cordiali saluti.',
    ]) expect(paragraphs('it', last)).toEqual(['Primo paragrafo.']);
    for (const last of [
      'Ringraziando per l’attenzione e sperando di discutere del mio progetto, porgo cordiali saluti.',
      'Ringraziando per l’attenzione e sperando di poterLa incontrare per presentarLe il mio progetto, porgo cordiali saluti.',
    ]) expect(paragraphs('it', last)).toEqual(['Primo paragrafo.', last]);
  });

  it('removes the German closing in inverted order, and keeps a line that says more', () => {
    for (const last of [
      'In Erwartung Ihrer baldigen Antwort grüsse ich Sie freundlich.',
      'In Erwartung Ihrer Rückmeldung grüße ich Sie herzlich.',
      'Mit Vorfreude auf Ihre Rückmeldung grüsse ich Sie freundlich.',
    ]) expect(paragraphs('de', last)).toEqual(['Primo paragrafo.']);
    // The e-mail reads the closing before the typography: «grüße» as the model wrote it.
    expect(applicationEmailText('Anbei meine Unterlagen.\n\nIn Erwartung Ihrer positiven Nachricht grüße ich Sie freundlich.', { language: 'de', signature: ['Maria Rossi'] }))
      .toBe('Sehr geehrte Damen und Herren\n\nAnbei meine Unterlagen.\n\nFreundliche Grüsse');
    for (const last of [
      'In Erwartung Ihrer Antwort und eines persönlichen Gesprächs grüsse ich Sie freundlich.',
      'Mit Vorfreude auf ein persönliches Gespräch grüsse ich Sie freundlich.',
      'In Erwartung Ihrer Antwort bin ich ab März verfügbar und grüsse Sie freundlich.',
    ]) expect(paragraphs('de', last)).toEqual(['Primo paragrafo.', last]);
  });
});

describe('letter PDF', () => {
  it('writes a letter the standard font lacks with its base letter, never "?"', async () => {
    // The label carries its own colon (letterPdfBlocks: «Annexes :», «Allegato:»).
    const pdf = buildCoverLetterPdf({ senderLines: ['Luka Kovačević', 'Łódź'], paragraphs: ['Test'], signature: 'Luka Kovačević', enclosuresLabel: 'Beilagen:', enclosures: ['Lebenslauf', 'Multicheck ICT'] });
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
    // Rebuilt today: its writer is recorded, and it is in Storage nowhere yet.
    expect(rebuilt).toMatchObject({ renderer: 'typst', key: null });
    const text = await extractPdfText(rebuilt.pdf);
    expect(text).toContain('Via Esempio 3');
    expect(text).toContain('Allegati: Curriculum vitae, Diplomi');
    // Review of PR 10919: a waived document (no file) is not listed. One enclosure: the singular (Città di Lugano).
    const waived = await extractPdfText((await letterForSubmission({ bucket: bucket('stored'), order, orderId: 'order_X', draft, flow: { documents: { diplomi: { waivedAt: 1 } } }, nowMs: Date.now() })).pdf);
    expect(waived).toContain('Allegato: Curriculum vitae');
    expect(waived).not.toContain('Diplomi');
    expect(enclosedDocumentLabels({ requiredDocuments: [{ id: 'diploma', label: 'Diploma', kind: 'diploma', required: true }] }, null, 'order-1')).toEqual(['Diploma']);
    expect(enclosedDocumentLabels({ requiredDocuments: [{ id: 'diploma', label: 'Diploma', kind: 'diploma', required: true }] }, { documents: { diploma: { waivedAt: 1 } } }, 'order-1')).toEqual([]);
    const older = await letterForSubmission({ bucket: bucket('stored'), order, orderId: 'order_X', draft: { ...draft, letterAddress: undefined, coverLetterPdfKey: 'k' }, flow: {}, nowMs: Date.now() });
    expect(older.pdf.toString()).toBe('stored');
    // The stored file leaves: its key, and no writer when the draft does not record one.
    expect(older).toMatchObject({ renderer: null, key: 'k' });
  });
});

describe('index without options keeps the old behaviour (interview prep, follow-ups)', () => {
  it('lets any source back a figure and checks no tool', () => {
    const index = buildFactIndex([DEV.text, DEV.posting]);
    expect(checkGeneratedFacts({ answer: 'Il team cerca 5 anni di esperienza con Kubernetes.' }, index)).toEqual({ ok: true, unsupported: [], advisories: [] });
  });
});
