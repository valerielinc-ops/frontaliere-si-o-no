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
