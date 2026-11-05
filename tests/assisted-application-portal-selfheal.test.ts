import { describe, expect, it, vi } from 'vitest';
import { clickSubmitButton, guardAgentStep, isPreDispatchLocatorClickFailure, AGENT_SCHEMA } from '../scripts/assisted-application/lib/portal/agent.mjs';
import { labelsAt, learnedButton, normalizeLabel, portalKnowledgeStore, PORTAL_KNOWLEDGE_COLLECTION } from '../scripts/assisted-application/lib/portal/knowledge.mjs';
import { anonymizePath, clickButton, hasApplicationSurface, pageControls, stopReportFrom } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { CONFIRM_RE, REFUSED_RE } from '../scripts/assisted-application/lib/portal/fill.mjs';
import { candidateValues, redactStopReport, stopIssue } from '../scripts/assisted-application/lib/portal/stop-report.mjs';
import { createMemoryFirestore } from './helpers/memoryFirestore';

// Owner decision 2026-10-01: the runner corrects itself the way JOIN's «Conferma e applica» was fixed (#10725).
describe('portal runner self-correction', () => {
  it('recovers an external form-associated control through its unique exact role and owner', async () => {
    const locatorTimeout = new Error('locator.click: Timeout 6000ms exceeded waiting for locator [data-aa-id="f5"]');
    const staleClick = vi.fn().mockRejectedValue(locatorTimeout);
    const exactClick = vi.fn().mockResolvedValue(undefined);
    const externalForm = { getAttribute: (name: string) => name === 'data-aa-id' ? 'f2' : '' };
    const ownerDialog = { getAttribute: (name: string) => name === 'data-aa-dialog-id' ? 'd1' : '' };
    const externalButton = {
      form: externalForm,
      closest: (selector: string) => selector.includes('[aria-modal') ? ownerDialog : null,
    };
    const exactButton = {
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(true),
      click: exactClick,
      evaluate: vi.fn(async (read: (element: unknown) => unknown) => read(externalButton)),
    };
    const candidates = { count: vi.fn().mockResolvedValue(1), nth: vi.fn().mockReturnValue(exactButton) };
    const noLinks = { count: vi.fn().mockResolvedValue(0), nth: vi.fn() };
    const frame = {
      url: () => 'https://portal.example/apply',
      evaluate: vi.fn(async (read: unknown) => read === extractFieldsInPage ? ({
        url: 'https://portal.example/apply',
        fields: [],
        buttons: [{ id: 'f5', text: 'Weiter', formId: 'f2', dialog: true, dialogId: 'd1', disabled: false }],
        links: [],
        dialogs: [],
        captcha: false,
        passwordVisible: false,
        errors: [],
        text: '',
      }) : null),
      locator: vi.fn(() => ({ first: () => ({ click: staleClick }) })),
      getByRole: vi.fn((role: string) => role === 'button' ? candidates : noLinks),
    };
    const page = {
      url: () => 'https://portal.example/apply',
      frames: () => [frame],
      mainFrame: () => frame,
    };

    await expect(clickButton(page as any, { id: 'f5', text: 'Weiter', formId: 'f2', dialog: true, dialogId: 'd1', frame: 0 }))
      .resolves.toBe('role');
    expect(staleClick).toHaveBeenCalledTimes(2);
    expect(frame.getByRole).toHaveBeenCalledWith('button', { name: 'Weiter', exact: true });
    expect(exactButton.evaluate).toHaveBeenCalledOnce();
    expect(exactClick).toHaveBeenCalledWith({ timeout: 6000 });
  });

  it('recovers a scoped JavaScript action link when its snapshot omits the non-navigation href', async () => {
    const locatorTimeout = new Error('locator.click: Timeout 6000ms exceeded waiting for locator [data-aa-id="f5"]');
    const staleClick = vi.fn().mockRejectedValue(locatorTimeout);
    const exactClick = vi.fn().mockResolvedValue(undefined);
    const form = { getAttribute: (name: string) => name === 'data-aa-id' ? 'f2' : '' };
    const dialog = { getAttribute: (name: string) => name === 'data-aa-dialog-id' ? 'd1' : '' };
    const liveLink = {
      tagName: 'A',
      href: 'javascript:void(0)',
      form: null,
      closest: (selector: string) => selector === 'form' ? form : dialog,
    };
    const candidate = {
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(true),
      evaluate: vi.fn(async (read: (element: unknown) => unknown) => read(liveLink)),
      click: exactClick,
    };
    const candidates = { count: vi.fn().mockResolvedValue(1), nth: vi.fn().mockReturnValue(candidate) };
    const noButtons = { count: vi.fn().mockResolvedValue(0), nth: vi.fn() };
    const frame = {
      url: () => 'https://portal.example/apply',
      evaluate: vi.fn(async (read: unknown) => read === extractFieldsInPage ? ({
        url: 'https://portal.example/apply', fields: [],
        buttons: [{ id: 'f5', text: 'Weiter', href: '', formId: 'f2', dialog: true, dialogId: 'd1', disabled: false }],
        links: [], dialogs: [], captcha: false, passwordVisible: false, errors: [], text: '',
      }) : null),
      locator: vi.fn(() => ({ first: () => ({ click: staleClick }) })),
      getByRole: vi.fn((role: string) => role === 'link' ? candidates : noButtons),
    };
    const page = { url: () => 'https://portal.example/apply', frames: () => [frame], mainFrame: () => frame };

    await expect(clickButton(page as any, {
      id: 'f5', text: 'Weiter', href: '', formId: 'f2', dialog: true, dialogId: 'd1', frame: 0,
    })).resolves.toBe('role');
    expect(staleClick).toHaveBeenCalledTimes(2);
    expect(candidate.evaluate).toHaveBeenCalledOnce();
    expect(exactClick).toHaveBeenCalledWith({ timeout: 6000 });
  });

  it('retries only locator timeouts without evidence that a click action started', () => {
    expect(isPreDispatchLocatorClickFailure(new Error('locator.click: Timeout 6000ms exceeded waiting for locator [data-aa-id="f5"]'))).toBe(true);
    expect(isPreDispatchLocatorClickFailure(new Error('locator.click: locator resolved to 0 elements'))).toBe(true);
    expect(isPreDispatchLocatorClickFailure(new Error([
      'locator.click: Timeout 6000ms exceeded waiting for locator [data-aa-id="f5"]',
      'Call log:',
      '- locator resolved to <button>',
      '- performing click action',
      '- click action done',
      '- waiting for scheduled navigations to finish',
    ].join('\n')))).toBe(false);
  });

  it('does not search the whole frame when a refreshed control has no form or dialog scope', async () => {
    const locatorTimeout = new Error('locator.click: Timeout 6000ms exceeded waiting for locator [data-aa-id="f5"]');
    const staleClick = vi.fn().mockRejectedValue(locatorTimeout);
    const goto = vi.fn();
    const frame = {
      url: () => 'https://portal.example/apply',
      evaluate: vi.fn(async (read: unknown) => read === extractFieldsInPage ? ({
        url: 'https://portal.example/apply', fields: [],
        buttons: [{ id: 'f5', text: 'Weiter', href: '/next', disabled: false }],
        links: [], dialogs: [], captcha: false, passwordVisible: false, errors: [], text: '',
      }) : null),
      locator: vi.fn(() => ({ first: () => ({ click: staleClick }) })),
      getByRole: vi.fn(),
    };
    const page = { url: () => 'https://portal.example/apply', frames: () => [frame], mainFrame: () => frame, goto };

    await expect(clickButton(page as any, { id: 'f5', text: 'Weiter', href: '/next', frame: 0 })).rejects.toBe(locatorTimeout);
    expect(frame.getByRole).not.toHaveBeenCalled();
    expect(staleClick).toHaveBeenCalledTimes(2);
    expect(goto).not.toHaveBeenCalled();
  });

  it('does not navigate to an href when the refreshed control no longer matches', async () => {
    const locatorTimeout = new Error('locator.click: Timeout 6000ms exceeded waiting for locator [data-aa-id="f5"]');
    const staleClick = vi.fn().mockRejectedValue(locatorTimeout);
    const goto = vi.fn();
    const frame = {
      url: () => 'https://portal.example/apply',
      evaluate: vi.fn(async (read: unknown) => read === extractFieldsInPage ? ({
        url: 'https://portal.example/apply', fields: [],
        buttons: [{ id: 'f6', text: 'Fortfahren', href: '/next', disabled: false }],
        links: [], dialogs: [], captcha: false, passwordVisible: false, errors: [], text: '',
      }) : null),
      locator: vi.fn(() => ({ first: () => ({ click: staleClick }) })),
      getByRole: vi.fn(),
    };
    const page = { url: () => 'https://portal.example/apply', frames: () => [frame], mainFrame: () => frame, goto };

    await expect(clickButton(page as any, { id: 'f5', text: 'Weiter', href: '/next', frame: 0 })).rejects.toBe(locatorTimeout);
    expect(staleClick).toHaveBeenCalledOnce();
    expect(frame.getByRole).not.toHaveBeenCalled();
    expect(goto).not.toHaveBeenCalled();
  });

  it('does not role-retry a duplicate portal control or a click with an ambiguous dispatch outcome', async () => {
    const locatorTimeout = new Error('locator.click: Timeout 6000ms exceeded waiting for locator [data-aa-id="f5"]');
    const staleClick = vi.fn().mockRejectedValue(locatorTimeout);
    const ownerElement = {
      form: { getAttribute: (name: string) => name === 'data-aa-id' ? 'f2' : '' },
      closest: () => null,
    };
    const first = { isVisible: vi.fn().mockResolvedValue(true), isEnabled: vi.fn().mockResolvedValue(true), click: vi.fn(), evaluate: vi.fn(async (read: (element: unknown) => unknown) => read(ownerElement)) };
    const second = { isVisible: vi.fn().mockResolvedValue(true), isEnabled: vi.fn().mockResolvedValue(true), click: vi.fn(), evaluate: vi.fn(async (read: (element: unknown) => unknown) => read(ownerElement)) };
    const candidates = { count: vi.fn().mockResolvedValue(2), nth: vi.fn((index: number) => index === 0 ? first : second) };
    const noLinks = { count: vi.fn().mockResolvedValue(0), nth: vi.fn() };
    const frame = {
      url: () => 'https://portal.example/apply',
      evaluate: vi.fn(async (read: unknown) => read === extractFieldsInPage ? ({
        url: 'https://portal.example/apply', fields: [],
        buttons: [{ id: 'f5', text: 'Weiter', formId: 'f2', disabled: false }],
        links: [], dialogs: [], captcha: false, passwordVisible: false, errors: [], text: '',
      }) : null),
      locator: vi.fn(() => ({ first: () => ({ click: staleClick }) })),
      getByRole: vi.fn((role: string) => role === 'button' ? candidates : noLinks),
    };
    const page = { url: () => 'https://portal.example/apply', frames: () => [frame], mainFrame: () => frame };
    await expect(clickButton(page as any, { id: 'f5', text: 'Weiter', formId: 'f2', frame: 0 })).rejects.toBe(locatorTimeout);
    expect(first.click).not.toHaveBeenCalled();
    expect(second.click).not.toHaveBeenCalled();

    const ambiguousClick = vi.fn().mockRejectedValue(new Error([
      'locator.click: Timeout 6000ms exceeded waiting for locator [data-aa-id="f5"]',
      'Call log:',
      '- locator resolved to <button>',
      '- performing click action',
      '- click action done',
      '- waiting for scheduled navigations to finish',
    ].join('\n')));
    const ambiguousFrame = {
      ...frame,
      evaluate: vi.fn(),
      locator: vi.fn(() => ({ first: () => ({ click: ambiguousClick }) })),
      getByRole: vi.fn(),
    };
    const ambiguousPage = { ...page, frames: () => [ambiguousFrame], mainFrame: () => ambiguousFrame };
    await expect(clickButton(ambiguousPage as any, { id: 'f5', text: 'Weiter', frame: 0 }))
      .rejects.toThrow('waiting for scheduled navigations');
    expect(ambiguousFrame.evaluate).not.toHaveBeenCalled();
  });

  it('does not click a scoped link if its live href changed after the fresh snapshot', async () => {
    const locatorTimeout = new Error('locator.click: Timeout 6000ms exceeded waiting for locator [data-aa-id="f5"]');
    const staleClick = vi.fn().mockRejectedValue(locatorTimeout);
    const exactClick = vi.fn().mockResolvedValue(undefined);
    const form = { getAttribute: (name: string) => name === 'data-aa-id' ? 'f2' : '' };
    const dialog = { getAttribute: (name: string) => name === 'data-aa-dialog-id' ? 'd1' : '' };
    const liveLink = {
      tagName: 'A',
      href: 'https://portal.example/other',
      form: null,
      closest: (selector: string) => selector === 'form' ? form : dialog,
    };
    const candidate = {
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(true),
      evaluate: vi.fn(async (read: (element: unknown) => unknown) => read(liveLink)),
      click: exactClick,
    };
    const candidates = { count: vi.fn().mockResolvedValue(1), nth: vi.fn().mockReturnValue(candidate) };
    const noLinks = { count: vi.fn().mockResolvedValue(0), nth: vi.fn() };
    const frame = {
      url: () => 'https://portal.example/apply',
      evaluate: vi.fn(async (read: unknown) => read === extractFieldsInPage ? ({
        url: 'https://portal.example/apply', fields: [],
        buttons: [{ id: 'f5', text: 'Weiter', href: 'https://portal.example/next', formId: 'f2', dialog: true, dialogId: 'd1', disabled: false }],
        links: [], dialogs: [], captcha: false, passwordVisible: false, errors: [], text: '',
      }) : null),
      locator: vi.fn(() => ({ first: () => ({ click: staleClick }) })),
      getByRole: vi.fn((role: string) => role === 'button' ? candidates : noLinks),
    };
    const page = { url: () => 'https://portal.example/apply', frames: () => [frame], mainFrame: () => frame };

    await expect(clickButton(page as any, {
      id: 'f5', text: 'Weiter', href: 'https://portal.example/next', formId: 'f2', dialog: true, dialogId: 'd1', frame: 0,
    })).rejects.toBe(locatorTimeout);
    expect(staleClick).toHaveBeenCalledTimes(2);
    expect(candidate.evaluate).toHaveBeenCalledOnce();
    expect(exactClick).not.toHaveBeenCalled();
  });

  it('level 1: the agent may name the last page’s send button; the guard keeps only a real ref', () => {
    expect(Object.keys(AGENT_SCHEMA.properties)).toContain('submitRef');
    const turn = (submitRef: string) => ({ status: 'done', reason: '', advanceRef: '', submitRef, actions: [], questions: [] });
    expect(guardAgentStep(turn('e42'), null).submitRef).toBe('e42');
    expect(guardAgentStep(turn('button:has-text("Invia")'), null).submitRef).toBe('');
  });

  it('level 1: re-resolves an agent-named send button after SuccessFactors replaces its ref', async () => {
    const stale = { click: vi.fn().mockRejectedValue(new Error('locator.click: Timeout while waiting for locator')) };
    const form = { getAttribute: (name: string) => name === 'data-aa-id' ? 'f2' : '' };
    const dialog = { getAttribute: () => '' };
    const liveButton = { form, closest: () => dialog };
    const fresh = {
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn(async (read: (element: unknown) => unknown) => read(liveButton)),
    };
    const candidates = { count: vi.fn().mockResolvedValue(1), nth: vi.fn().mockReturnValue(fresh) };
    const frame = { getByRole: vi.fn().mockReturnValue(candidates) };
    const page = { mainFrame: () => frame };

    await expect(clickSubmitButton(page as any, { locator: stale, name: 'Postuler', frame, formId: 'f2' })).resolves.toBe('role');
    expect(frame.getByRole).toHaveBeenCalledWith('button', { name: 'Postuler', exact: true });
    expect(fresh.click).toHaveBeenCalledWith({ timeout: 6000 });
  });

  it('level 1: does not retry a click whose dispatch outcome is ambiguous', async () => {
    let dispatches = 0;
    const dispatchedThenRejected = {
      click: vi.fn(async () => {
        dispatches += 1;
        throw new Error([
          'locator.click: Timeout 6000ms exceeded waiting for locator [data-aa-id="f5"]',
          'Call log:',
          '- locator resolved to <button>',
          '- performing click action',
          '- click action done',
          '- waiting for scheduled navigations to finish',
        ].join('\n'));
      }),
    };
    const page = { getByRole: vi.fn() };

    await expect(clickSubmitButton(page as any, { locator: dispatchedThenRejected, name: 'Postuler' })).resolves.toBe('outcome');
    expect(dispatches).toBe(1);
    expect(page.getByRole).not.toHaveBeenCalled();
  });

  it('level 1: leaves a same-name control in another form untouched and returns the original miss', async () => {
    const originalMiss = new Error('locator.click: Timeout 6000ms exceeded waiting for locator [data-aa-id="f5"]');
    const ownerMiss = new Error('locator.click: Timeout 6000ms exceeded waiting for locator [data-aa-id="f8"]');
    const nonOwnerForm = { getAttribute: (name: string) => name === 'data-aa-id' ? 'f1' : '' };
    const ownerForm = { getAttribute: (name: string) => name === 'data-aa-id' ? 'f2' : '' };
    const noDialog = { getAttribute: () => '' };
    const nonOwner = {
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(true),
      click: vi.fn(),
      evaluate: vi.fn(async (read: (element: unknown) => unknown) => read({ form: nonOwnerForm, closest: () => noDialog })),
    };
    const owner = {
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockRejectedValue(ownerMiss),
      evaluate: vi.fn(async (read: (element: unknown) => unknown) => read({ form: ownerForm, closest: () => noDialog })),
    };
    const candidates = { count: vi.fn().mockResolvedValue(2), nth: vi.fn((index: number) => index === 0 ? nonOwner : owner) };
    const frame = { getByRole: vi.fn().mockReturnValue(candidates) };
    const page = { mainFrame: () => frame };

    await expect(clickSubmitButton(page as any, {
      locator: { click: vi.fn().mockRejectedValue(originalMiss) }, name: 'Postuler', frame, formId: 'f2',
    })).rejects.toBe(originalMiss);
    expect(nonOwner.click).not.toHaveBeenCalled();
    expect(owner.click).toHaveBeenCalledOnce();
  });

  it('level 2: remembers a portal’s buttons with their page after a confirmed submission and recognises them next time', async () => {
    const { db, read } = createMemoryFirestore();
    const store = portalKnowledgeStore({ db });
    expect(await store.load('join.com')).toEqual({ finalButtons: [], nextButtons: [] });
    const review = '/companies/*/*/apply/review';
    await store.learn('join.com', { finalButton: { path: review, label: 'Conferma e  applica' }, nextButtons: [{ path: '/companies/*/*/apply', label: 'Salva e prosegui' }] });
    await store.learn('JOIN.com', { finalButton: { path: review, label: 'Conferma e applica' } });
    const known = await store.load('join.com');
    expect(known).toEqual({ finalButtons: [{ path: review, label: 'conferma e applica' }], nextButtons: [{ path: '/companies/*/*/apply', label: 'salva e prosegui' }] });
    expect(read(`${PORTAL_KNOWLEDGE_COLLECTION}/join.com`)).toMatchObject({ confirmedSubmissions: 2 });
    // Exact label only, enabled only, on its own page only.
    const buttons = [{ id: 'b1', text: 'Conferma e applica filtro' }, { id: 'b2', text: ' Conferma e applica ', disabled: true }, { id: 'b3', text: 'Conferma e applica' }];
    expect(learnedButton(buttons, labelsAt(known.finalButtons, review))).toEqual({ id: 'b3', text: 'Conferma e applica' });
    expect(labelsAt(known.finalButtons, '/companies/*/*/apply')).toEqual([]);
    expect(normalizeLabel('  A   b ')).toBe('a b');
  });

  // Review of #10741: a label learned on the summary page is not a send button elsewhere on the host.
  it('level 2: a taught send button counts only on its page and never next to a step button', () => {
    // An unusual name (a usual one, «Conferma e applica» since #10725, is a send button anywhere).
    const known = { finalButtons: [{ path: '/jobs/*/review', label: 'abschliessen und übermitteln' }], nextButtons: [{ path: '/jobs/*/apply', label: 'salva e prosegui' }] };
    const send = { id: 's', text: 'Abschliessen und übermitteln' };
    const step = { id: 'n', text: 'Salva e prosegui' };
    expect(pageControls([send], known, 'https://portal.example/jobs/123/review')).toEqual({ submit: send, next: null });
    // Same label on an intermediate page: neither a send nor a step button, left to the page and the agent.
    expect(pageControls([send], known, 'https://portal.example/jobs/123/apply')).toEqual({ submit: null, next: null });
    expect(pageControls([send, step], known, 'https://portal.example/jobs/123/apply')).toEqual({ submit: null, next: step });
    // On its own page, next to a usual step button, still not a send button.
    const usualNext = { id: 'w', text: 'Weiter' };
    expect(pageControls([send, usualNext], known, 'https://portal.example/jobs/123/review')).toEqual({ submit: null, next: usualNext });
    // A usual send name keeps winning everywhere.
    const usualSend = { id: 'u', text: 'Bewerbung absenden' };
    expect(pageControls([usualSend, usualNext], known, 'https://portal.example/other')).toEqual({ submit: usualSend, next: usualNext });
  });

  it('does not mistake a public German image gallery for an application step', () => {
    const snapshot = {
      fields: [{
        id: 'attachment', kind: 'file', inputType: 'file',
        label: 'Eine oder mehrere Dateien auswählen (optional) (optional).', required: false,
        formId: 'public-gallery', frame: 0,
      }],
      buttons: [
        { text: 'Menü', chrome: true },
        { text: 'Mein Konto', chrome: true },
        { text: 'Vorheriges', formId: 'public-gallery', frame: 0, disabled: false },
        { text: 'Nächstes', formId: 'public-gallery', frame: 0, disabled: false },
        { text: 'Öffne Bild in Grossansicht', formId: 'public-gallery', frame: 0, disabled: false },
        { text: 'Seite drucken', formId: 'public-gallery', frame: 0, disabled: false },
      ],
    };

    expect(pageControls(snapshot.buttons, { nextButtons: [], finalButtons: [] }, 'https://www.stadt-zuerich.ch/bewerbungstipps/'))
      .toEqual({ submit: null, next: null });
    expect(hasApplicationSurface(snapshot)).toBe(false);
  });

  it('rejects a first or last gallery with only one paging direction', () => {
    const snapshot = {
      fields: [{
        id: 'attachment', kind: 'file', inputType: 'file',
        label: 'Eine oder mehrere Dateien auswählen (optional).', required: false,
      }],
      buttons: [
        { text: 'Nächstes', disabled: false },
        { text: 'Öffne Bild in Grossansicht', disabled: false },
        { text: 'Seite drucken', disabled: false },
      ],
    };

    const controls = pageControls(snapshot.buttons, { nextButtons: [], finalButtons: [] }, 'https://www.stadt-zuerich.ch/bewerbungstipps/', { snapshot });
    expect(controls.submit).toBeNull();
    expect(controls.next).toBeNull();
    expect(hasApplicationSurface(snapshot)).toBe(false);
  });

  it('suppresses a submit-like gallery control as well as its pager', () => {
    const snapshot = {
      fields: [{
        id: 'attachment', kind: 'file', inputType: 'file',
        label: 'Eine oder mehrere Dateien auswählen (optional).', required: false,
      }],
      buttons: [
        { text: 'Nächstes', disabled: false },
        { text: 'Submit', disabled: false },
        { text: 'Öffne Bild in Grossansicht', disabled: false },
        { text: 'Seite drucken', disabled: false },
      ],
    };

    const controls = pageControls(snapshot.buttons, { nextButtons: [], finalButtons: [] }, 'https://www.stadt-zuerich.ch/bewerbungstipps/', { snapshot });
    expect(controls.submit).toBeNull();
    expect(controls.next).toBeNull();
  });

  it('keeps a distinct application next control on a mixed gallery snapshot', () => {
    const next = { text: 'Next', formId: 'application', frame: 0, disabled: false };
    const snapshot = {
      fields: [{
        id: 'attachment', kind: 'file', inputType: 'file',
        label: 'Select one or more files (optional).', required: false,
        formId: 'public-gallery', frame: 0,
      }],
      buttons: [
        { text: 'Previous', formId: 'public-gallery', frame: 0, disabled: false },
        { text: 'Next', formId: 'public-gallery', frame: 0, disabled: false },
        { text: 'Open image in full size', formId: 'public-gallery', frame: 0, disabled: false },
        { text: 'Print page', formId: 'public-gallery', frame: 0, disabled: false },
        next,
      ],
    };

    expect(hasApplicationSurface(snapshot)).toBe(true);
    expect(pageControls(snapshot.buttons, { nextButtons: [], finalButtons: [] }, 'https://portal.example/apply/', { snapshot }).next)
      .toBe(next);
  });

  it('keeps an application next control with the gallery when frame and form are shared', () => {
    const next = { id: 'application-next', text: 'Next', formId: 'shared-surface', frame: 0, disabled: false };
    const snapshot = {
      fields: [{
        id: 'attachment', kind: 'file', inputType: 'file',
        label: 'Select one or more files (optional).', required: false,
        formId: 'shared-surface', frame: 0,
      }],
      buttons: [
        { id: 'gallery-previous', text: 'Previous', formId: 'shared-surface', frame: 0, disabled: false },
        { id: 'gallery-next', text: 'Next', formId: 'shared-surface', frame: 0, disabled: false },
        { id: 'gallery-view', text: 'Open image in full size', formId: 'shared-surface', frame: 0, disabled: false },
        { id: 'gallery-print', text: 'Print page', formId: 'shared-surface', frame: 0, disabled: false },
        next,
      ],
    };

    expect(hasApplicationSurface(snapshot)).toBe(true);
    expect(pageControls(snapshot.buttons, { nextButtons: [], finalButtons: [] }, 'https://portal.example/apply/', { snapshot }).next)
      .toBe(next);
  });

  it('keeps a field-less application next widget on a gallery-shaped page', () => {
    const next = { text: 'Next application step', disabled: false };
    const snapshot = {
      fields: [],
      buttons: [
        { text: 'Vorheriges', disabled: false },
        next,
        { text: 'Öffne Bild in Grossansicht', disabled: false },
        { text: 'Seite drucken', disabled: false },
      ],
    };

    expect(hasApplicationSurface(snapshot)).toBe(true);
    expect(pageControls(snapshot.buttons, { nextButtons: [], finalButtons: [] }, 'https://portal.example/apply/', { snapshot }).next).toBe(next);
  });

  it('keeps a German next step when the control owns an application form', () => {
    const next = { text: 'Nächstes', formId: 'application', frame: 0, disabled: false };
    const snapshot = {
      fields: [{ id: 'cv', kind: 'file', inputType: 'file', label: 'Lebenslauf', formId: 'application', frame: 0, required: true }],
      buttons: [
        { text: 'Vorheriges', disabled: false },
        next,
        { text: 'Öffne Bild in Grossansicht', disabled: false },
        { text: 'Seite drucken', disabled: false },
      ],
    };

    expect(pageControls(snapshot.buttons, { nextButtons: [], finalButtons: [] }, 'https://portal.example/apply/', { snapshot }).next).toBe(next);
    expect(hasApplicationSurface(snapshot)).toBe(true);
  });

  it('level 3: the stop report names the page without the employer or the posting', () => {
    expect(anonymizePath('https://join.com/companies/acme-sagl/16772222/apply/review?step=3#x')).toBe('/companies/*/*/apply/review');
    expect(anonymizePath('https://acme.wd3.myworkdayjobs.com/de-DE/External/job/Lugano/Pflege_R12345/apply')).toBe('/de-DE/External/job/*/*/apply');
    expect(anonymizePath('not a url')).toBe('');
    const report = stopReportFrom({
      url: 'https://join.com/companies/acme/16772222/apply/review',
      reason: 'portal_needs_candidate',
      step: 10,
      seen: { buttons: [{ text: 'Indietro' }, { text: 'Conferma e applica' }, { text: 'Indietro' }], fields: [{ label: 'Note', kind: 'textarea', required: false, value: 'x' }], errors: [] },
      agent: [{ hint: 'no_form_controls', status: 'done', rounds: [] }],
    });
    expect(report).toEqual({
      host: 'join.com', path: '/companies/*/*/apply/review', reason: 'portal_needs_candidate', step: 10,
      buttons: ['Indietro', 'Conferma e applica'], fields: [{ label: 'Note', kind: 'textarea', required: false }], errors: [],
      agent: [{ hint: 'no_form_controls', status: 'done' }],
    });
  });

  it('level 3: strikes every value of the candidate out before the public issue', () => {
    const values = candidateValues([['Maria Rossi', 'maria.rossi@example.com', '1986-09-12'], ['c-abcdefghjk@candidature.example'], ['+41 79 123 45 67']]);
    const clean = redactStopReport({
      host: 'jobs.example', path: '/apply', reason: 'portal_needs_candidate', step: 3,
      buttons: ['Profilo di Maria', 'Invia'],
      fields: [{ label: 'Rossi, conferma la data 12.09.1986', kind: 'text', required: true }],
      errors: ['Indirizzo maria.rossi@example.com già usato', 'Chiama +41 79 123 45 67', 'Scrivi a altro@example.org'],
    }, values);
    const text = JSON.stringify(clean);
    for (const value of ['Maria', 'Rossi', 'maria.rossi', '12.09.1986', '123 45 67', 'altro@example.org']) expect(text).not.toContain(value);
    expect(clean.buttons).toEqual(['Profilo di [dato del candidato]', 'Invia']);

    const issue = stopIssue(clean, 'https://github.com/o/r/actions/runs/1');
    expect(issue.title).toBe('[portal-stop] jobs.example: pagina non superata su /apply');
    expect(issue.dedupKey).toBe(issue.title);
    expect(issue.description).toContain('`Invia`');
    expect(issue.description).toContain('onBeforeSubmit');
    expect(issue.description).not.toContain('Maria');
  });

  // P4: a birth date typed on the review page the Swiss way is struck in its ISO form too, and a written one in both.
  it('level 3: strikes a birth date in every form the portals and the CV write it', () => {
    expect(candidateValues([['12.09.1986']])).toEqual(expect.arrayContaining(['12.09.1986', '1986-09-12', '12/09/1986', '12-09-1986']));
    expect(candidateValues([['14. März 2010']])).toEqual(expect.arrayContaining(['2010-03-14', '14.03.2010']));
  });

  // JOIN run 36846326334: after «Conferma e applica» the portal said it did not send.
  it('reads a portal’s own refusal as a refusal, never as a confirmation', () => {
    for (const text of [
      'Non siamo riusciti a inviare la tua candidatura. Riprova.',
      'We couldn’t submit your application',
      "We couldn't send your application",
      'Ihre Bewerbung konnte nicht gesendet werden.',
      "Nous n'avons pas pu envoyer votre candidature.",
    ]) {
      expect(REFUSED_RE.test(text)).toBe(true);
      expect(CONFIRM_RE.test(text)).toBe(false);
    }
    expect(REFUSED_RE.test('Grazie per la tua candidatura, è stata inviata.')).toBe(false);
  });
});
