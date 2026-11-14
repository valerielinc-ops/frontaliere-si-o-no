import { describe, expect, it } from 'vitest';
import {
  applicationEntryMatchesSelectedPosting,
  applicationEntryControlMatchesSelectedPosting,
  applicationEntryUrlAfterTransition,
  applicationEntryCarriesPostingId,
  applicationEntryControls,
  formPostingMatch,
  hasVacancySpecificPostingEvidence,
  isPostingDocumentUrl,
  isRoleHeading,
  namesAnotherEmployer,
  postingDocumentHostBound,
  postingDocumentIdentity,
  postingMatch,
  startsApplication,
} from '../scripts/assisted-application/lib/portal/portal.mjs';

// Two paid orders stopped on 2026-11-11 with «il modulo aperto dal link non nomina né l'azienda né il ruolo».
// The public pages are rebuilt from what the browser rendered that day, reduced to what the guard reads; the
// contact persons the postings name are left out.

describe('Bank Cler posting (8BhQom09): the role heading and the employer in its own languages', () => {
  const title = 'Consulente alla clientela privata di base Lugano (f/m) 50%';
  const job = { company: 'Bank Cler', title };
  const postingUrl = 'https://www.cler.ch/de/bank-cler/jobs-und-karriere/suchen-und-bewerben/offene-stellen/consulente-alla-clientela-privata-di-base-lugano-f-m-2779';
  const applyHref = 'https://recruitingapp-2839.umantis.com/Vacancies/2779/Application/CheckLogin/1?lang=ger&DesignID=10008';
  const pageTitle = `${title} - Bank Cler`;
  const rendered = [
    'Accesskeys', 'Navigation', 'Inhalt', 'Kontakt', 'Suche', 'Hilfe & Kontakt', 'Login',
    'Anlegen', 'Hypotheken & Kredite', 'Zahlen & Sparen', 'Bank Cler',
    title,
    'Non c’è che dire, siamo davvero in gamba. La Banca Cler, giovane affiliata della Basler Kantonalbank, ha lanciato sul mercato «Zak», la prima banca svizzera sullo smartphone.',
    'Il tuo nuovo lavoro',
    'Accogliere la clientela',
    'Cosa ti chiediamo',
    'Formazione bancaria completa (AFC o formazione equivalente)',
    'Jetzt bewerben',
    'Zurück',
    'Bank Cler',
    'Die Bank Cler ist eine Tochtergesellschaft der Basler Kantonalbank.',
    '© Bank Cler AG',
  ].join('\n');

  it('reads the posting as the order\'s: its heading is the role with the workload the title carries', () => {
    expect(isRoleHeading(title, title)).toBe(true);
    // Tolerance on the workload only: another percentage, gender markers.
    expect(isRoleHeading('Consulente alla clientela privata di base Lugano (f/m) 80-100%', title)).toBe(true);
    expect(isRoleHeading('Consulente alla clientela privata di base Lugano', title)).toBe(true);
    // Never part of the role, never another one.
    expect(isRoleHeading('Consulente alla clientela privata', title)).toBe(false);
    expect(isRoleHeading('Consulente alla clientela aziendale di base Lugano (f/m) 50%', title)).toBe(false);
    expect(hasVacancySpecificPostingEvidence(rendered, job, { pageUrl: postingUrl, pageTitle, pageHeading: title, postingUrl })).toBe(true);
  });

  it('reads «la Banca Cler» and a sentence about «die Bank Cler» as the order\'s employer', () => {
    expect(namesAnotherEmployer(`${title}\n${rendered}`, job, { allowPostingLocation: true })).toBe(false);
    expect(namesAnotherEmployer('\nLa Banca Cler, giovane affiliata', job)).toBe(false);
    expect(namesAnotherEmployer('\nDie Bank Cler ist eine Tochtergesellschaft der Basler Kantonalbank.', job)).toBe(false);
    expect(namesAnotherEmployer('\nKlicke auf Login, wenn du dein Profil für die Basler Kantonalbank oder die Bank Cler AG hinterlegt hast.', job)).toBe(false);
  });

  it('still reads another employer next to the name', () => {
    // A capitalised name around the whole name, or any word next to a part of it.
    expect(namesAnotherEmployer('\nMuster Bank Cler', job)).toBe(true);
    expect(namesAnotherEmployer('\nBank Cler Immobilien', job)).toBe(true);
    expect(namesAnotherEmployer('\nMuster Bank', job)).toBe(true);
    // Another kind of employer is another name: a hotel is not a bank.
    expect(namesAnotherEmployer('\nHotel Cler', job)).toBe(true);
    // The same rules on a whole posting: another role heading or another employer stops.
    const other = rendered.replace(title, 'Kundenberater Firmenkunden Basel (m/w) 100%');
    expect(hasVacancySpecificPostingEvidence(other, job, {
      pageUrl: postingUrl, pageTitle, pageHeading: 'Kundenberater Firmenkunden Basel (m/w) 100%', postingUrl,
    })).toBe(false);
    expect(hasVacancySpecificPostingEvidence(`${rendered}\nPartner: Muster Bank Cler`, job, {
      pageUrl: postingUrl, pageTitle, pageHeading: title, postingUrl,
    })).toBe(false);
  });

  it('follows the Apply link that carries the posting\'s own id, and only that one', () => {
    const snapshot = (links: Array<{ text: string; href: string }>, url = postingUrl) => ({
      url, fields: [], buttons: [], links: links.map((link) => ({ ...link, frame: 0 })),
    });
    const context = { applyUrl: postingUrl, postingUrl, job, pageTitle, allowSingleExternalApplicationEntry: true };
    expect(applicationEntryCarriesPostingId(applyHref, postingUrl)).toBe(true);
    expect(applicationEntryCarriesPostingId(applyHref.replace('/2779/', '/2780/'), postingUrl)).toBe(false);
    // The ATS host's own number is not the posting's id.
    expect(applicationEntryCarriesPostingId('https://recruitingapp-2779.umantis.com/Vacancies/1/Application/New/1', postingUrl)).toBe(false);
    expect(applicationEntryControls(snapshot([{ text: 'Jetzt bewerben', href: applyHref }]), context))
      .toEqual([expect.objectContaining({ href: applyHref })]);
    // The same link above and below the text is one entry.
    expect(applicationEntryControls(snapshot([{ text: 'Jetzt bewerben', href: applyHref }, { text: 'Jetzt bewerben', href: applyHref }]), context))
      .toHaveLength(1);
    // Another vacancy's id, or a second entry to another vacancy: no entry.
    expect(applicationEntryControls(snapshot([{ text: 'Jetzt bewerben', href: applyHref.replace('/2779/', '/2780/') }]), context)).toEqual([]);
    expect(applicationEntryControls(snapshot([
      { text: 'Jetzt bewerben', href: applyHref },
      { text: 'Jetzt bewerben', href: applyHref.replace('/2779/', '/2780/') },
    ]), context)).toEqual([]);
    // Not on the posting page, or the posting not verified: no entry.
    expect(applicationEntryControls(snapshot([{ text: 'Jetzt bewerben', href: applyHref }], postingUrl.replace(/-2779$/, '-2780')), context)).toEqual([]);
    expect(applicationEntryControls(snapshot([{ text: 'Jetzt bewerben', href: applyHref }]), { ...context, allowSingleExternalApplicationEntry: false })).toEqual([]);
  });

  it('a list of postings is no posting: each Apply opens another vacancy', () => {
    const listUrl = 'https://www.cler.ch/de/bank-cler/jobs-und-karriere/suchen-und-bewerben/offene-stellen';
    const list = {
      url: listUrl, fields: [], buttons: [],
      links: ['2779', '2780', '2781'].map((id) => ({ text: 'Jetzt bewerben', href: applyHref.replace('/2779/', `/${id}/`), frame: 0 })),
    };
    const listText = ['Offene Stellen', title, 'Kundenberater Firmenkunden Basel (m/w) 100%', 'Bank Cler'].join('\n');
    expect(hasVacancySpecificPostingEvidence(listText, job, { pageUrl: listUrl, pageTitle: 'Offene Stellen - Bank Cler', pageHeading: 'Offene Stellen', postingUrl })).toBe(false);
    expect(applicationEntryControls(list, { applyUrl: postingUrl, postingUrl, job, allowSingleExternalApplicationEntry: true })).toEqual([]);
  });

  it('accepts the Umantis form the link opens, and stops on another vacancy\'s form', () => {
    const formUrl = 'https://recruitingapp-2839.umantis.com/Vacancies/2779/Application/New/1';
    const form = [
      'Consulente alla clientela privata di base Lugano (f/m) - Bewerbung | Recruiting',
      'Zum Hauptinhalt springen',
      'Consulente alla clientela privata di base Lugano (f/m) - Bewerbung',
      'Login',
      'Klicke auf Login, wenn du dein Profil bereits früher für die Basler Kantonalbank oder die Bank Cler AG online hinterlegt hast.',
      'Anrede*:', 'Vorname*:', 'Nachname*:', 'E-Mail-Adresse/Login*:',
      formUrl,
    ].join('\n');
    const options = { postingMatched: true, applicationEntry: true, pageUrl: formUrl, postingUrl };
    expect(formPostingMatch(form, job, options)).toBe('match');
    const otherUrl = formUrl.replace('/2779/', '/2780/');
    const other = form.replaceAll('Consulente alla clientela privata di base Lugano (f/m)', 'Kundenberater Firmenkunden Basel (m/w)').replace(formUrl, otherUrl);
    expect(formPostingMatch(other, job, { ...options, pageUrl: otherUrl })).toBe('mismatch');
  });
});

describe('autonomous application-entry posting binding', () => {
  const job = { company: 'Muster AG', title: 'Application Manager' };
  const listingUrl = 'https://careers.example.ch/jobs';
  const postingUrl = 'https://careers.example.ch/jobs/application-manager-42';

  it('rejects company-only careers pages but accepts the selected role and employer together', () => {
    expect(applicationEntryMatchesSelectedPosting({
      pageText: 'Muster AG Karriere', pageTitle: 'Muster AG Karriere',
      pageUrl: listingUrl, postingUrl, job,
    })).toBe(false);
    expect(applicationEntryMatchesSelectedPosting({
      pageText: 'Application Manager — Muster AG', pageTitle: 'Application Manager | Muster AG',
      pageUrl: listingUrl, postingUrl, job,
    })).toBe(true);
  });

  it('requires the Apply control clicked by the agent to match a selected posting-owned entry', () => {
    const snapshot = {
      url: postingUrl,
      buttons: [
        { text: 'Apply', href: 'https://careers.example.ch/jobs/application-manager-42/apply' },
        { text: 'Apply', href: 'https://careers.example.ch/jobs/other-role/apply' },
      ],
      links: [],
    };
    const selected = [{ text: 'Apply', href: 'https://careers.example.ch/jobs/application-manager-42/apply' }];
    const context = { postingUrl, job };
    expect(applicationEntryControlMatchesSelectedPosting({
      name: 'Apply', href: 'https://careers.example.ch/jobs/application-manager-42/apply',
    }, selected, snapshot, context)).toBe(true);
    expect(applicationEntryControlMatchesSelectedPosting({
      name: 'Apply', href: 'https://careers.example.ch/jobs/other-role/apply',
    }, selected, snapshot, context)).toBe(false);
    expect(applicationEntryControlMatchesSelectedPosting({ name: 'Apply' }, selected, snapshot, context)).toBe(false);
  });

  it('rejects an external Apply card whose requisition id conflicts with the paid posting', () => {
    const jobWithReq = { ...job, requirementId: 'REQ-42' };
    const snapshot = {
      url: 'https://board.example.ch/job/REQ-42',
      buttons: [],
      links: [{
        text: 'Apply',
        href: 'https://ats.example/apply',
        vacancyContext: 'Application Manager · Muster AG · Requisition ID: REQ-99',
      }],
    };
    expect(applicationEntryControls(snapshot, {
      applyUrl: 'https://ats.example/apply',
      postingUrl: snapshot.url,
      job: jobWithReq,
    })).toEqual([]);
  });

  it('carries entry proof to a next page only from the current bound route and without diversion evidence', () => {
    const entry = 'https://forms.example.ch/apply/req-42';
    expect(applicationEntryUrlAfterTransition({
      applicationEntryUrl: entry, sourceUrl: entry, targetUrl: `${entry}/step-2`,
    })).toBe(`${entry}/step-2`);
    const login = 'https://forms.example.ch/sign-in';
    expect(applicationEntryUrlAfterTransition({
      applicationEntryUrl: login, sourceUrl: login, targetUrl: `${entry}/step-2`,
    })).toBe(`${entry}/step-2`);
    expect(applicationEntryUrlAfterTransition({
      applicationEntryUrl: entry, sourceUrl: entry, targetUrl: 'https://forms.example.ch/spontaneous-application',
      diversionHint: 'talent_pool_or_job_alert',
    })).toBe(entry);
    expect(applicationEntryUrlAfterTransition({
      applicationEntryUrl: entry, sourceUrl: 'https://forms.example.ch/sign-in', targetUrl: `${entry}/step-2`,
    })).toBe(entry);
  });
});

describe('ECAM general notice (CVRDEqJ3): a posting published as a PDF', () => {
  const title = 'Concorso generale permanente 2026';
  const job = { company: 'Ente Case Anziani Mendrisiotto (ECAM)', title };
  const postingUrl = 'https://www.ecam.swiss/wp-content/uploads/2026/01/Concorso-generale-sito-ECAM-2026.pdf';
  const career = 'https://www.ecam.swiss/lavora-con-noi/opportunita-dimpiego/';
  const formHref = 'https://dms.ecam.swiss/DocuWare/Forms/candidatura-online?orgID=24750358-8e9c-4e5c-be1d-3d781846c471';
  const notice = [
    'CONCORSO GENERALE PERMANENTE ANNO 2026',
    'L’Ente Case Anziani Mendrisiotto rende noto che è aperto il concorso generale per l\'assunzione del',
    'seguente personale:',
    '• personale di cura e terapeutico',
    'Le offerte devono essere corredate dai seguenti documenti:',
    '• lettera di presentazione',
    '• curriculum vitae',
    'Modalità di candidatura:',
    'le candidature dovranno essere inoltrate unicamente tramite l’apposito modulo online accessibile',
    'sul sito internet www.ecam.swiss.',
    'Mendrisio, gennaio 2026',
    'Ente Case Anziani Mendrisiotto',
  ].join('\n');
  const host = (links: Array<{ text: string; href: string }>, url = career) => ({
    url, fields: [], buttons: [], links: links.map((link) => ({ ...link, frame: 0 })),
  });
  const hostLinks = [
    { text: 'Lavora con noi', href: 'https://www.ecam.swiss/lavora-con-noi/' },
    { text: 'Inviate la vostra candidatura', href: formHref },
    { text: 'cliccando qui', href: postingUrl },
    { text: 'info@ecam.swiss', href: 'mailto:info@ecam.swiss' },
  ];

  it('reads the notice as the order\'s posting', () => {
    expect(isPostingDocumentUrl(postingUrl)).toBe(true);
    expect(isPostingDocumentUrl(career)).toBe(false);
    // The employer written out, without the short form the order adds in brackets.
    expect(postingMatch(notice, job)).toBe('match');
    // The short form alone is initials: still no match.
    expect(postingMatch('Lavora con ECAM', job)).toBe('mismatch');
    expect(postingDocumentIdentity(notice, job)).toBe(true);
    // Last year's notice at the same address, another employer's or another role's is not the order's.
    expect(postingDocumentIdentity(notice.replaceAll('2026', '2025'), job)).toBe(false);
    expect(postingDocumentIdentity(notice.replaceAll('Ente Case Anziani Mendrisiotto', 'Fondazione Altra Casa'), job)).toBe(false);
    expect(postingDocumentIdentity(notice.replace('CONCORSO GENERALE PERMANENTE ANNO 2026', 'CONCORSO INFERMIERE CAPOREPARTO 2026'), job)).toBe(false);
    expect(postingDocumentIdentity('', job)).toBe(false);
  });

  it('binds the career page that links the notice, and its one application control', () => {
    expect(startsApplication('Inviate la vostra candidatura')).toBe(true);
    const bound = postingDocumentHostBound(host(hostLinks), { pageUrl: career, postingUrl, applyUrl: career });
    expect(bound).toBe(true);
    const context = {
      applyUrl: career, postingUrl, job, allowSingleExternalApplicationEntry: true,
      postingDocumentHost: true, postingDocumentHostUrl: career,
    };
    expect(applicationEntryControls(host(hostLinks), context)).toEqual([expect.objectContaining({ href: formHref })]);
    // Without the document's proof, the same page gives no entry.
    expect(applicationEntryControls(host(hostLinks), { ...context, postingDocumentHost: false })).toEqual([]);
    // Two application controls: no choice by position.
    expect(applicationEntryControls(host([...hostLinks, { text: 'Candidati', href: 'https://dms.ecam.swiss/DocuWare/Forms/spontanea' }]), context)).toEqual([]);
    // Another page than the host: no entry.
    expect(applicationEntryControls(host(hostLinks, 'https://www.ecam.swiss/lavora-con-noi/apprendistato/'), context)).toEqual([]);
  });

  it('stops on a page that lists several notices, or that does not link this one', () => {
    const list = [...hostLinks, { text: 'Concorso infermiere capo reparto', href: 'https://www.ecam.swiss/wp-content/uploads/2026/03/Concorso-infermiere-2026.pdf' }];
    expect(postingDocumentHostBound(host(list), { pageUrl: career, postingUrl, applyUrl: career })).toBe(false);
    // Review of #18092: a second PDF is never told apart by its name or link text. An opaque «Apri» on
    // other.pdf can be another notice, and so can a PDF labelled as a privacy note.
    const target = 'https://www.ecam.swiss/wp-content/uploads/2026/01/target.pdf';
    const opaque = host([
      { text: 'Inviate la vostra candidatura', href: formHref },
      { text: 'Bando', href: target },
      { text: 'Apri', href: 'https://www.ecam.swiss/wp-content/uploads/2026/01/other.pdf' },
    ]);
    expect(postingDocumentHostBound(opaque, { pageUrl: career, postingUrl: target, applyUrl: career })).toBe(false);
    const privacy = [...hostLinks, { text: 'Informativa privacy', href: 'https://www.ecam.swiss/wp-content/uploads/2026/01/Informativa-privacy.pdf' }];
    expect(postingDocumentHostBound(host(privacy), { pageUrl: career, postingUrl, applyUrl: career })).toBe(false);
    // A PDF over plain http, or on another site, is a second document too.
    expect(postingDocumentHostBound(host([...hostLinks, { text: 'Apri', href: 'http://www.ecam.swiss/doc/altro.pdf' }]), {
      pageUrl: career, postingUrl, applyUrl: career,
    })).toBe(false);
    // The same notice linked twice is still one document.
    expect(postingDocumentHostBound(host([...hostLinks, { text: 'Bando (PDF)', href: `${postingUrl}#page=2` }]), {
      pageUrl: career, postingUrl, applyUrl: career,
    })).toBe(true);
    const notLinked = hostLinks.filter((link) => link.href !== postingUrl);
    expect(postingDocumentHostBound(host(notLinked), { pageUrl: career, postingUrl, applyUrl: career })).toBe(false);
    // Not the page the order names for applications, or another site.
    expect(postingDocumentHostBound(host(hostLinks), { pageUrl: 'https://www.ecam.swiss/', postingUrl, applyUrl: career })).toBe(false);
    expect(postingDocumentHostBound(host(hostLinks, 'https://jobs.example.ch/ecam/'), {
      pageUrl: 'https://jobs.example.ch/ecam/', postingUrl, applyUrl: 'https://jobs.example.ch/ecam/',
    })).toBe(false);
  });

  it('accepts the generic online form reached from that page, and stops on a form for another employer', () => {
    const formText = [
      '',
      'Numero candidatura',
      'Data di compilazione',
      'CANDIDATURA ONLINE',
      'I campi contrassegnati con * sono obbligatori.',
      'INFORMAZIONI SULLA CANDIDATURA',
      'Tipo di candidatura*',
      'DATI PERSONALI',
      'Nome:*', 'Cognome:*', 'Indirizzo e-mail:*',
      'Lettera di presentazione:*', 'Curriculum vitae:*',
      'RAPPORTO DI LAVORO CON L\'ECAM',
      'Accetto l\'informativa sulla privacy',
      formHref,
    ].join('\n');
    expect(namesAnotherEmployer(formText, job)).toBe(false);
    const options = {
      postingMatched: true, applicationEntry: true, applicationEntryUrl: formHref, pageUrl: formHref, postingUrl: career,
    };
    expect(formPostingMatch(formText, job, options)).toBe('match');
    // Generic and not reached from the bound page: a stop, as before.
    expect(formPostingMatch(formText, job, { pageUrl: formHref, postingUrl: career })).toBe('mismatch');
    // A form that names another employer next to the short form, or in its title, stops.
    expect(formPostingMatch(formText.replace('RAPPORTO DI LAVORO CON L\'ECAM', 'RAPPORTO DI LAVORO CON ECAM Holding'), job, options)).toBe('mismatch');
    expect(formPostingMatch(`Candidatura — Casa Anziani Altrove\n${formText}`, job, options)).toBe('mismatch');
  });
});
