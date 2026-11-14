import { describe, expect, it } from 'vitest';
import { applicationEntryControls, pageControls } from '../scripts/assisted-application/lib/portal/portal.mjs';

// Synthetic URL and control metadata: issue #17253 supplies only the route
// shape, labels and absence of fields, not the actual CTA href or job id.
const url = 'https://careers.helsana.ch/job/Synthetic-role/123/';
const buttons = ['Mehr Optionen anzeigen', 'Stellen suchen', 'Löschen', 'Jetzt bewerben']
  .map(text => ({ text }));
const snapshot = { url, buttons, fields: [] };
const context = {
  postingUrl: url,
  applyUrl: url,
  allowSingleExternalApplicationEntry: true,
  selectedPostingIsApplicationUrl: true,
};

describe('verified posting script entry (#17253)', () => {
  it('opens the unique script CTA on the verified fieldless job detail', () => {
    expect(applicationEntryControls(snapshot, context)).toEqual([buttons[3]]);
    // This exception belongs to entry navigation, never to final submission.
    expect(pageControls(buttons, { nextButtons: [], finalButtons: [] }, url,
      { snapshot, applyUrl: url }).submit).toBeNull();
  });

  it('accepts a unique script Apply control on the exact selected posting route without vendor identity', () => {
    const postingUrl = 'https://jobs.example.test/job/synthetic-role/42/';
    const apply = { text: 'Apply now', frame: 0 };
    const context = {
      applyUrl: postingUrl,
      postingUrl,
      selectedPostingIsApplicationUrl: true,
      allowSingleExternalApplicationEntry: true,
    };

    expect(applicationEntryControls({ url: postingUrl, fields: [], buttons: [apply] }, context)).toEqual([apply]);
    expect(applicationEntryControls({ url: postingUrl, fields: [], buttons: [apply] }, {
      ...context,
      allowSingleExternalApplicationEntry: false,
    })).toEqual([]);
    expect(applicationEntryControls({ url: postingUrl, fields: [{ inputType: 'email' }], buttons: [apply] }, context)).toEqual([]);
    expect(applicationEntryControls({ url: postingUrl, fields: [], buttons: [apply, { text: 'Apply to a talent pool', frame: 0 }] }, context)).toEqual([]);
    expect(applicationEntryControls({ url: `${postingUrl}different/`, fields: [], buttons: [apply] }, context)).toEqual([]);
  });

  it('opens the sole BrassRing Apply now control on UBS HomeWithPreLoad', () => {
    const ubsUrl = 'https://jobs.ubs.com/TGNewUI/Search/Home/HomeWithPreLoad?partnerid=25008&siteid=5012&jobid=348358&PageType=jobdetails';
    const apply = { text: 'Apply now', frame: 0 };
    const snapshot = {
      url: ubsUrl,
      fields: [],
      buttons: [
        { text: 'Share', frame: 0 },
        apply,
        { text: 'Save', frame: 0 },
      ],
    };
    const context = {
      applyUrl: ubsUrl,
      postingUrl: ubsUrl,
      selectedPostingIsApplicationUrl: true,
      allowSingleExternalApplicationEntry: true,
    };

    expect(applicationEntryControls(snapshot, context)).toEqual([apply]);
    expect(pageControls(snapshot.buttons, { nextButtons: [], finalButtons: [] }, ubsUrl, {
      snapshot,
      applyUrl: ubsUrl,
    })).toMatchObject({ submit: null, next: null });
  });

  it('keeps BrassRing search shells and other UBS jobs unresolved', () => {
    const ubsUrl = 'https://jobs.ubs.com/TGNewUI/Search/Home/HomeWithPreLoad?partnerid=25008&siteid=5012&jobid=348358&PageType=jobdetails';
    const apply = { text: 'Apply now', frame: 0 };
    const context = {
      applyUrl: ubsUrl,
      postingUrl: ubsUrl,
      selectedPostingIsApplicationUrl: true,
      allowSingleExternalApplicationEntry: true,
    };
    const snapshot = { url: ubsUrl, fields: [], buttons: [apply] };

    expect(applicationEntryControls({ ...snapshot, url: ubsUrl.replace('&jobid=348358', '') }, context)).toEqual([]);
    expect(applicationEntryControls({ ...snapshot, url: ubsUrl.replace('jobid=348358', 'jobid=348359') }, context)).toEqual([]);
    expect(applicationEntryControls({ ...snapshot, buttons: [apply, { text: 'Apply for another job', frame: 0 }] }, context)).toEqual([]);
  });

  it.each([
    ['unverified posting', snapshot, { ...context, allowSingleExternalApplicationEntry: false }],
    ['different job', { ...snapshot, url: url.replace('123', '456') }, context],
    ['different origin', { ...snapshot, url: url.replace('helsana', 'other') }, context],
    ['listing', { ...snapshot, url: 'https://careers.helsana.ch/jobs/' }, { ...context, postingUrl: 'https://careers.helsana.ch/jobs/' }],
    ['application fields', { ...snapshot, fields: [{ inputType: 'email' }] }, context],
    ['unknown fields', { url, buttons }, context],
    ['form-owned CTA', { ...snapshot, buttons: [{ text: 'Jetzt bewerben', formId: 'application' }] }, context],
    ['conflicting posting identity', { ...snapshot, buttons: [{ text: 'Jetzt bewerben', postingId: 'other' }] }, context],
    ['multiple CTAs', { ...snapshot, buttons: [...buttons, { text: 'Apply now' }] }, context],
    ['frame CTA', { ...snapshot, buttons: [{ text: 'Jetzt bewerben', frame: 1 }] }, context],
    ['disabled CTA', { ...snapshot, buttons: [{ text: 'Jetzt bewerben', disabled: true }] }, context],
    ['chrome CTA', { ...snapshot, buttons: [{ text: 'Jetzt bewerben', chrome: true }] }, context],
  ])('keeps %s unresolved', (_name, page, entryContext) => {
    expect(applicationEntryControls(page, entryContext)).toEqual([]);
  });

  it('rejects a fieldless script CTA when posting identity markers conflict', () => {
    const postingUrl = 'https://portal.test/job/current/role/';
    expect(applicationEntryControls({
      url: postingUrl,
      fields: [],
      buttons: [{ text: 'Apply', frame: 0, postingId: 'other', context: 'postingId current' }],
    }, {
      postingUrl,
      allowSingleExternalApplicationEntry: true,
    })).toEqual([]);
  });

  it('rejects a title-matching fieldless CTA with a conflicting vacancy identity', () => {
    const postingUrl = 'https://portal.test/job/current/role/';
    expect(applicationEntryControls({
      url: postingUrl,
      fields: [],
      buttons: [{ text: 'Apply', frame: 0, vacancyContext: 'Current Role postingId other' }],
    }, {
      postingUrl,
      allowSingleExternalApplicationEntry: true,
      job: { title: 'Current Role' },
    })).toEqual([]);
  });
});
