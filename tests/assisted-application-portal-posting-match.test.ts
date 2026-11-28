import { describe, expect, it } from 'vitest';
import {
  applicationEntryControls,
  formPostingMatch,
  jobRoomExternalAdTarget,
  namesAnotherEmployer,
  resolvedPostingUrlForIdentity,
} from '../scripts/assisted-application/lib/portal/portal.mjs';

describe('application form posting identity', () => {
  it('keeps the opened posting URL when legacy context has no saved posting URL', () => {
    expect(resolvedPostingUrlForIdentity('', 'https://jobs.example.test/42')).toBe('https://jobs.example.test/42');
    expect(resolvedPostingUrlForIdentity('https://jobs.example.test/selected', 'https://jobs.example.test/42'))
      .toBe('https://jobs.example.test/selected');
  });

  it('matches the source language title when the draft title is localized', () => {
    const job = {
      title: 'Operatrice sociosanitaria',
      sourceTitle: 'Pflegefachfrau Gesundheit 80–100% (m/w/d)',
      sourceLang: 'de',
      titleByLocale: {
        de: 'Pflegefachfrau Gesundheit 80–100% (m/w/d)',
        it: 'Operatrice sociosanitaria',
      },
    };

    expect(formPostingMatch('Pflegefachfrau Gesundheit 80% (H/F) - Bewerbung', job, {
      pageUrl: 'https://careers.example.test/application/new',
    })).toBe('match');
  });

  it('keeps a cross-language ATS role heading unknown', () => {
    const job = {
      title: 'Pflegefachfrau Gesundheit',
      sourceTitle: 'Pflegefachfrau Gesundheit',
      sourceLang: 'de',
    };

    expect(formPostingMatch('Développeur logiciel\nVorname\nNachname', job, {
      postingMatched: true,
      applicationEntry: true,
    })).toBe('unknown');
  });

  it('normalizes slash-in, workload and M/F/D variants', () => {
    expect(formPostingMatch('Sachbearbeiter Buchhaltung 80% (M/F/D) - Bewerbung', {
      title: 'Impiegata amministrativa',
      sourceTitle: 'Sachbearbeiter/-in Buchhaltung 80–100% (m/w/d)',
    }, { pageUrl: 'https://careers.example.test/application/new' })).toBe('match');
  });

  it('binds a Umantis module to the same vacancy ID on its host', () => {
    const postingUrl = 'https://recruitingapp-2800.umantis.com/Vacancies/6604/Description/1';
    const applicationUrl = 'https://recruitingapp-2800.umantis.com/Vacancies/6604/Application/New/1';
    expect(formPostingMatch('Bewerbung\nVorname\nNachname\nE-Mail-Adresse', {
      title: 'Impiegata amministrativa', company: 'Ente Esempio',
    }, { pageUrl: applicationUrl, postingUrl })).toBe('match');
  });

  it('uses the Umantis application vacancy ID when liveness keeps the published listing URL', () => {
    const applicationUrl = 'https://recruitingapp-9000.umantis.com/Vacancies/7351/Application/New/1';
    const job = { title: 'Tecnico amministrativo', company: 'Ente Esempio' };
    const form = 'Application Tracking System\nE-Mail-Adresse\nVorname\nNachname\nWeiter';

    expect(formPostingMatch(form, job, {
      pageUrl: applicationUrl,
      postingUrl: 'https://careers.example.test/jobs/tecnico-amministrativo/',
    })).toBe('match');
    expect(formPostingMatch(form, job, {
      pageUrl: applicationUrl,
      postingUrl: 'https://recruitingapp-9000.umantis.com/Vacancies/7352/Description/1',
    })).toBe('mismatch');
    expect(formPostingMatch(form, job, {
      applicationEntry: true,
      pageUrl: applicationUrl,
      postingUrl: 'https://jobs.example.test/jobs/other-role-7352/',
    })).toBe('mismatch');
  });

  it('recognizes localized SuccessFactors login fields as the start of a generic form', () => {
    const postingUrl = 'https://jobs.example.test/job/example-role/123456/';
    const moduleUrl = 'https://career2.successfactors.eu/career?company=EXAMPLE&career_job_req_id=321';
    const proof = { via: 'successfactors', applyUrl: moduleUrl, postingUrl };
    const job = { title: 'Example Role', company: 'Example Employer' };
    const form = 'Karrierechancen: Anmelden\nE-Mail-Adresse\nKennwort\nBewerbung abschicken';

    expect(formPostingMatch(form, job, {
      postingMatched: true,
      postingEntry: true,
      pageUrl: 'https://career2.successfactors.eu/portalcareer',
      postingUrl,
      postingRouteProof: proof,
    })).toBe('match');
  });

  it('binds a SuccessFactors Coop form when native questions are the only employer text', () => {
    const postingUrl = 'https://jobs.coopjobs.ch/offene-stellen/macellaia/example-posting';
    const applyUrl = 'https://career2.successfactors.eu/career?company=Coop&career_ns=job_application&career_job_req_id=171248';
    const proof = { via: 'successfactors', applyUrl, postingUrl };
    const pageUrl = 'https://career2.successfactors.eu/portalcareer';
    const fields = [
      'Lingua',
      '* Appellativo',
      '* Nome',
      '* Cognome',
      '* Prefisso internazionale',
      '* Telefono',
      '* Ricevere avvisi tramite SMS',
      '* Indirizzo e-mail',
      '* Via e numero civico',
      "* Numero d'avviamento postale",
      '* Località',
      '* Paese',
      '* Acconsento alla trasmissione dei miei dati ad aziende all’interno del Gruppo Coop al fine dello svolgimento dell’iter',
      '* Sono già collaboratore/trice presso il Gruppo Coop',
      '* Questa domanda proviene da un collocatore di personale?',
      'Data di nascita',
      '* Hai una formazione come macellaio/macellaia o come panettiera/panettiere o hai già lavorato in questo settore?',
      '* Risiedi in Svizzera, o sei in possesso di un regolare permesso di lavoro?',
    ];
    const form = [
      'Opzioni',
      'Esplodi tutte le sezioni',
      'Comprimi tutte le sezioni',
      'I miei documenti',
      'Informazioni profilo',
      'Informazioni specifiche del lavoro',
      'Visualizza profilo',
      'Salva',
      'Candidati',
      ...fields,
    ].join('\n');

    expect(formPostingMatch(form, {
      title: 'Macellaia / Macellaio - Salumiera / Salumiere (f/m/d)',
      company: 'Coop Genossenschaft',
    }, {
      postingMatched: true,
      postingEntry: true,
      pageUrl,
      postingUrl,
      postingRouteProof: proof,
      applyUrl,
      formFieldLabels: fields,
    })).toBe('match');
    expect(formPostingMatch(form.replace('Opzioni', 'Siemens AG'), {
      title: 'Macellaia / Macellaio - Salumiera / Salumiere (f/m/d)',
      company: 'Coop Genossenschaft',
    }, {
      postingMatched: true,
      postingEntry: true,
      pageUrl,
      postingUrl,
      postingRouteProof: proof,
      applyUrl,
      formFieldLabels: fields,
    })).toBe('mismatch');
  });

  it('accepts the Kanton St. Gallen Application/New form with its full ATS title and Weiter control', () => {
    const postingUrl = 'https://recruitingapp-2800.umantis.com/Vacancies/6604/Description/1';
    const applicationUrl = 'https://recruitingapp-2800.umantis.com/Vacancies/6604/Application/New/1';
    const form = [
      'Sachbearbeiter:in Schuladministration (m/w/d) / mit ergänzenden Aufgaben im administrativen HR - Bewerbung | eRecruiting Kanton St.Gallen',
      'Weiter',
      'Foto',
      'Vorname',
      'Nachname',
      'E-Mail-Adresse/Login',
      'Passwort',
      'PLZ',
      'Ort',
      'Land',
      'Bewerbungsschreiben',
      'Lebenslauf',
      'Zeugnisse, Diplome und weitere Dokumente',
      'form_data25',
      'Wie sind Sie auf uns aufmerksam geworden?',
      'Ich bin mit der Datenschutzerklärung einverstanden',
      'Frau',
      applicationUrl,
    ].join('\n');
    const options = { pageUrl: applicationUrl, postingUrl, postingMatched: true, postingEntry: true };
    expect(formPostingMatch(form, {
      title: 'Assistente amministrativa',
      company: 'Kanton St. Gallen',
    }, options)).toBe('match');
    expect(formPostingMatch(form.replace('Sachbearbeiter:in Schuladministration', 'Other Hotel'), {
      title: 'Assistente amministrativa',
      company: 'Kanton St. Gallen',
    }, options)).toBe('mismatch');
  });

  it('keeps an unpaired Umantis application route behind the heading employer guard', () => {
    const applicationUrl = 'https://recruitingapp-2800.umantis.com/Vacancies/6604/Application/New/1';
    expect(formPostingMatch('Other Hotel - Bewerbung\nVorname\nNachname', {
      title: 'Front Desk Agent',
      company: 'Grand Hotel',
    }, {
      pageUrl: applicationUrl,
      postingUrl: 'https://careers.example.test/jobs/unrelated',
      postingMatched: true,
      postingEntry: true,
    })).toBe('mismatch');
  });

  it('does not discard a Recruiting-prefixed employer as Umantis chrome', () => {
    const postingUrl = 'https://recruitingapp-2800.umantis.com/Vacancies/6604/Description/1';
    const applicationUrl = 'https://recruitingapp-2800.umantis.com/Vacancies/6604/Application/New/1';
    expect(formPostingMatch('Application | Recruiting Solutions\nVorname\nNachname', {
      title: 'Front Desk Agent',
      company: 'Grand Hotel',
    }, {
      pageUrl: applicationUrl,
      postingUrl,
      postingMatched: true,
      postingEntry: true,
    })).toBe('mismatch');
  });

  it('keeps a generic form reached from the selected posting unknown and continues', () => {
    const genericForm = 'Bewerbung\nVorname\nNachname\nE-Mail-Adresse\nWeiter';
    const job = { title: 'Pflegefachperson', company: 'Spital Esempio' };
    expect(formPostingMatch(genericForm, job, { postingMatched: true, applicationEntry: true })).toBe('unknown');
    const numberedForm = 'Numero candidatura\nData di compilazione\nNome\nCognome';
    expect(namesAnotherEmployer(numberedForm, job)).toBe(false);
    expect(formPostingMatch(numberedForm, job, {
      postingMatched: true, applicationEntry: true,
    })).toBe('unknown');
    expect(formPostingMatch(genericForm, job)).toBe('mismatch');
  });

  it('does not treat a missing entry URL as route-bound provenance', () => {
    expect(formPostingMatch('Application Payroll Specialist', {
      company: 'Example Employer',
      title: 'Payroll Specialist',
    }, {
      postingMatched: true,
      applicationEntry: true,
      applicationEntryUrl: '',
      pageUrl: 'https://other.example/spontaneous/',
      postingUrl: 'https://paid.example/job/123/',
    })).toBe('unknown');
  });

  it('does not bind an ATS form from an employer URL elsewhere in the snapshot', () => {
    const job = { title: 'Senior Engineer', company: 'Acme AG' };
    const formText = 'Application form\nFirst name\nE-mail\nhttps://acme.example/careers';
    expect(formPostingMatch(formText, job, {
      postingMatched: true,
      applicationEntry: true,
      pageUrl: 'https://third-party-ats.example/apply',
      postingUrl: 'https://paid-board.example/job/123',
    })).toBe('unknown');
  });

  it('does not treat an unrelated Umantis link as the current form route', () => {
    const job = { title: 'Senior Engineer', company: 'Acme AG' };
    const formText = 'Application form\nFirst name\nhttps://otherco.umantis.com/Vacancies/987/Application/New/1';
    expect(formPostingMatch(formText, job, {
      postingMatched: true,
      postingEntry: true,
      pageUrl: 'https://third-party-ats.example/apply',
      postingUrl: 'https://paid-board.example/job/123',
    })).toBe('unknown');
  });

  it('does not accept the employer name in a third-party subdomain as its host', () => {
    const job = { title: 'Senior Engineer', company: 'Acme AG' };
    expect(formPostingMatch('Application form\nE-mail', job, {
      postingMatched: true,
      applicationEntry: true,
      pageUrl: 'https://acme.attacker.example/apply',
      postingUrl: 'https://paid-board.example/job/123',
    })).toBe('unknown');
  });

  it('recognizes the employer registrable domain below a multi-label public suffix', () => {
    const job = { title: 'Senior Engineer', company: 'Acme Limited' };
    expect(formPostingMatch('Application form\nE-mail', job, {
      postingMatched: true,
      applicationEntry: true,
      applicationEntryUrl: 'https://forms.acme.co.uk/apply',
      pageUrl: 'https://forms.acme.co.uk/apply',
      postingUrl: 'https://paid-board.example/job/123',
    })).toBe('match');
  });

  it('does not carry an application entry binding to a later generic form on the employer site', () => {
    const job = { title: 'Senior Engineer', company: 'Acme AG' };
    expect(formPostingMatch('Application form\nE-mail', job, {
      postingMatched: true,
      postingEntry: true,
      applicationEntry: true,
      applicationEntryUrl: 'https://jobs.acme.example/paid-application',
      pageUrl: 'https://jobs.acme.example/spontaneous-application',
      postingUrl: 'https://paid-board.example/job/123',
    })).toBe('unknown');
  });

  it('keeps same-kind employer names as conflicting evidence and a lone form word as none', () => {
    expect(namesAnotherEmployer('Banca Cler — Bank Riviera', { company: 'Banca Cler' })).toBe(true);
    // A lone word of a form is no organisation: only a positive entity (legal form, «bei <Name>», …) is a conflict.
    expect(namesAnotherEmployer('Data', { company: 'Alfa' })).toBe(false);
    expect(namesAnotherEmployer('Compilation', { company: 'Alfa' })).toBe(false);
    expect(namesAnotherEmployer('Compilazione', { company: 'Alfa' })).toBe(false);
    expect(namesAnotherEmployer('Compilazione Beta SA', { company: 'Alfa' })).toBe(true);
    expect(namesAnotherEmployer('Data di compilazione:', { company: 'Alfa' })).toBe(false);
    expect(namesAnotherEmployer('Date de candidature', { company: 'Alfa' })).toBe(false);
  });

  it('rejects a different named role and a different Umantis vacancy ID', () => {
    const postingUrl = 'https://recruitingapp-2800.umantis.com/Vacancies/6604/Description/1';
    const applicationUrl = 'https://recruitingapp-2800.umantis.com/Vacancies/6604/Application/New/1';
    const job = { title: 'Pflegefachfrau Gesundheit', sourceTitle: 'Pflegefachfrau Gesundheit' };
    expect(formPostingMatch('Sachbearbeiter Buchhaltung - Bewerbung', job, {
      pageUrl: 'https://careers.example.test/application/new', postingMatched: true,
    })).toBe('mismatch');
    expect(formPostingMatch('Sachbearbeiter Buchhaltung - Bewerbung\nVorname\nNachname', job, {
      pageUrl: applicationUrl, postingUrl,
    })).toBe('mismatch');
    expect(formPostingMatch(`Sachbearbeiter Buchhaltung - Bewerbung\nVorname\nNachname\n${applicationUrl}`, job, {
      postingMatched: true, postingEntry: true, postingUrl,
    })).toBe('mismatch');
    expect(formPostingMatch('Bewerbung\nVorname\nNachname', job, {
      pageUrl: 'https://recruitingapp-2800.umantis.com/Vacancies/6605/Application/New/1', postingUrl,
    })).toBe('mismatch');
  });
});

describe('Job-Room external advertisement link', () => {
  const currentUrl = 'https://www.lavoro.swiss/job-search/11111111-2222-3333-4444-555555555555';
  const externalUrl = 'https://team.jobs/de/jobs/123';

  it.each([
    ["Andare all'annuncio esterno", 'links'],
    ['Zum externen Inserat', 'links'],
    ["Vers l'annonce externe", 'buttons'],
    ['Go to external ad', 'buttons'],
    ['Go to the external job posting', 'links'],
    ['Zum externen Stellenangebot', 'buttons'],
    ["Aller à l’offre externe", 'links'],
    ["Accéder à l’annonce externe", 'buttons'],
  ])('recognizes the public external ad action in %s', (label, collection) => {
    const snapshot = { [collection]: [{ text: label, href: externalUrl }] };
    expect(jobRoomExternalAdTarget(snapshot, currentUrl)).toBe(externalUrl);
  });

  it('does not guess when the external action is missing or ambiguous', () => {
    expect(jobRoomExternalAdTarget({ links: [] }, currentUrl)).toBe('');
    expect(jobRoomExternalAdTarget({ links: [
      { text: 'Go to the external job posting', href: 'https://job-room.ch/job-search' },
    ] }, 'https://job-room.ch/job-search/123/')).toBe('');
    expect(jobRoomExternalAdTarget({ links: [
      { text: 'Go to external ad', href: externalUrl },
      { text: 'Andare all’annuncio esterno', href: 'https://agency.jobs/posting/123' },
    ] }, currentUrl)).toBe('');
  });
});

describe('team.jobs application entry', () => {
  const postingUrl = 'https://team.jobs/fr/offres-demplois/allrounder/macellaio-%28m-f-d%29/GXe0mf596t8Lf4knvKjEkY';
  const applicationEntry = {
    text: 'Postuler maintenant',
    href: 'https://team.jobs/fr/jobs/apply/GXe0mf596t8Lf4knvKjEkY',
  };
  const context = {
    applyUrl: postingUrl,
    postingUrl,
    allowSingleExternalApplicationEntry: true,
    job: { title: 'Macellaio (M/F/D)', sourceTitle: 'Macellaio (M/F/D)' },
  };

  it('binds the opaque team.jobs apply route to the fieldless posting', () => {
    const snapshot = {
      url: postingUrl,
      fields: [],
      buttons: [
        'Suchen', 'Deutsch', 'Für Bewerbende', 'Für Unternehmen',
        'Über uns', 'Karriere bei dasteam', 'Cookie-Einstellungen',
      ].map(text => ({ text, chrome: true })),
      links: [applicationEntry],
    };

    expect(applicationEntryControls(snapshot, context)).toEqual([applicationEntry]);
  });

  it.each([
    ['a different opaque id', applicationEntry.href.replace('GXe0mf596t8Lf4knvKjEkY', 'OtherPostingId')],
    ['a different route namespace', applicationEntry.href.replace('/jobs/apply/', '/jobs/preview/')],
    ['a different host', applicationEntry.href.replace('team.jobs', 'other.example')],
  ])('does not bind %s as the selected posting', (_description, href) => {
    const snapshot = { url: postingUrl, fields: [], buttons: [], links: [{ ...applicationEntry, href }] };
    expect(applicationEntryControls(snapshot, context)).toEqual([]);
  });
});

describe('PinpointHQ New Application title and route binding', () => {
  it('binds the PinpointHQ form when action and cookie controls precede its fields', () => {
    const postingUrl = 'https://kempinski.pinpointhq.com/en/postings/9d8a7c6b-5e4f-4321-9abc-0123456789de';
    const applicationUrl = `${postingUrl}/applications/new`;
    const job = { company: 'Kempinski', title: 'Front Office Agent' };
    const form = [
      'Remove',
      'Save application for later',
      'SUBMIT APPLICATION',
      'COOKIES',
      'First Name',
      'Middle Name',
      'Last Name',
      'Email Address',
      'Phone',
      'application_form[application][country]',
      'Address Line 1',
      'Address Line 2',
      'Town',
      'Postcode',
      'Attach Résumé / CV',
      'Personal Summary Use it to tell us a little more about yourself.',
      'What is your level of German?',
      '(Required) Allow us to process my personal information.',
      '[candidate data]',
    ].join('\n');

    expect(formPostingMatch(form, job, {
      postingMatched: true,
      applicationEntry: true,
      applicationEntryUrl: applicationUrl,
      pageUrl: applicationUrl,
      postingUrl,
      paidPostingUrl: postingUrl,
      applyUrl: postingUrl,
    })).toBe('match');
  });

  it('matches a PinpointHQ application form titled "New Application | <Source Role> | <Company> Careers"', () => {
    const postingUrl = 'https://example-hotel.pinpointhq.com/en/postings/c570608c-e27d-47f1-8e91-1e9b6d16a27e';
    const applicationUrl = `${postingUrl}/applications/new`;
    const job = {
      company: 'Grand Hotel Example St. Moritz',
      title: 'Commissione di Rang (m/f/d) Sala da pranzo',
      sourceTitle: 'Commis de Rang (f/m/d) In Room Dining',
    };
    const form = 'New Application | Commis de Rang (f/m/d) In Room Dining | Grand Hotel Example St. Moritz Careers\nApply\nFirst Name\nLast Name';

    expect(formPostingMatch(form, job, {
      postingMatched: true,
      applicationEntry: true,
      applicationEntryUrl: applicationUrl,
      pageUrl: applicationUrl,
      postingUrl,
      paidPostingUrl: postingUrl,
      pageHeading: 'Apply',
      pageHeadings: ['Apply'],
      applyUrl: postingUrl,
    })).toBe('match');
  });

  it('still rejects a conflicting employer even with a "New Application" prefix', () => {
    const postingUrl = 'https://example-hotel.pinpointhq.com/en/postings/c570608c-e27d-47f1-8e91-1e9b6d16a27e';
    const applicationUrl = `${postingUrl}/applications/new`;
    const job = {
      company: 'Grand Hotel Example St. Moritz',
      title: 'Commis de Rang (f/m/d)',
      sourceTitle: 'Commis de Rang (f/m/d)',
    };
    const form = 'New Application | Commis de Rang (f/m/d) | Other Palace Resort Careers\nApply';

    expect(formPostingMatch(form, job, {
      postingMatched: true,
      applicationEntry: true,
      applicationEntryUrl: applicationUrl,
      pageUrl: applicationUrl,
      postingUrl,
      paidPostingUrl: postingUrl,
      pageHeading: 'Apply',
      pageHeadings: ['Apply'],
      applyUrl: postingUrl,
    })).toBe('mismatch');
  });

  it('does not treat "<Company> employee" inside a screening question as another employer', () => {
    const postingUrl = 'https://example-hotel.pinpointhq.com/en/postings/c570608c-e27d-47f1-8e91-1e9b6d16a27e';
    const applicationUrl = `${postingUrl}/applications/new`;
    const job = {
      company: 'Grand Hotel Example St. Moritz',
      title: 'Commis de Rang (f/m/d) In Room Dining',
    };
    const form = [
      'New Application | Commis de Rang (f/m/d) In Room Dining | Grand Hotel Example St. Moritz Careers',
      'Apply',
      'Are you currently a Example employee?',
      'If you are a Example employee, have you discussed your interest with HR?',
    ].join('\n');

    expect(formPostingMatch(form, job, {
      postingMatched: true,
      applicationEntry: true,
      applicationEntryUrl: applicationUrl,
      pageUrl: applicationUrl,
      postingUrl,
      paidPostingUrl: postingUrl,
      pageHeading: 'Apply',
      pageHeadings: ['Apply'],
      applyUrl: postingUrl,
    })).toBe('match');
  });

  it('keeps Avature global member-firm disclaimers, question-mark prose breaks, and "Applying to" titles valid', () => {
    const postingUrl = 'https://apply.example.ch/CHCareers/JobDetail/Manager-IT-Infrastructure/24124';
    const applicationUrl = 'https://apply.example.ch/CHCareers/ApplicationMethods?tempJobid=24124';
    const job = {
      company: 'Deloitte',
      title: 'Manager - IT Infrastructure Technology Strategy & Transformation',
    };
    const footer = [
      'Want to know more about opportunities at Deloitte? Visit\u202fwww.apply.example.ch',
      'Deloitte refers to one or more of Deloitte Touche Tohmatsu Limited (“DTTL”), a UK private company limited by guarantee, and its network of member firms, each of which is a legally separate and independent entity.',
      'Deloitte AG is a subsidiary of Deloitte LLP, the United Kingdom member firm of DTTL.',
    ].join('\n');

    expect(namesAnotherEmployer(`Applying to ${job.title}\n${footer}`, job)).toBe(false);
    expect(formPostingMatch(`Applying to ${job.title}\nDeloitte\n${footer}`, job, {
      postingMatched: true,
      postingEntry: true,
      applicationEntry: true,
      applicationEntryUrl: applicationUrl,
      pageUrl: applicationUrl,
      postingUrl,
      paidPostingUrl: postingUrl,
      pageHeading: 'Deloitte',
      pageHeadings: ['Deloitte'],
      applyUrl: postingUrl,
    })).toBe('match');

    // Counterexamples must still reject conflicting second employers.
    expect(namesAnotherEmployer(`Applying to ${job.title} | Other Consulting AG\n${footer}`, job)).toBe(true);
    expect(namesAnotherEmployer('Deloitte Partners Other AG', job)).toBe(true);
    expect(namesAnotherEmployer('Acme refers to one or more of Acme Other Employer', { company: 'Acme' })).toBe(true);
    expect(namesAnotherEmployer('Acme refers to one or more of Acme other employer', { company: 'Acme' })).toBe(true);
    expect(namesAnotherEmployer('Acme refers to one or more of Acme AG', { company: 'Acme' })).toBe(false);
    expect(formPostingMatch(`Applying to ${job.title}\nOther Consulting AG`, job, {
      postingMatched: true,
      postingEntry: true,
      pageUrl: applicationUrl,
      postingUrl,
      applyUrl: postingUrl,
    })).toBe('mismatch');
  });

  it('matches concatenated DOM spans, career-page CTAs, and Job-Room chrome while rejecting real conflicts', () => {
    const migrosJob = {
      company: 'Genossenschaft Migros Zürich',
      title: 'Addetto a alla vendita di fiori e al servizio clienti',
      sourceTitle: 'Verkäufer*in Blumen und Kundendienst 80 – 100%',
    };
    expect(formPostingMatch(
      'Genossenschaft Migros Zürich16. November 2026\nVerkäufer*in Blumen und Kundendienst80 – 100%\nBewerbung',
      migrosJob,
      { pageUrl: 'https://jobs.migros.ch/de/jobs/123456' },
    )).toBe('match');

    const delapaixJob = { company: 'Hotel de la Paix', title: 'Chef de Partie', location: 'Lugano' };
    expect(formPostingMatch(
      'Lavora con noi - Hotel de la Paix\nHotel de la Paix Lugano\nCandidatura spontanea\nNome\nCognome',
      delapaixJob,
      {
        pageUrl: 'https://delapaix.ch/it/lavora-con-noi/',
        postingUrl: 'https://www.job-room.ch/job-search/a5ed5d82-1111-2222-3333-444455556666',
        applyUrl: 'https://delapaix.ch/it/lavora-con-noi/',
      },
    )).toBe('match');

    expect(formPostingMatch(
      'Header Contact Registration info Login work .swiss\nChef de Partie\nHotel de la Paix\nVia Silvio Calloni 18\n6900 Lugano\nApply',
      delapaixJob,
      {
        pageUrl: 'https://www.job-room.ch/job-search/a5ed5d82-1111-2222-3333-444455556666',
        postingUrl: 'https://www.job-room.ch/job-search/a5ed5d82-1111-2222-3333-444455556666',
      },
    )).toBe('match');

    // A different brand remains a mismatch even on an employer-style title.
    expect(formPostingMatch('Lavora con noi - Grand Hotel Eden\nNome\nCognome', delapaixJob, {
      pageUrl: 'https://delapaix.ch/it/lavora-con-noi/',
    })).toBe('mismatch');
  });
});
