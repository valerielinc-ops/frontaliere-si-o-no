import { describe, expect, it } from 'vitest';
import {
  applicationEntryControlMatchesSelectedPosting,
  applicationEntryControls,
} from '../scripts/assisted-application/lib/portal/portal.mjs';
import { refusal } from '../scripts/assisted-application/lib/portal/agent.mjs';

// Synthetic snapshot of a staffing company's posting page (shaped after the 2026-11-28 STA case): no form field,
// one «Jetzt bewerben!» anchor to `/bewerbung/?job-id=<internal id>` (a route that names neither the posting's URL
// id nor its role), a watch-list anchor and the cookie control (site chrome).
const POSTING = 'https://careers.example.test/stellen/example-role-in-testingen-116104/';
const APPLY = 'https://careers.example.test/bewerbung/?job-id=12345-EX';
const context = {
  applyUrl: POSTING, postingUrl: POSTING, sourceProtocol: null, postingRouteProof: null,
  job: { company: 'Example Staffing AG', title: 'Example Role' },
  // The posting binding already matched this page (postingMatch: match).
  allowSingleExternalApplicationEntry: true,
};
const applyButton = (over: Record<string, unknown> = {}) => ({ id: 'e1', text: 'Jetzt bewerben!', label: 'Jetzt bewerben!', href: APPLY, frame: 0, ...over });
const snapshot = (over: Record<string, unknown> = {}) => ({
  url: POSTING, fields: [], links: [], dialogs: [],
  buttons: [applyButton(), { id: 'e2', text: 'Auf Merkliste', href: '#', frame: 0 }, { id: 'e3', text: 'Zustimmung verwalten', chrome: true }],
  ...over,
});
const entryInfo = { button: true, name: 'Jetzt bewerben!', leaves: true, inForm: false, submits: false, href: APPLY };

describe('a fieldless, bound posting page: its sole application link is the entry, not the final send', () => {
  it('resolves the link as the posting entry and binds the agent control to it', () => {
    const snap = snapshot();
    const entries = applicationEntryControls(snap as any, context as any);
    expect(entries).toHaveLength(1);
    expect(applicationEntryControlMatchesSelectedPosting({ name: 'Jetzt bewerben!', href: APPLY } as any, entries, snap as any, context as any)).toBe(true);
  });

  it('lets the agent open it once the entry is proved, and keeps it reserved when it is not', () => {
    expect(refusal({ action: 'click' } as any, entryInfo as any, { navigationEnabled: true, allowApplicationEntry: true })).toBe('');
    expect(refusal({ action: 'click' } as any, entryInfo as any, { navigationEnabled: true, allowApplicationEntry: false })).toBe('final_submit_reserved');
  });

  it.each([
    ['Apply', 'Apply now'],
    ['Postuler', 'Postuler maintenant'],
    ['Candidarsi', 'Candidati ora'],
  ])('reads the control by its name in other languages (%s)', (_name, label) => {
    const snap = snapshot({ buttons: [applyButton({ text: label, label })] });
    expect(applicationEntryControls(snap as any, context as any)).toHaveLength(1);
  });

  it('repeated links to the same route (above and below the text) are one entry', () => {
    const snap = snapshot({ buttons: [applyButton(), applyButton({ id: 'e9' })] });
    expect(applicationEntryControls(snap as any, context as any)).toHaveLength(1);
  });

  it('takes a short route of the site itself, with or without a query string', () => {
    for (const href of ['https://careers.example.test/bewerbung/', 'https://careers.example.test/apply', 'https://careers.example.test/bewerbung/?job-id=12345-EX']) {
      expect(applicationEntryControls(snapshot({ buttons: [applyButton({ href })] }) as any, context as any)).toHaveLength(1);
    }
  });

  describe('stays unresolved', () => {
    it('when the page has a form field (a filled form is no entry page)', () => {
      const snap = snapshot({ fields: [{ id: 'f1', label: 'E-Mail', inputType: 'email', frame: 0 }] });
      expect(applicationEntryControls(snap as any, context as any)).toHaveLength(0);
    });

    it('when the posting binding did not match this page', () => {
      expect(applicationEntryControls(snapshot() as any, { ...context, allowSingleExternalApplicationEntry: false } as any)).toHaveLength(0);
    });

    it('when the page is not the posting itself', () => {
      const snap = snapshot({ url: 'https://careers.example.test/stellen/' });
      expect(applicationEntryControls(snap as any, context as any)).toHaveLength(0);
    });

    it('when two different routes both ask to apply', () => {
      const snap = snapshot({ buttons: [applyButton(), applyButton({ id: 'e8', text: 'Bewerben', label: 'Bewerben', href: 'https://careers.example.test/bewerbung/?job-id=999-EX' })] });
      expect(applicationEntryControls(snap as any, context as any)).toHaveLength(0);
    });

    it('when another application control (a script button) competes with the link', () => {
      const snap = snapshot({ buttons: [applyButton(), { id: 'e7', text: 'Jetzt bewerben', label: 'Jetzt bewerben', frame: 0 }] });
      expect(applicationEntryControls(snap as any, context as any)).toHaveLength(0);
    });

    it('when a dialog is open over the page, or a route proof disagrees', () => {
      expect(applicationEntryControls(snapshot({ dialogs: [{ dialog: true, dialogId: 'd1' }] }) as any, context as any)).toHaveLength(0);
      expect(applicationEntryControls(snapshot() as any, { ...context, postingRouteProof: { via: 'other' } } as any)).toHaveLength(0);
    });

    it('when the link is a final-send label', () => {
      const snap = snapshot({ buttons: [applyButton({ text: 'Bewerbung absenden', label: 'Bewerbung absenden' })] });
      expect(applicationEntryControls(snap as any, context as any)).toHaveLength(0);
    });

    it('when the route belongs to another host, or names a vacancy in its path', () => {
      for (const href of [
        'https://ats.example.test/apply/start',
        'https://careers.example.test/vacancies/2780/application/new',
        'https://careers.example.test/fr/jobs/apply/OtherPostingId',
      ]) {
        expect(applicationEntryControls(snapshot({ buttons: [applyButton({ href })] }) as any, context as any)).toHaveLength(0);
      }
    });

    it('when the target is not https', () => {
      const snap = snapshot({ buttons: [applyButton({ href: 'http://careers.example.test/bewerbung/?job-id=1' })] });
      expect(applicationEntryControls(snap as any, context as any)).toHaveLength(0);
    });
  });

  describe('the real final send is untouched', () => {
    const filledForm = { button: true, name: 'Bewerbung absenden', leaves: false, inForm: true, submits: true };

    it('a filled form and «Bewerbung absenden» stay reserved even when entries are allowed', () => {
      expect(refusal({ action: 'click' } as any, filledForm as any, { navigationEnabled: true, allowApplicationEntry: true })).toBe('final_submit_reserved');
    });

    it('so do «Submit application» and «Jetzt bewerben» inside a form', () => {
      expect(refusal({ action: 'click' } as any, { ...filledForm, name: 'Submit application' } as any, { navigationEnabled: true, allowApplicationEntry: true })).toBe('final_submit_reserved');
      expect(refusal({ action: 'click' } as any, { ...entryInfo, inForm: true, leaves: false, submits: true } as any, { navigationEnabled: true, allowApplicationEntry: true })).toBe('final_submit_reserved');
    });
  });
});
