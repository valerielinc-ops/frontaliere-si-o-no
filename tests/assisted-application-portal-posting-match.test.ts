import { describe, expect, it } from 'vitest';
import {
  applicationEntryControls,
  formPostingMatch,
  jobRoomExternalAdTarget,
} from '../scripts/assisted-application/lib/portal/portal.mjs';

describe('application form posting identity', () => {
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

  it('keeps a generic form reached from the selected posting unknown and continues', () => {
    const genericForm = 'Bewerbung\nVorname\nNachname\nE-Mail-Adresse\nWeiter';
    const job = { title: 'Pflegefachperson', company: 'Spital Esempio' };
    expect(formPostingMatch(genericForm, job, { postingMatched: true, applicationEntry: true })).toBe('unknown');
    expect(formPostingMatch(genericForm, job)).toBe('mismatch');
  });

  it('rejects a different named role and a different Umantis vacancy ID', () => {
    const postingUrl = 'https://recruitingapp-2800.umantis.com/Vacancies/6604/Description/1';
    const job = { title: 'Pflegefachfrau Gesundheit', sourceTitle: 'Pflegefachfrau Gesundheit' };
    expect(formPostingMatch('Sachbearbeiter Buchhaltung - Bewerbung', job, {
      pageUrl: 'https://careers.example.test/application/new', postingMatched: true,
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
