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

  it('keeps same-kind employer names and standalone Data as conflicting evidence', () => {
    expect(namesAnotherEmployer('Banca Cler — Bank Riviera', { company: 'Banca Cler' })).toBe(true);
    expect(namesAnotherEmployer('Data', { company: 'Alfa' })).toBe(true);
    expect(namesAnotherEmployer('Compilation', { company: 'Alfa' })).toBe(true);
    expect(namesAnotherEmployer('Compilazione', { company: 'Alfa' })).toBe(true);
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
