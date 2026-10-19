import { describe, expect, it, vi } from 'vitest';
import { addressQuestionTopic, ageAt, SENSITIVE, answeredByCandidate, candidateAnswerForField, candidateAnswerForQuestion, currentEmploymentOption, guardPlan, holdsValue, inferredNativeLanguageCodes, isDateField, knownValuesOf, nativeLanguageOption, normalizeDateAnswer, ownConsent, planSystemPrompt, PLAN_SCHEMA, questionFromLabel, questionTopic } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { permitStatement } from '../functions/src/lib/permitStatus.js';
import { CONFIRM_RE, NEXT_RE, SUBMIT_RE, VALIDATION_RE, applyActions, chooseFiles, findButton, nationalityOptionLabel, residenceCountryOptionLabel, searchHolds, uploadReceipt } from '../scripts/assisted-application/lib/portal/fill.mjs';
import { verificationIsPending, verificationOutcome } from '../scripts/assisted-application/lib/portal/account.mjs';
import { autoAnswersForPortalQuestions, candidateForForm, clickPortalLink, COVER_LETTER_UPLOAD_RE, CV_UPLOAD_RE, dedupePortalQuestions, failedConsentRequiresHandoff, hasApplicationSurface, isOtpVerificationPage, openFormSections, portalQuestionId, portalQuestionKey, profileEntriesForSection, profileEntryAnswer, removalsOf, slugId, waitForFileRemoval, WAVE1_CHANNELS } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { resolveResidenceAddress } from '../scripts/assisted-application/lib/portal/residence-address.mjs';
import { personalValuesOf } from '../scripts/assisted-application/lib/secure-run.mjs';

const fields = [
  { id: 'f1', kind: 'text', label: 'First name', required: true },
  { id: 'f2', kind: 'select', label: 'Work permit *', required: true, options: [{ label: 'G' }, { label: 'B' }] },
  { id: 'f3', kind: 'text', label: 'Salary expectation', required: false },
  { id: 'f4', kind: 'select', label: 'Country', required: true, options: [{ label: 'Switzerland' }, { label: 'Italy' }] },
  { id: 'f5', kind: 'file', label: 'Resume/CV', required: true },
];

describe('application-surface detection', () => {
  it('does not treat employer-site chrome as an application form', () => {
    expect(hasApplicationSurface({
      fields: [],
      buttons: [{ text: 'Menu', chrome: true }, { text: 'Finden', chrome: true }],
    })).toBe(false);
    expect(hasApplicationSurface({
      fields: [],
      buttons: [{ text: 'Weiter', chrome: false }],
    })).toBe(true);
    expect(hasApplicationSurface({
      fields: [{ id: 'f1', kind: 'text' }],
      buttons: [{ text: 'Menu', chrome: true }],
    })).toBe(true);
  });
});

describe('assisted application profile history and file replacement', () => {
  it('matches an icon-only removal control through its nearby uploaded-file context', () => {
    const remove = { id: 'remove-cv', text: 'Delete', fileContext: 'CV_Luca_Bianchi.pdf successfully uploaded', disabled: false };
    expect(removalsOf([remove], ['CV_Luca_Bianchi.pdf'])).toEqual([remove]);
    expect(removalsOf([{ ...remove, fileContext: 'Cover_Letter.pdf successfully uploaded' }], ['CV_Luca_Bianchi.pdf'])).toEqual([]);
  });

  it('waits boundedly for an asynchronously removed prior filename to disappear', async () => {
    let visible = true;
    const waitFor = vi.fn(async ({ state, timeout }: { state: string; timeout: number }) => {
      expect(state).toBe('hidden');
      expect(timeout).toBe(1500);
      await new Promise((resolve) => setTimeout(() => { visible = false; resolve(undefined); }, 350));
      if (visible) throw new Error('still visible');
    });
    const page = { getByText: () => ({ first: () => ({ waitFor }) }) };
    expect(await waitForFileRemoval(page as any, 'CV.pdf')).toBe(true);
    expect(visible).toBe(false);

    const timeoutPage = { getByText: () => ({ first: () => ({ waitFor: vi.fn().mockRejectedValue(new Error('still visible')) }) }) };
    expect(await waitForFileRemoval(timeoutPage as any, 'CV.pdf')).toBe(false);
  });

  it('keeps profile entries in source order and skips entries without explicit month-level start and end dates', () => {
    const candidate = { profile: { experience: [
      { role: 'First', employer: 'A', start: '03/2020', end: '2022-04' },
      { role: 'Undated', employer: 'B', start: '2021', end: '' },
      { role: 'Second', employer: 'C', start: 'May 2022', end: 'Oktober 2024' },
      { role: '', employer: 'D', start: '2020-01', end: '2021-01' },
    ] } };
    expect(profileEntriesForSection(candidate, 'experience').map((entry) => entry.role)).toEqual(['First', 'Second']);
    expect(profileEntriesForSection(candidate, 'education')).toEqual([]);
  });

  it('uses exact education-row labels to recover only the corresponding profile fact', () => {
    const entry = { degree: 'Vocational Diploma', institution: 'Scuola Cantonale', start: '2015-09', end: '2018-06' };
    expect(profileEntryAnswer(entry, 'education', { label: 'Degree *' })).toEqual({ value: 'Vocational Diploma', source: 'profile' });
    expect(profileEntryAnswer(entry, 'education', { label: 'End Date *' })).toEqual({ value: '2018-06', source: 'profile' });
    expect(profileEntryAnswer(entry, 'education', { label: 'Do you have a degree?' })).toBeNull();
  });

  it('does not mistake a selected Workday filename for a successful upload receipt', async () => {
    const locator = { evaluate: vi.fn(async () => ['CV.pdf']) };
    const page = {
      url: () => 'https://acme.wd1.myworkdayjobs.com/apply',
      locator: () => ({ allInnerTexts: async () => [] }),
      getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
      waitForTimeout: async () => {},
    };
    expect(await uploadReceipt(page as any, locator as any, ['/tmp/CV.pdf'], { timeoutMs: 0 })).toBe(false);
    expect(await uploadReceipt(page as any, locator as any, ['/tmp/CV.pdf'], { acceptedResponse: true, timeoutMs: 0 })).toBe(true);
    const visibleWorkdayName = { ...page, getByText: () => ({ first: () => ({ isVisible: async () => true }) }) };
    expect(await uploadReceipt(visibleWorkdayName as any, locator as any, ['/tmp/CV.pdf'], { timeoutMs: 0 })).toBe(false);
    const visibleNonWorkdayReceipt = { ...visibleWorkdayName, url: () => 'https://jobs.example/apply' };
    expect(await uploadReceipt(visibleNonWorkdayReceipt as any, locator as any, ['/tmp/CV.pdf'], { timeoutMs: 0 })).toBe(true);
  });
});

describe('portal link clicks', () => {
  it('uses a locator with a bounded timeout', async () => {
    const link = { getAttribute: vi.fn().mockResolvedValue('/apply'), click: vi.fn().mockResolvedValue(undefined) };
    const page = { url: () => 'https://jobs.example/careers', goto: vi.fn() };

    await clickPortalLink(page, link);

    expect(link.click).toHaveBeenCalledWith({ timeout: 6_000 });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('navigates to a stable href when the live link cannot be clicked', async () => {
    const link = { getAttribute: vi.fn().mockResolvedValue('/apply'), click: vi.fn().mockRejectedValue(new Error('element detached')) };
    const page = { url: () => 'https://jobs.example/careers', goto: vi.fn().mockResolvedValue(undefined) };

    await clickPortalLink(page, link);

    expect(page.goto).toHaveBeenCalledWith('https://jobs.example/apply', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  });

  it('starts the popup watcher before resolving a re-rendering apply locator', async () => {
    const order: string[] = [];
    const popup = { url: () => 'https://jobs.example/apply' };
    const context = { waitForEvent: vi.fn(() => { order.push('watch'); return Promise.resolve(popup); }) };
    const link = {
      getAttribute: vi.fn(async () => { order.push('href'); return '/apply'; }),
      click: vi.fn(async () => { order.push('click'); }),
    };
    const page = { url: () => 'https://jobs.example/careers', goto: vi.fn() };

    expect(await clickPortalLink(page, link, { context })).toBe(popup);
    expect(order).toEqual(['watch', 'href', 'click']);
    expect(context.waitForEvent).toHaveBeenCalledWith('page', { timeout: 60_000 });
  });
});

describe('legacy portal sections', () => {
  it('opens closed Rexx/Portal7 accordion groups before planning the page', async () => {
    const groups = [{ id: 'group_head_personal', open: false }, { id: 'group_head_language', open: false }];
    const fields = () => [
      { id: 'first', kind: 'text', label: 'First group', required: false },
      ...groups.filter((group) => group.open).map((group) => ({ id: group.id, kind: 'select', label: group.id, required: true })),
    ];
    const frame = {
      url: () => 'https://www.concorsi.ti.ch/forma-di-lavoro.html?yid=4304',
      evaluate: vi.fn(async () => ({
        url: 'https://www.concorsi.ti.ch/forma-di-lavoro.html?yid=4304',
        title: 'Application',
        fields: fields(),
        buttons: [],
        captcha: false,
        passwordVisible: false,
        errors: [],
        text: '',
      })),
    };
    const headers = groups.map((group) => ({
      getAttribute: vi.fn(async (name: string) => name === 'id' ? group.id : null),
      evaluate: vi.fn(async (read: (element: any) => boolean) => read({
        getAttribute: () => null,
        classList: { contains: (name: string) => name === 'group_extended' && group.open },
        nextElementSibling: { open: group.open, getBoundingClientRect: () => ({ height: group.open ? 100 : 0 }) },
      })),
      click: vi.fn(async () => { group.open = true; }),
    }));
    const page = {
      url: () => 'https://www.concorsi.ti.ch/forma-di-lavoro.html?yid=4304',
      frames: () => [frame],
      mainFrame: () => frame,
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      locator: vi.fn((selector: string) => selector === '.group_head'
        ? { count: vi.fn(async () => headers.length), nth: (index: number) => headers[index] }
        : { count: vi.fn(async () => 0) }),
    };
    const before = { url: page.url(), fields: [{ id: 'first', kind: 'text', label: 'First group', required: false }], buttons: [] };
    const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = { getComputedStyle: (group: any) => ({ display: group.open ? 'block' : 'none' }) };
    let result;
    try {
      result = await openFormSections(page as any, before as any);
    } finally {
      if (hadWindow) (globalThis as any).window = previousWindow;
      else delete (globalThis as any).window;
    }

    expect(headers.every((header) => header.click.mock.calls.length === 1)).toBe(true);
    expect(result.snapshot.fields.map((field: any) => field.id)).toEqual(['first', 'group_head_personal', 'group_head_language']);
  });
});

describe('portal plan guard (career-ops apply rules in code)', () => {
  it('recognises French ATS upload controls and maps nationality aliases to the portal catalogue', () => {
    expect(CV_UPLOAD_RE.test('Charger un CV')).toBe(true);
    expect(COVER_LETTER_UPLOAD_RE.test('Joindre une lettre de motivation')).toBe(true);
    expect(nationalityOptionLabel('italiana', ['allemande', 'italienne', 'suisse'])).toBe('italienne');
    expect(nationalityOptionLabel('italiana', ['Italie', 'Italia'])).toBe('');
    expect(nationalityOptionLabel('italiana', ['Italie', 'italienne'], 'fr')).toBe('italienne');
    expect(residenceCountryOptionLabel('Italia', ['Switzerland', 'Italy'])).toBe('Italy');
  });

  it('chooses the canonical French label when a native nationality select has equivalent options', async () => {
    let selected = '';
    const control = {
      selectOption: vi.fn(async ({ label }: { label: string }) => { selected = label; }),
      evaluate: vi.fn(async (_read: unknown, data: { wanted: string }) => selected.toLowerCase() === data.wanted),
    };
    const frame = { locator: vi.fn(() => ({ first: () => control })) };
    const page = { frames: () => [frame], mainFrame: () => frame };
    const result = await applyActions(page as any, [{
      id: 'nationality',
      kind: 'select',
      label: '* Nationalité',
      options: [{ label: 'Italie' }, { label: 'italienne' }],
    }], [{ fieldId: 'nationality', action: 'select', value: 'italiana' }], {}, { pause: async () => {} });

    expect(result).toEqual([{ fieldId: 'nationality', ok: true }]);
    expect(control.selectOption).toHaveBeenCalledWith({ label: 'italienne' }, { timeout: 6000 });
  });

  it('chooses a localized residence country option from the deterministic country answer', async () => {
    let selected = '';
    const control = {
      selectOption: vi.fn(async ({ label }: { label: string }) => { selected = label; }),
      evaluate: vi.fn(async (_read: unknown, data: { wanted: string }) => selected.toLowerCase() === data.wanted),
    };
    const frame = { locator: vi.fn(() => ({ first: () => control })) };
    const page = { frames: () => [frame], mainFrame: () => frame };
    const result = await applyActions(page as any, [{
      id: 'residence-country',
      kind: 'select',
      label: 'Country of residence',
      options: [{ label: 'Italy' }, { label: 'Switzerland' }],
    }], [{ fieldId: 'residence-country', action: 'select', value: 'Italia' }], {}, { pause: async () => {} });

    expect(result).toEqual([{ fieldId: 'residence-country', ok: true }]);
    expect(control.selectOption).toHaveBeenCalledWith({ label: 'Italy' }, { timeout: 6000 });
  });

  it('reports a checkbox that did not commit instead of treating the click as done', async () => {
    const control = {
      setChecked: vi.fn(async () => {}),
      isChecked: vi.fn(async () => false),
    };
    const frame = { locator: vi.fn(() => ({ first: () => control })) };
    const page = { frames: () => [frame], mainFrame: () => frame };
    const result = await applyActions(page as any, [{ id: 'privacy', kind: 'checkbox', label: 'Privacy', required: true }], [{ fieldId: 'privacy', action: 'check', value: '' }], {}, { pause: async () => {} });
    expect(result).toEqual([{ fieldId: 'privacy', ok: false, error: 'choice_not_registered' }]);
  });

  it('resolves a localized nationality in a generic combobox when the raw label is absent', async () => {
    let selected = '';
    const localizedOption = {
      waitFor: vi.fn(async () => {}),
      click: vi.fn(async () => { selected = 'italienne'; }),
    };
    const rawOption = { first: () => ({ waitFor: vi.fn(async () => { throw new Error('not found'); }) }) };
    const control = {
      click: vi.fn(),
      pressSequentially: vi.fn(),
      evaluate: vi.fn(async (_read: unknown, data: { wanted: string }) => selected === data.wanted),
    };
    const frame = {
      locator: vi.fn(() => ({ first: () => control })),
      getByRole: vi.fn((_role: string, options?: { name?: string; exact?: boolean }) => options?.name === 'italiana'
        ? rawOption
        : options?.name === 'italienne'
          ? { first: () => localizedOption }
          : { allInnerTexts: vi.fn(async () => ['Italie', 'italienne']) }),
    };
    const page = { frames: () => [frame], mainFrame: () => frame };
    const result = await applyActions(page as any, [{
      id: 'nationality',
      kind: 'combobox',
      label: '* Nationalité',
      selectLike: false,
    }], [{ fieldId: 'nationality', action: 'select', value: 'italiana' }], {}, { pause: async () => {} });

    expect(result).toEqual([{ fieldId: 'nationality', ok: true }]);
    expect(localizedOption.click).toHaveBeenCalledWith({ timeout: 6000 });
  });

  it('retries a generic nationality combobox with the form-language prefix', async () => {
    let typed = '';
    let selected = '';
    const localizedOption = {
      waitFor: vi.fn(async () => {}),
      click: vi.fn(async () => { selected = 'Italien'; }),
    };
    const rawOption = { first: () => ({ waitFor: vi.fn(async () => { throw new Error('not found'); }) }) };
    const control = {
      click: vi.fn(),
      press: vi.fn(async () => {}),
      pressSequentially: vi.fn(async (value: string) => { typed = value; }),
      evaluate: vi.fn(async (_read: unknown, data: { wanted: string }) => selected.toLowerCase() === data.wanted),
    };
    const frame = {
      locator: vi.fn(() => ({ first: () => control })),
      getByRole: vi.fn((_role: string, options?: { name?: string; exact?: boolean }) => options?.name === 'italiana'
        ? rawOption
        : options?.name === 'Italien'
          ? { first: () => localizedOption }
          : { allInnerTexts: vi.fn(async () => typed === 'ital' ? ['Italien'] : []) }),
    };
    const page = { frames: () => [frame], mainFrame: () => frame, waitForTimeout: vi.fn(async () => {}) };
    const result = await applyActions(page as any, [{
      id: 'nationality',
      kind: 'combobox',
      label: '* Nationalité',
      selectLike: false,
    }], [{ fieldId: 'nationality', action: 'select', value: 'italiana' }], {}, { pause: async () => {} });

    expect(result).toEqual([{ fieldId: 'nationality', ok: true }]);
    expect(control.pressSequentially).toHaveBeenNthCalledWith(2, 'ital', expect.objectContaining({ timeout: 6000 }));
    expect(localizedOption.click).toHaveBeenCalledWith({ timeout: 6000 });
  });

  it('keeps the original DOM index when a SuccessFactors picklist has a blank option', async () => {
    let selected = '';
    const clicked: number[] = [];
    const control = {
      click: vi.fn(),
      press: vi.fn(),
      evaluate: vi.fn(async (_read: unknown, data: { wanted: string }) => selected.toLowerCase() === data.wanted),
    };
    const options = {
      first: () => ({ waitFor: vi.fn(async () => {}) }),
      allInnerTexts: vi.fn(async () => ['', 'italienne']),
      nth: (index: number) => ({ click: vi.fn(async () => { clicked.push(index); selected = 'italienne'; }) }),
    };
    const list = { getByRole: vi.fn(() => options) };
    const frame = {
      locator: vi.fn((selector: string) => selector.includes('data-aa-id') ? { first: () => control } : list),
    };
    const page = {
      frames: () => [frame],
      mainFrame: () => frame,
      waitForTimeout: vi.fn(async () => {}),
    };
    const result = await applyActions(page as any, [{
      id: 'nationality',
      kind: 'combobox',
      label: '* Nationalité',
      selectLike: true,
      ownedList: 'nationality_list',
    }], [{ fieldId: 'nationality', action: 'select', value: 'italiana' }], {}, { pause: async () => {} });

    expect(result).toEqual([{ fieldId: 'nationality', ok: true }]);
    expect(clicked).toEqual([1]);
  });

  it('filters a SuccessFactors nationality list when the first page lacks the localized label', async () => {
    let typed = '';
    let selected = '';
    const clicked: number[] = [];
    const control = {
      click: vi.fn(),
      press: vi.fn().mockResolvedValue(undefined),
      pressSequentially: vi.fn(async (value: string) => { typed = value; }),
      evaluate: vi.fn(async (_read: unknown, data: { wanted: string }) => selected.toLowerCase() === data.wanted),
    };
    const options = {
      first: () => ({ waitFor: vi.fn(async () => {}) }),
      allInnerTexts: vi.fn(async () => typed ? ['', 'italienne'] : ['', 'allemande']),
      nth: (index: number) => ({ click: vi.fn(async () => { clicked.push(index); selected = 'italienne'; }) }),
    };
    const list = { getByRole: vi.fn(() => options) };
    const frame = {
      locator: vi.fn((selector: string) => selector.includes('data-aa-id') ? { first: () => control } : list),
    };
    const page = {
      frames: () => [frame],
      mainFrame: () => frame,
      waitForTimeout: vi.fn(async () => {}),
    };
    const result = await applyActions(page as any, [{
      id: 'nationality',
      kind: 'combobox',
      label: '* Nationalité',
      selectLike: true,
      ownedList: 'nationality_list',
    }], [{ fieldId: 'nationality', action: 'select', value: 'italiana' }], {}, { pause: async () => {} });

    expect(result).toEqual([{ fieldId: 'nationality', ok: true }]);
    expect(typed).toBe('ital');
    expect(clicked).toEqual([1]);
  });

  it('types the nationality prefix when the SuccessFactors list starts empty', async () => {
    let typed = '';
    let selected = '';
    const clicked: number[] = [];
    const control = {
      click: vi.fn(),
      press: vi.fn().mockResolvedValue(undefined),
      pressSequentially: vi.fn(async (value: string) => { typed = value; }),
      evaluate: vi.fn(async (_read: unknown, data: { wanted: string }) => selected.toLowerCase() === data.wanted),
    };
    const options = {
      first: () => ({ waitFor: vi.fn(async () => { if (!typed) throw new Error('list_empty_until_search'); }) }),
      allInnerTexts: vi.fn(async () => typed === 'ital' ? ['', 'Italien'] : []),
      nth: (index: number) => ({ click: vi.fn(async () => { clicked.push(index); selected = 'Italien'; }) }),
    };
    const list = { getByRole: vi.fn(() => options) };
    const frame = {
      locator: vi.fn((selector: string) => selector.includes('data-aa-id') ? { first: () => control } : list),
    };
    const page = {
      frames: () => [frame],
      mainFrame: () => frame,
      waitForTimeout: vi.fn(async () => {}),
    };
    const result = await applyActions(page as any, [{
      id: 'nationality',
      kind: 'combobox',
      label: '* Nationalité',
      selectLike: true,
      ownedList: 'nationality_list',
    }], [{ fieldId: 'nationality', action: 'select', value: 'italiana' }], {}, { pause: async () => {} });

    expect(result).toEqual([{ fieldId: 'nationality', ok: true }]);
    expect(typed).toBe('ital');
    expect(clicked).toEqual([1]);
  });

  it('uses the canonical localized catalogue label and waits for an async filtered page', async () => {
    let typed = '';
    let filteredReads = 0;
    let selected = '';
    const clicked: number[] = [];
    const control = {
      click: vi.fn(),
      press: vi.fn().mockResolvedValue(undefined),
      pressSequentially: vi.fn(async (value: string) => { typed = value; }),
      evaluate: vi.fn(async (_read: unknown, data: { wanted: string }) => selected.toLowerCase() === data.wanted),
    };
    const options = {
      first: () => ({ waitFor: vi.fn(async () => {}) }),
      allInnerTexts: vi.fn(async () => {
        if (!typed) return ['autrichienne'];
        filteredReads += 1;
        return filteredReads < 3 ? ['autrichienne'] : ['', 'allemande'];
      }),
      nth: (index: number) => ({ click: vi.fn(async () => { clicked.push(index); selected = 'allemande'; }) }),
    };
    const list = { getByRole: vi.fn(() => options) };
    const frame = {
      locator: vi.fn((selector: string) => selector.includes('data-aa-id') ? { first: () => control } : list),
    };
    const page = {
      frames: () => [frame],
      mainFrame: () => frame,
      waitForTimeout: vi.fn(async () => {}),
    };
    const result = await applyActions(page as any, [{
      id: 'nationality',
      kind: 'combobox',
      label: '* Nationalité',
      selectLike: true,
      ownedList: 'nationality_list',
    }], [{ fieldId: 'nationality', action: 'select', value: 'tedesca' }], {}, { pause: async () => {} });

    expect(result).toEqual([{ fieldId: 'nationality', ok: true }]);
    expect(typed).toBe('alle');
    expect(filteredReads).toBeGreaterThanOrEqual(3);
    expect(clicked).toEqual([1]);
  });

  it('drops invented sensitive answers and turns the required ones into questions', () => {
    const guarded = guardPlan({
      actions: [
        { fieldId: 'f1', action: 'fill', value: 'Luca', document: 'none', source: 'identity' },
        { fieldId: 'f2', action: 'select', value: 'G', document: 'none', source: 'rule' },
        { fieldId: 'f3', action: 'fill', value: 'CHF 90k', document: 'none', source: 'rule' },
        { fieldId: 'f4', action: 'select', value: 'Germany', document: 'none', source: 'profile' },
        { fieldId: 'f5', action: 'upload', value: '', document: 'cv', source: 'documents' },
        { fieldId: 'ghost', action: 'fill', value: 'x', document: 'none', source: 'identity' },
      ],
      missingRequired: [],
    }, fields);
    expect(guarded.actions.map((action) => action.fieldId)).toEqual(['f1', 'f5']);
    // The country the plan got wrong is not left blank either: it is asked too.
    expect(guarded.missingRequired).toEqual([
      expect.objectContaining({ fieldId: 'f2', type: 'choice', options: ['G', 'B'] }),
      expect.objectContaining({ fieldId: 'f4', question: 'Country', type: 'choice', options: ['Switzerland', 'Italy'] }),
    ]);
  });

  it('keeps sensitive answers that come from the candidate', () => {
    const guarded = guardPlan({ actions: [{ fieldId: 'f2', action: 'select', value: 'G', document: 'none', source: 'answers' }], missingRequired: [] }, fields);
    expect(guarded.actions).toHaveLength(1);
    // Only the required fields this partial plan leaves out are asked.
    expect(guarded.missingRequired.map((item) => item.fieldId)).toEqual(['f1', 'f4', 'f5']);
  });

  it('lets a required demographic question be declined, and checks values against the candidate data', () => {
    const gender = { id: 'g1', kind: 'select', label: 'Geschlecht* (erforderlich)', required: true, options: [{ label: 'Männlich' }, { label: 'Weiblich' }, { label: 'Keine Angabe' }] };
    const declined = guardPlan({ actions: [{ fieldId: 'g1', action: 'select', value: 'Keine Angabe', document: 'none', source: 'rule' }], missingRequired: [] }, [gender]);
    expect(declined).toEqual({ actions: [expect.objectContaining({ value: 'Keine Angabe' })], missingRequired: [] });
    // "profile" claimed as the source, but the value is nowhere in the candidate's data.
    const invented = guardPlan(
      { actions: [{ fieldId: 'g1', action: 'select', value: 'Weiblich', document: 'none', source: 'profile' }], missingRequired: [] },
      [gender],
      { answers: {}, profile: { headline: 'Infermiera' }, portalQuestionsAnswered: [] },
    );
    expect(invented.actions).toEqual([]);
    expect(invented.missingRequired).toEqual([expect.objectContaining({ fieldId: 'g1', question: 'Geschlecht', options: ['Männlich', 'Weiblich', 'Keine Angabe'] })]);
    expect(questionFromLabel('Do you have a working permit?*')).toBe('Do you have a working permit?');
  });

  // Giro di prova 2026-10-01: JOIN asks "Che sesso sei?" with an "N/A" option.
  it('reads "sesso" as a demographic question that only "N/A" may answer by rule', () => {
    const sex = { id: 's1', kind: 'select', label: 'Che sesso sei?', required: true, options: [{ label: 'Maschio' }, { label: 'Femmina' }, { label: 'N/A' }] };
    const candidate = { answers: {}, profile: {}, portalQuestionsAnswered: [] };
    const declined = guardPlan({ actions: [{ fieldId: 's1', action: 'select', value: 'N/A', document: 'none', source: 'rule' }], missingRequired: [] }, [sex], candidate);
    expect(declined.actions).toHaveLength(1);
    const guessed = guardPlan({ actions: [{ fieldId: 's1', action: 'select', value: 'Maschio', document: 'none', source: 'rule' }], missingRequired: [] }, [sex], candidate);
    expect(guessed.actions).toEqual([]);
    expect(guessed.missingRequired.map((item: any) => item.fieldId)).toEqual(['s1']);
  });

  it('never takes an empty answer as the candidate’s: a required field stays a question', () => {
    const fields = [
      { id: 'f1', kind: 'text', label: 'Nationality', required: true },
      { id: 'f2', kind: 'text', label: 'Stadt', required: true },
      { id: 'f3', kind: 'text', label: 'Zweiter Vorname', required: false },
    ];
    const candidate = { answers: {}, profile: { nationality: '', city: '' }, portalQuestionsAnswered: [] };
    const plan = {
      actions: [
        { fieldId: 'f1', action: 'fill', source: 'profile', value: '' },
        { fieldId: 'f2', action: 'fill', source: 'profile', value: '  ' },
        { fieldId: 'f3', action: 'fill', source: 'rule', value: '' },
      ],
      missingRequired: [],
    };
    const guarded = guardPlan(plan, fields, candidate);
    expect(guarded.actions).toEqual([]);
    expect(guarded.missingRequired.map((item: any) => item.fieldId)).toEqual(['f1', 'f2']);
    expect(guarded.missingRequired[0]).toMatchObject({ question: 'Nationality', type: 'text' });
  });

  it('turns a required field the plan skips or omits into a question, unless the page already holds a value', () => {
    const fields = [
      { id: 'f1', kind: 'text', label: 'Nationality', required: true, value: '' },
      { id: 'f2', kind: 'text', label: 'Telefon', required: true, value: '' },
      { id: 'f3', kind: 'text', label: 'E-Mail', required: true, value: 'c-abcdefghjk@candidature.frontaliereticino.ch' },
      { id: 'f4', kind: 'listbox', label: 'Land', required: true, value: 'Select One' },
      { id: 'f5', kind: 'select', label: 'Anrede', required: true, value: '-1', options: [{ value: '-1', label: 'Bitte wählen' }, { value: 'f', label: 'Frau' }] },
      { id: 'f6', kind: 'checkbox', label: 'Datenschutz', required: true, checked: false },
      { id: 'f7', kind: 'text', label: 'Zweiter Vorname', required: false, value: '' },
    ];
    const plan = {
      actions: [
        { fieldId: 'f1', action: 'skip', source: 'rule', value: '' },
        { fieldId: 'f3', action: 'skip', source: 'rule', value: '' },
        { fieldId: 'f4', action: 'skip', source: 'rule', value: '' },
        { fieldId: 'f6', action: 'check', source: 'consent', value: '' },
      ],
      missingRequired: [],
    };
    const guarded = guardPlan(plan, fields, { answers: {}, profile: {}, portalQuestionsAnswered: [] });
    expect(guarded.missingRequired.map((item: any) => item.fieldId)).toEqual(['f1', 'f2', 'f4', 'f5']);
    expect(guarded.actions).toEqual([
      { fieldId: 'f3', action: 'skip', source: 'rule', value: '' },
      { fieldId: 'f6', action: 'check', source: 'consent', value: '' },
    ]);
    // What the page holds after the action counts: a dropdown set to its prompt, a required box unticked.
    const projected = guardPlan({
      actions: [
        { fieldId: 'p1', action: 'select', source: 'profile', value: 'Select One' },
        { fieldId: 'p2', action: 'uncheck', source: 'consent', value: '' },
        { fieldId: 'p3', action: 'uncheck', source: 'consent', value: '' },
      ],
      missingRequired: [],
    }, [
      { id: 'p1', kind: 'select', label: 'Country', required: true, value: '', options: [{ value: '', label: 'Select One' }, { value: 'ch', label: 'Switzerland' }] },
      { id: 'p2', kind: 'checkbox', label: 'Datenschutz', required: true, checked: true },
      { id: 'p3', kind: 'checkbox', label: 'Newsletter', required: false, checked: true },
    ], { answers: {}, profile: {}, portalQuestionsAnswered: [] });
    expect(projected.actions).toEqual([{ fieldId: 'p3', action: 'uncheck', source: 'consent', value: '' }]);
    expect(projected.missingRequired.map((item: any) => item.fieldId)).toEqual(['p1', 'p2']);
    expect(holdsValue({ kind: 'select', value: 'f', options: [{ value: 'f', label: 'Frau' }] })).toBe(true);
    expect(holdsValue({ kind: 'listbox', value: 'Italien' })).toBe(true);
    expect(holdsValue({ kind: 'text', value: '-- Seleziona --' })).toBe(false);
    expect(holdsValue({ kind: 'combobox', value: 'Aucune sélection' })).toBe(false);
    expect(holdsValue({ kind: 'file', value: '' })).toBe(false);
  });

  it('ticks the application’s own required consent in code when the plan leaves it, and nothing else', () => {
    const candidate = { answers: {}, profile: {}, portalQuestionsAnswered: [] };
    const fields = [
      { id: 'c1', kind: 'checkbox', label: 'I agree to the Privacy Policy Statement', required: true, checked: false },
      { id: 'c2', kind: 'checkbox', label: 'Newsletter gemäss Datenschutzerklärung abonnieren', required: true, checked: false },
      { id: 'c3', kind: 'checkbox', label: 'I hold a valid work permit and accept the privacy policy', required: true, checked: false },
      { id: 'c4', kind: 'checkbox', label: 'Datenschutzerklärung gelesen', required: false, checked: false },
      { id: 'c5', kind: 'checkbox', label: 'Ho letto l’informativa privacy e acconsento al trattamento dei dati', required: true, checked: false },
      // Ticino Rexx omits the HTML `required` attribute even though its
      // server rejects the application until this agreement is checked.
      { id: 'c6', kind: 'checkbox', label: 'Accetto la memorizzazione elettronica dei miei dati ai sensi delle disposizioni in materia di protezione dei dati.', required: false, checked: false },
    ];
    // umantis, 2026-10-03: the planner skipped the required privacy box, and the candidate was asked it as a text question.
    const guarded = guardPlan({
      actions: [{ fieldId: 'c1', action: 'skip', source: 'rule', value: '' }, { fieldId: 'c5', action: 'uncheck', source: 'rule', value: '' }],
      missingRequired: [{ fieldId: 'c1', question: 'Accetti l’informativa?', why: '', type: 'yes_no', options: [] }],
    }, fields, candidate);
    expect(guarded.actions.filter((action: any) => action.action === 'check').map((action: any) => [action.fieldId, action.source])).toEqual([['c1', 'consent'], ['c5', 'consent'], ['c6', 'consent']]);
    // A required marketing box and one that also declares a fact stay questions; an optional box is left alone.
    expect(guarded.missingRequired.map((item: any) => item.fieldId).sort()).toEqual(['c2', 'c3']);
    expect(ownConsent(fields[3])).toBe(false);
    expect(ownConsent({ kind: 'text', label: 'Privacy', required: true })).toBe(false);
    expect(ownConsent({ kind: 'checkbox', label: 'I do not accept the privacy policy', required: false, checked: false })).toBe(false);
    expect(ownConsent({ kind: 'checkbox', label: 'I cannot accept the privacy policy', required: false, checked: false })).toBe(false);
    expect(ownConsent({ kind: 'checkbox', label: 'I will not accept the privacy policy', required: false, checked: false })).toBe(false);
    // The choice on what happens to the data afterwards is the planner's, by rule: never kept for other openings.
    expect(planSystemPrompt('it')).toContain('select the option that deletes it');
    expect(ownConsent({ kind: 'checkbox', name: 'agbs_check', label: '', required: false })).toBe(true);
    expect(ownConsent({ kind: 'checkbox', name: 'privacy_marketing', label: '', required: false })).toBe(false);
  });

  it('never sends an ongoing or partial CV period to a calendar field', () => {
    const dateField = { id: 'past-end', kind: 'text', label: 'al (GG.MM.AAAA)', required: true };
    const candidate = candidateForForm({
      identity: { name: 'Test Candidate', email: 'test@example.com', phone: '' },
      profile: { experience: [{ start: '2015', end: 'ad oggi' }] },
    });
    expect(candidate.profile.experience[0].end).toBe('ad oggi');
    const invalid = guardPlan({ actions: [{ fieldId: 'past-end', action: 'fill', value: 'ad oggi', source: 'profile' }], missingRequired: [] }, [dateField], candidate);
    expect(invalid.actions).toEqual([]);
    expect(invalid.missingRequired.map((item: any) => item.fieldId)).toEqual(['past-end']);
    const corrected = guardPlan({ actions: [{ fieldId: 'past-end', action: 'fill', value: '2024-08-31', source: 'profile' }], missingRequired: [] }, [dateField], candidate);
    expect(corrected.actions[0]).toMatchObject({ fieldId: 'past-end', value: '31.08.2024' });
    expect(corrected.missingRequired).toEqual([]);
  });

  it('preserves the advertised date separator and ignores section-only date labels', () => {
    expect(normalizeDateAnswer({ kind: 'text', datePattern: 'dd/mm/yyyy' }, '15/03/2020')).toBe('15/03/2020');
    expect(normalizeDateAnswer({ kind: 'text', datePattern: 'mm-dd-yyyy' }, '15/03/2020')).toBe('03-15-2020');
    expect(isDateField({ kind: 'text', label: 'First name', context: 'First name · Date of birth' })).toBe(false);
    expect(isDateField({ kind: 'text', label: 'Data source' })).toBe(false);
    expect(isDateField({ kind: 'text', label: 'Data' })).toBe(true);
  });

  it('fails closed when a legacy consent check is reported as a rule action', () => {
    expect(failedConsentRequiresHandoff(
      { ok: false, error: 'choice_not_registered' },
      { action: 'check', source: 'rule' },
      { kind: 'checkbox', name: 'agbs_check', label: '', required: false },
    )).toBe(true);
    expect(failedConsentRequiresHandoff(
      { ok: false, error: 'choice_not_registered' },
      { action: 'check', source: 'rule' },
      { kind: 'checkbox', name: 'privacy_marketing', label: '', required: false },
    )).toBe(false);
  });

  it('maps an explicitly ongoing CV experience to the current employment option', () => {
    const field = {
      id: 'employment',
      kind: 'select',
      label: 'Situazione lavorativa attuale *',
      required: true,
      options: [{ label: 'Disoccupato' }, { label: 'Occupato' }],
    };
    const candidate = { answers: {}, profile: { experience: [{ role: 'Impiegata', employer: 'Comune', end: 'ad oggi' }] }, portalQuestionsAnswered: [] };
    expect(currentEmploymentOption(field, candidate)).toEqual({ label: 'Occupato' });
    expect(currentEmploymentOption({ ...field, label: 'Situazione occupazionale' }, candidate)).toEqual({ label: 'Occupato' });
    expect(guardPlan({ actions: [], missingRequired: [{ fieldId: 'employment', question: 'Situazione lavorativa attuale', why: '', type: 'choice', options: ['Disoccupato', 'Occupato'] }] }, [field], candidate)).toEqual({
      actions: [{ fieldId: 'employment', action: 'select', value: 'Occupato', document: 'none', source: 'profile', evidence: '' }],
      missingRequired: [],
    });
    // A past or undated last job does not justify choosing "employed".
    const ended = { answers: {}, profile: { experience: [{ role: 'Impiegata', employer: 'Comune', end: '31/12/2024' }] }, portalQuestionsAnswered: [] };
    expect(currentEmploymentOption(field, ended)).toBeNull();
    expect(guardPlan({ actions: [], missingRequired: [] }, [field], ended).missingRequired.map((item: any) => item.fieldId)).toEqual(['employment']);
  });

  it('derives a native language from the CV language only with contrasting language evidence', () => {
    const candidate = candidateForForm({
      identity: { name: 'Test Candidate', email: 'test@example.com' },
      profile: {
        cvLanguage: 'it',
        languages: [
          { language: 'Inglese', level: 'Buona conoscenza' },
          { language: 'Francese', level: 'Buona conoscenza' },
        ],
      },
    });
    const field = {
      id: 'italian-spoken', kind: 'select', label: 'Qual è il livello di italiano parlato *', required: true,
      options: [{ label: '---' }, { label: 'Lingua madre' }, { label: 'Fluente' }, { label: 'Avanzato' }],
    };
    expect(candidate.profile.cvLanguage).toBe('it');
    expect([...inferredNativeLanguageCodes(candidate)]).toEqual(['it']);
    expect(nativeLanguageOption(field, candidate)).toEqual({ label: 'Lingua madre' });
    expect(candidateAnswerForField(candidate, field)).toEqual({ value: 'Lingua madre', source: 'profile' });
    // A model answer that undershoots the supported fact is replaced by the deterministic guard.
    expect(guardPlan({ actions: [{ fieldId: field.id, action: 'select', value: 'Fluente', source: 'rule' }], missingRequired: [] }, [field], candidate)).toEqual({
      actions: [{ fieldId: field.id, action: 'select', value: 'Lingua madre', document: 'none', source: 'profile', evidence: '' }],
      missingRequired: [],
    });

    const noContrastingEvidence = candidateForForm({
      identity: { name: 'Test Candidate', email: 'test@example.com' },
      profile: { cvLanguage: 'en', languages: [] },
    });
    expect(nativeLanguageOption({ ...field, label: 'What is your level of English?', options: [{ label: 'Mother tongue' }] }, noContrastingEvidence)).toBeNull();

    const conflictingLevel = candidateForForm({
      identity: { name: 'Test Candidate', email: 'test@example.com' },
      profile: { cvLanguage: 'it', languages: [{ language: 'Italiano', level: 'C1' }, { language: 'English', level: 'B2' }] },
    });
    expect(nativeLanguageOption(field, conflictingLevel)).toBeNull();
    expect(planSystemPrompt('it')).toContain('profile.cvLanguage');
  });

  // umantis, 2026-10-03: the letter was still at 15% when the CV went in and the send button was reached.
  it('waits for upload requests, fails on an HTTP error, and removes its listeners', async () => {
    const run = async (requests: Array<{ at: number; until: number; method?: string; status?: number; upload?: boolean; failAfterResponse?: boolean }>) => {
      let clock = 0;
      const handlers: Record<string, Set<(request: any) => void>> = { request: new Set(), requestfinished: new Set(), requestfailed: new Set(), response: new Set() };
      const live = requests.map((item) => ({ ...item, method: () => item.method || 'POST', headers: () => ({ 'content-type': item.upload === false ? 'application/json' : 'multipart/form-data; boundary=test' }), started: false, ended: false }));
      const page = {
        on: (event: string, handler: any) => handlers[event].add(handler),
        off: (event: string, handler: any) => handlers[event].delete(handler),
        waitForTimeout: async (ms: number) => {
          clock += ms;
          for (const request of live) {
            if (!request.started && clock >= request.at) {
              request.started = true;
              handlers.request.forEach((handler) => handler(request));
              if (request.status) handlers.response.forEach((handler) => handler({ request: () => request, status: () => request.status }));
              if (request.failAfterResponse) handlers.requestfailed.forEach((handler) => handler(request));
            }
            if (request.started && !request.ended && clock >= request.until) { request.ended = true; handlers.requestfinished.forEach((handler) => handler(request)); }
          }
        },
      };
      const chosen: any[] = [];
      let inputTimeout = 0;
      const receipt = await chooseFiles(page as any, { setInputFiles: async (paths: any, options: any) => { chosen.push(paths); inputTimeout = options.timeout; } } as any, '/tmp/cv.pdf', { now: () => clock });
      return { clock, chosen, inputTimeout, accepted: receipt.accepted, listeners: Object.values(handlers).reduce((sum, set) => sum + set.size, 0) };
    };
    // Nothing leaves on the choice (the file goes with the submit): the quiet moment only, and no listener left.
    const plain = await run([]);
    expect(plain.chosen).toEqual(['/tmp/cv.pdf']);
    expect(plain.inputTimeout).toBe(30_000);
    expect(plain.accepted).toBe(false);
    expect(plain.clock).toBeGreaterThanOrEqual(700);
    expect(plain.clock).toBeLessThan(1200);
    expect(plain.listeners).toBe(0);
    // An upload that starts at once and takes 5 s is waited for.
    const upload = await run([{ at: 150, until: 5000 }]);
    expect(upload.clock).toBeGreaterThanOrEqual(5700);
    expect(upload.clock).toBeLessThan(6500);
    expect((await run([{ at: 150, until: 500, status: 204 }])).accepted).toBe(true);
    expect((await run([{ at: 150, until: 500, status: 204, failAfterResponse: true }])).accepted).toBe(true);
    // Sent in two pieces with a short gap: both.
    expect((await run([{ at: 150, until: 2000 }, { at: 2300, until: 4000 }])).clock).toBeGreaterThanOrEqual(4600);
    // A plain GET (an image, a script) is nobody's upload; a request that never ends is not waited for ever.
    expect((await run([{ at: 150, until: 9000, method: 'GET' }])).clock).toBeLessThan(1200);
    const stuck = await run([{ at: 150, until: Infinity }]);
    expect(stuck.clock).toBeGreaterThanOrEqual(45_000);
    expect(stuck.clock).toBeLessThan(47_000);
    const failed = await run([{ at: 150, until: 500, status: 500 }]).then(() => false, (error) => error.message === 'upload_http_failed');
    expect(failed).toBe(true);
    expect((await run([{ at: 150, until: 500, status: 500, upload: false }])).accepted).toBe(false);
  });

  // The record of what left (submit.mjs `sent`) names the files a form's field received.
  it('says how many files of a requested document an upload set: all of them in a multiple input, else the first', async () => {
    const chosen: unknown[] = [];
    const selectedByField = new Map<string, string[]>();
    const page = (multiple: boolean) => {
      const input = {
        first: () => input,
        evaluate: async (read: (element: { multiple: boolean }) => boolean) => read({ multiple }),
        setInputFiles: async (paths: unknown) => { chosen.push(paths); },
      };
      const frame = { locator: () => input };
      return { frames: () => [frame], mainFrame: () => frame, on: () => {}, off: () => {}, waitForTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) };
    };
    const fields = [{ id: 'f9', kind: 'file', label: 'Zeugnisse', required: false }];
    const files = { cv: '/tmp/cv.pdf', cover_letter: '/tmp/letter.pdf', extra_1: ['/tmp/zeugnis-1.pdf', '/tmp/zeugnis-2.jpg'] };
    const upload = (document: string) => [{ fieldId: 'f9', action: 'upload', value: '', document }];
    const pause = async () => {};
    expect(await applyActions(page(true) as any, fields, upload('extra_1'), files, { pause, onUploadSelection: (fieldId, paths) => selectedByField.set(fieldId, paths) })).toEqual([{ fieldId: 'f9', ok: true, files: 2 }]);
    expect(chosen.at(-1)).toEqual(['/tmp/zeugnis-1.pdf', '/tmp/zeugnis-2.jpg']);
    expect(selectedByField.get('f9')).toEqual(['/tmp/zeugnis-1.pdf', '/tmp/zeugnis-2.jpg']);
    expect(await applyActions(page(false) as any, fields, upload('extra_1'), files, { pause, onUploadSelection: (fieldId, paths) => selectedByField.set(fieldId, paths) })).toEqual([{ fieldId: 'f9', ok: true, files: 1 }]);
    expect(chosen.at(-1)).toBe('/tmp/zeugnis-1.pdf');
    expect(selectedByField.get('f9')).toEqual(['/tmp/zeugnis-1.pdf']);
    const inputWithOneAcceptedFile = { evaluate: async () => ['zeugnis-1.pdf'] };
    const workday = {
      url: () => 'https://acme.wd1.myworkdayjobs.com/apply',
      locator: () => ({ allInnerTexts: async () => [] }),
      getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
      waitForTimeout: async () => {},
    };
    expect(await uploadReceipt(workday as any, inputWithOneAcceptedFile as any, selectedByField.get('f9')!, { acceptedResponse: true, timeoutMs: 0 })).toBe(true);
    expect(await uploadReceipt(workday as any, inputWithOneAcceptedFile as any, files.extra_1, { acceptedResponse: true, timeoutMs: 0 })).toBe(false);
    expect(await applyActions(page(false) as any, fields, upload('cv'), files, { pause })).toEqual([{ fieldId: 'f9', ok: true, files: 1 }]);
    // A document that is not there sets nothing.
    expect(await applyActions(page(true) as any, fields, upload('extra_2'), files, { pause })).toEqual([{ fieldId: 'f9', ok: false, error: 'document_unavailable' }]);
  }, 15_000);

  it('plans a JOIN date picker from the candidate date and asks when it is absent', () => {
    const date = { id: 'dob', kind: 'date', label: 'Quando sei nato?', required: true, value: '' };
    const candidate = { answers: {}, profile: { dateOfBirth: '12.05.1990' }, portalQuestionsAnswered: [] };
    const filled = guardPlan({ actions: [{ fieldId: 'dob', action: 'fill', value: '1990-05-12', source: 'profile' }], missingRequired: [] }, [date], candidate);
    expect(filled).toEqual({ actions: [expect.objectContaining({ fieldId: 'dob', action: 'fill', value: '1990-05-12' })], missingRequired: [] });
    expect(holdsValue({ ...date, value: '1990-05-12' })).toBe(true);

    const missing = guardPlan({ actions: [], missingRequired: [] }, [date], { answers: {}, profile: {}, portalQuestionsAnswered: [] });
    expect(missing.missingRequired).toEqual([expect.objectContaining({ fieldId: 'dob', type: 'date', question: 'Quando sei nato?' })]);
  });

  it('asks each missing field once and never a field the plan already answers', () => {
    const guarded = guardPlan({
      actions: [{ fieldId: 'f1', action: 'fill', value: 'Luca', document: 'none', source: 'identity' }],
      missingRequired: [
        { fieldId: 'f2', question: 'Permesso?', why: '', type: 'choice', options: ['G', 'B'] },
        { fieldId: 'f2', question: 'Permesso di lavoro?', why: '', type: 'choice', options: ['G', 'B'] },
        { fieldId: 'f1', question: 'Nome?', why: '', type: 'text', options: [] },
      ],
    }, fields);
    expect(guarded.missingRequired.map((item) => item.fieldId)).toEqual(['f2', 'f4', 'f5']);
    expect(guarded.missingRequired[0].question).toBe('Permesso?');
    // A field the plan skips and also lists as missing is still asked, with the plan's question.
    const skipped = guardPlan({
      actions: [{ fieldId: 'f4', action: 'skip', value: '', document: 'none', source: 'identity' }],
      missingRequired: [{ fieldId: 'f4', question: 'In quale Paese vivi?', why: '', type: 'choice', options: ['Switzerland', 'Italy'] }],
    }, fields);
    expect(skipped.missingRequired.filter((item) => item.fieldId === 'f4')).toEqual([expect.objectContaining({ question: 'In quale Paese vivi?' })]);
    expect(skipped.actions).toEqual([]);
  });

  it('asks the questions in the candidate’s language and uses a strict schema', () => {
    expect(planSystemPrompt('de')).toContain('written in German for the candidate');
    expect(PLAN_SCHEMA.additionalProperties).toBe(false);
    expect(PLAN_SCHEMA.required).toEqual(['actions', 'missingRequired']);
  });
});

describe('portal runner helpers', () => {
  it('reuses renamed portal answers and maps a known current institution to Other', () => {
    const candidate = candidateForForm({
      identity: { name: 'Maria Rossi', email: 'c-abcdefghjk@candidature.frontaliereticino.ch', phone: '' },
      profile: { currentEducation: { institution: 'UNIVERSITÉ ECAMPUS' } },
      answers: { portal_qual_e_la_tua_via_e_il_numero_civico: 'Via Test 1' },
      portalQuestions: [
        { id: 'portal_qual_e_la_tua_via_e_il_numero_civico', question: 'Qual è la tua via e il numero civico?' },
        { id: 'portal_qual_e_la_via_e_il_numero_civico', question: 'Qual è la via e il numero civico?' },
      ],
    });
    const address = { id: 'address', kind: 'text', label: 'Qual è la via e il numero civico?', required: true };
    const school = { id: 'school', kind: 'select', label: 'In quale scuola sei attualmente?', required: true, options: [{ label: 'Ecole de Commerce' }, { label: 'Autre' }] };
    expect(questionTopic('Qual è la tua via e il numero civico?')).toBe('address');
    expect(questionTopic('Qual è il tuo CAP di residenza?')).toBe('residence_postal_code');
    expect(questionTopic('CAP')).toBe('');
    expect(questionTopic('CAP (obbligatorio)')).toBe('');
    expect(questionTopic('CAP', 'Indirizzo di residenza')).toBe('residence_postal_code');
    expect(questionTopic('CAP (obbligatorio)', 'Domicilio')).toBe('residence_postal_code');
    expect(questionTopic('CAP', 'Dati anagrafici · Indirizzo · CAP')).toBe('residence_postal_code');
    expect(questionTopic('CAP', 'Dati anagrafici · Data di nascita · Indirizzo · CAP · Nazione (di residenza)')).toBe('residence_postal_code');
    expect(questionTopic('CAP', 'Employer address')).toBe('');
    expect(questionTopic('CAP', 'Datore di lavoro · CAP')).toBe('');
    expect(questionTopic('CAP', 'Residenza / azienda · CAP')).toBe('');
    expect(questionTopic('Employer CAP')).toBe('');
    expect(questionTopic('Qual è il tuo codice postale?')).toBe('');
    expect(questionTopic('Qual è la tua nazione di residenza?')).toBe('residence_country');
    expect(questionTopic('Employer country')).toBe('');
    expect(questionTopic('Work city')).toBe('');
    expect(addressQuestionTopic('Country of birth')).toBe('');
    expect(addressQuestionTopic('City of birth')).toBe('');
    expect(addressQuestionTopic('Country of residence')).toBe('residence_country');
    expect(questionTopic('Street address')).toBe('address_street');
    expect(questionTopic('E-Mail-Adresse')).toBe('');
    expect(questionTopic('Email address')).toBe('');
    expect(questionTopic('Hausnummer')).toBe('address_house_number');
    expect(candidateAnswerForQuestion({ portalQuestionsAnswered: [{ question: 'Street address', answer: 'Via Roma' }] }, 'Hausnummer')).toBe('');
    expect(questionTopic('Which Swiss work permit do you hold?')).toBe('permit');
    expect(questionTopic('Will you need a work permit?')).toBe('');
    expect(questionTopic('In quale scuola sei attualmente?')).toBe('current_school');
    expect(questionTopic('What did you study?')).toBe('');
    expect(answeredByCandidate(candidate, address.label, 'Via Test 1')).toBe(true);
    expect(candidateAnswerForField(candidate, address)).toEqual({ value: 'Via Test 1', source: 'answers' });
    expect(candidateAnswerForField(candidate, school)).toEqual({ value: 'Autre', source: 'profile' });
    const savedSchool = candidateForForm({
      identity: { name: 'Maria Rossi', email: 'c-abcdefghjk@candidature.frontaliereticino.ch', phone: '' },
      profile: {},
      answers: { portal_in_quale_scuola_studi_attualmente: 'UNIVERSITÉ ECAMPUS' },
      portalQuestions: [{ id: 'portal_in_quale_scuola_studi_attualmente', question: 'In quale scuola studi attualmente?' }],
    });
    expect(candidateAnswerForField(savedSchool, school)).toEqual({ value: 'Autre', source: 'answers' });
    const guarded = guardPlan({ actions: [], missingRequired: [
      { fieldId: address.id, question: address.label, why: '', type: 'text', options: [] },
      { fieldId: school.id, question: school.label, why: '', type: 'choice', options: ['Ecole de Commerce', 'Autre'] },
    ] }, [address, school], candidate);
    expect(guarded.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldId: address.id, action: 'fill', value: 'Via Test 1', source: 'answers' }),
      expect.objectContaining({ fieldId: school.id, action: 'select', value: 'Autre', source: 'profile' }),
    ]));
    expect(guarded.missingRequired).toEqual([]);
  });

  it('resolves a locality and province into residence CAP and country answers', () => {
    const candidate = candidateForForm({
      identity: { name: 'Maria Rossi', email: 'c-abcdefghjk@candidature.frontaliereticino.ch', phone: '' },
      profile: {
        location: 'Salsomaggiore T. (PR)',
        address: { street: 'Via Test 1', postalCode: '', city: 'Salsomaggiore T. (PR)', country: 'Svizzera' },
      },
    });
    expect(candidate.identity.address).toMatchObject({ postalCode: '43039', country: 'Italia' });
    const cap = { id: 'cap', kind: 'text', label: 'Qual è il tuo CAP di residenza?', required: true, options: [] };
    const bareCap = { id: 'bare-cap', kind: 'text', label: 'CAP', context: 'Dati anagrafici · Indirizzo · CAP', required: true, options: [] };
    const workCap = { id: 'work-cap', kind: 'text', label: 'CAP', context: 'Employer address', required: true, options: [] };
    const country = { id: 'country', kind: 'select', label: 'Qual è la tua nazione di residenza?', required: true, options: [{ label: 'Italia' }, { label: 'Svizzera' }] };
    expect(candidateAnswerForField(candidate, cap)).toEqual({ value: '43039', source: 'identity' });
    expect(candidateAnswerForField(candidate, bareCap)).toEqual({ value: '43039', source: 'identity' });
    expect(autoAnswersForPortalQuestions({
      questions: [{ id: bareCap.id, source: 'portal', question: bareCap.label, context: bareCap.context, required: true, type: 'text', options: [] }],
      candidate,
      answers: {},
    })).toEqual({ 'bare-cap': '43039' });
    expect(candidateAnswerForField(candidate, workCap)).toBeNull();
    expect(candidateAnswerForField(candidate, country)).toEqual({ value: 'Italia', source: 'identity' });
    const guarded = guardPlan({ actions: [
      { fieldId: 'cap', action: 'fill', value: '00000', document: 'none', source: 'rule', evidence: '' },
      { fieldId: 'country', action: 'select', value: 'Svizzera', document: 'none', source: 'rule', evidence: '' },
    ], missingRequired: [] }, [cap, country], candidate);
    expect(guarded.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldId: 'cap', value: '43039', source: 'identity' }),
      expect.objectContaining({ fieldId: 'country', value: 'Italia', source: 'identity' }),
    ]));
    expect(guarded.missingRequired).toEqual([]);

    const unresolvedCap = { id: 'unresolved-cap', kind: 'text', label: 'CAP', context: 'Dati anagrafici · Data di nascita · Indirizzo · CAP · Nazione (di residenza)', required: true, options: [] };
    expect(guardPlan({ actions: [], missingRequired: [] }, [unresolvedCap], { answers: {}, profile: {}, portalQuestionsAnswered: [] }).missingRequired)
      .toEqual([expect.objectContaining({ fieldId: 'unresolved-cap', context: unresolvedCap.context })]);
  });

  it('keeps legacy profile address data and repeated e-mail fields answerable', () => {
    const candidate = {
      identity: { email: 'c-abcdefghjk@candidature.frontaliereticino.ch' },
      profile: {
        location: 'Lugano',
        address: { street: 'Via Esempio 1', postalCode: '6830', city: 'Lugano', country: 'Svizzera' },
      },
      answers: {},
      portalQuestionsAnswered: [],
    };
    const repeatEmail = { id: 'email-again', kind: 'text', label: 'E-Mail-Adresse erneut eingeben: *', required: true, options: [] };
    const street = { id: 'street-name', kind: 'text', label: 'Street Name', context: 'My Information', required: true, options: [] };
    const postcode = { id: 'postcode', kind: 'text', label: 'Postcode', context: 'My Information', required: true, options: [] };
    const country = { id: 'residence-country', kind: 'select', label: 'Land/Region des Wohnorts:*', required: true, options: [{ label: '- Bitte auswählen -' }, { label: 'Schweiz' }, { label: 'Italien' }] };
    expect(questionTopic('Postcode', 'My Information')).toBe('residence_postal_code');
    expect(questionTopic('Country', 'My Information / Country of birth')).toBe('');
    expect(questionTopic('Country Phone Code*', 'My Information')).toBe('');
    expect(questionTopic('Country code', 'My Information / Phone')).toBe('');
    expect(questionTopic('Country code', 'Phone, Address, CAP, Country')).toBe('');
    const flattenedPersonalContext = 'Dati anagrafici · Telefono fisso / Telefono privato · Telefono mobile / Cellulare * · Indirizzo * · CAP * · Località * · Nazione (di residenza) *';
    expect(questionTopic('Indirizzo', flattenedPersonalContext)).toBe('address_street');
    expect(questionTopic('CAP', flattenedPersonalContext)).toBe('residence_postal_code');
    expect(questionTopic('Nazione (di residenza)', flattenedPersonalContext)).toBe('residence_country');
    expect(candidateAnswerForField(candidate, { label: 'Indirizzo', context: flattenedPersonalContext, options: [] }))
      .toEqual({ value: 'Via Esempio 1', source: 'identity' });
    expect(candidateAnswerForField(candidate, { label: 'CAP', context: flattenedPersonalContext, options: [] }))
      .toEqual({ value: '6830', source: 'identity' });
    expect(candidateAnswerForField(candidate, { label: 'Nazione (di residenza)', context: flattenedPersonalContext, options: [{ label: 'Svizzera' }, { label: 'Italia' }] }))
      .toEqual({ value: 'Svizzera', source: 'identity' });
    expect(candidateAnswerForField(candidate, repeatEmail)).toBeNull();
    expect(candidateAnswerForField(candidate, street)).toEqual({ value: 'Via Esempio', source: 'identity' });
    expect(candidateAnswerForField(candidate, postcode)).toEqual({ value: '6830', source: 'identity' });
    expect(candidateAnswerForField(candidate, country)).toEqual({ value: 'Schweiz', source: 'identity' });
    expect(candidateAnswerForField({ ...candidate, identity: { ...candidate.identity, address: { street: '', postalCode: '', city: '', country: '' } } }, postcode))
      .toEqual({ value: '6830', source: 'identity' });
    expect(candidateAnswerForField({ ...candidate, profile: { ...candidate.profile, address: { ...candidate.profile.address, street: '12 Via Roma' } } }, { ...street, label: 'Street Name' }))
      .toEqual({ value: 'Via Roma', source: 'identity' });
    const guarded = guardPlan({ actions: [
      { fieldId: repeatEmail.id, action: 'fill', value: candidate.identity.email, document: 'none', source: 'identity', evidence: '' },
      { fieldId: street.id, action: 'fill', value: 'Via Esempio', document: 'none', source: 'identity', evidence: '' },
      { fieldId: postcode.id, action: 'fill', value: '6830', document: 'none', source: 'identity', evidence: '' },
      { fieldId: country.id, action: 'select', value: 'Italien', document: 'none', source: 'profile', evidence: '' },
    ], missingRequired: [] }, [repeatEmail, street, postcode, country], candidate);
    expect(guarded.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldId: repeatEmail.id, action: 'fill', value: candidate.identity.email }),
      expect.objectContaining({ fieldId: street.id, action: 'fill', value: 'Via Esempio' }),
      expect.objectContaining({ fieldId: postcode.id, action: 'fill', value: '6830' }),
      expect.objectContaining({ fieldId: country.id, action: 'select', value: 'Schweiz' }),
    ]));
    expect(guarded.missingRequired).toEqual([]);
  });

  it('does not infer a country from an unrecognised province code alone', () => {
    const candidate = candidateForForm({
      identity: { name: 'Test Candidate', email: 'test@example.com', phone: '' },
      profile: {
        location: 'San Juan (PR)',
        address: { street: 'Via Test 1', postalCode: '', city: 'San Juan (PR)', country: '' },
      },
    });
    expect(candidate.identity.address).toMatchObject({ postalCode: '', country: '' });
  });

  it('does not take a CAP from an employer address line in the CV', () => {
    expect(resolveResidenceAddress({}, '', 'Employer address: Via Roma 1, 43039').postalCode).toBe('');
  });

  it('deduplicates a portal question after an ATS changes its wording', () => {
    const questions = [
      { id: 'portal_old_address', source: 'portal', question: 'Qual è la tua via e il numero civico?' },
      { id: 'portal_new_address', source: 'portal', question: 'Rue et numéro' },
      { id: 'school', source: 'portal', question: 'In quale scuola sei attualmente?' },
      { id: 'rule', source: 'rule', question: 'Qual è la tua via e il numero civico?' },
    ];
    expect(dedupePortalQuestions(questions).map((question) => question.id)).toEqual(['portal_old_address', 'school', 'rule']);
  });

  it('keeps same-label portal questions and answers independent by fieldset context', () => {
    const residence = { id: portalQuestionId('CAP', 'Dati anagrafici · Indirizzo · CAP'), source: 'portal', question: 'CAP', context: 'Dati anagrafici · Indirizzo · CAP', required: true, type: 'text', options: [] };
    const employer = { id: portalQuestionId('CAP', 'Esperienza professionale · Datore di lavoro · Indirizzo · CAP'), source: 'portal', question: 'CAP', context: 'Esperienza professionale · Datore di lavoro · Indirizzo · CAP', required: true, type: 'text', options: [] };
    expect(portalQuestionId('CAP', ' Residence ')).toBe(portalQuestionId('cap', 'residence'));
    expect(portalQuestionKey('CAP', 'Residence')).toBe(portalQuestionKey('CAP (obbligatorio)', ' residence '));
    expect(portalQuestionKey('CAP', residence.context)).not.toBe(portalQuestionKey('CAP', employer.context));
    expect(residence.id).not.toBe(employer.id);
    expect(dedupePortalQuestions([residence, employer])).toEqual([residence, employer]);

    const candidate = candidateForForm({
      identity: { name: 'Maria Rossi', email: 'c-abcdefghjk@candidature.frontaliereticino.ch', phone: '' },
      profile: { address: { street: '', postalCode: '', city: '', country: '' } },
      answers: { [residence.id]: '43039', [employer.id]: '9999' },
      portalQuestions: [residence, employer],
    });
    expect(candidate.portalQuestionsAnswered).toEqual(expect.arrayContaining([
      expect.objectContaining({ question: 'CAP', context: residence.context, answer: '43039' }),
      expect.objectContaining({ question: 'CAP', context: employer.context, answer: '9999' }),
    ]));
    expect(candidateAnswerForField(candidate, { label: 'CAP', context: residence.context, options: [] })).toEqual({ value: '43039', source: 'answers' });
    expect(candidateAnswerForField(candidate, { label: 'CAP', context: employer.context, options: [] })).toEqual({ value: '9999', source: 'answers' });
  });

  it('derives an age threshold only from the explicit date of birth', () => {
    const question = 'Hai meno di 26 anni?';
    const field = { id: 'age', kind: 'select', label: question, required: true, options: [{ label: 'Sì' }, { label: 'No' }] };
    const candidate = candidateForForm({
      identity: { name: 'Maria Rossi', email: 'c-abcdefghjk@candidature.frontaliereticino.ch', phone: '' },
      profile: { dateOfBirth: '2002-01-01' },
    });
    expect(ageAt('13/11/2001', new Date('2026-10-07T00:00:00Z'))).toBe(24);
    expect(ageAt('07.10.2000', new Date('2026-10-07T00:00:00Z'))).toBe(26);
    expect(questionTopic(question)).toBe('age_under_26');
    expect(questionTopic('Hai meno di 26 anni di esperienza?')).toBe('');
    expect(candidateAnswerForField(candidate, field)).toEqual({ value: 'Sì', source: 'profile' });
    expect(autoAnswersForPortalQuestions({
      questions: [{ id: 'age', source: 'portal', question, required: true, type: 'choice', options: ['Sì', 'No'] }],
      candidate,
      answers: {},
    })).toEqual({ age: 'Sì' });
    const oldAddress = { id: 'portal_qual_e_la_tua_via_e_il_numero_civico', source: 'portal', question: 'Qual è la tua via e il numero civico?', required: true, type: 'text', options: [] };
    const renamedAddress = { id: 'portal_qual_e_la_via_e_il_numero_civico', source: 'portal', question: 'Qual è la via e il numero civico?', required: true, type: 'text', options: [] };
    const addressCandidate = candidateForForm({
      identity: { name: 'Maria Rossi', email: 'c-abcdefghjk@candidature.frontaliereticino.ch', phone: '' },
      answers: { [oldAddress.id]: 'Via Test 1' },
      portalQuestions: [oldAddress, renamedAddress],
    });
    expect(autoAnswersForPortalQuestions({
      questions: [oldAddress, renamedAddress],
      candidate: addressCandidate,
      answers: { [oldAddress.id]: 'Via Test 1' },
    })).toEqual({ [renamedAddress.id]: 'Via Test 1' });
    expect(candidateAnswerForField(candidateForForm({
      identity: { name: 'Maria Rossi', email: 'c-abcdefghjk@candidature.frontaliereticino.ch', phone: '' },
      profile: { dateOfBirth: '1990-01-01' },
    }), field)).toEqual({ value: 'No', source: 'profile' });
    expect(candidateAnswerForField(candidateForForm({
      identity: { name: 'Maria Rossi', email: 'c-abcdefghjk@candidature.frontaliereticino.ch', phone: '' },
      profile: {},
    }), field)).toBeNull();

    const guarded = guardPlan({ actions: [], missingRequired: [] }, [field], candidate);
    expect(guarded.actions).toEqual([expect.objectContaining({ fieldId: 'age', value: 'Sì', source: 'profile' })]);
    expect(guarded.missingRequired).toEqual([]);
  });

  it('reuses a saved semantic answer when the portal changes the question id', () => {
    const out = autoAnswersForPortalQuestions({
      questions: [{ id: 'new-age', source: 'portal', required: true, type: 'yes_no', question: 'Meno di 26 anni?', options: ['Sì', 'No'] }],
      candidate: { profile: {}, portalQuestionsAnswered: [{ question: 'Are you under 26?', answer: 'Yes' }] },
      answers: {},
    });
    expect(out).toEqual({ 'new-age': 'Sì' });

    const field = { id: 'new-address', kind: 'text', label: 'Qual è la via e il numero civico?', required: true, options: [] };
    expect(candidateAnswerForField({
      profile: {},
      portalQuestionsAnswered: [{ question: 'Qual è la tua via e il numero civico?', answer: 'Via Test 1' }],
    }, field)).toEqual({ value: 'Via Test 1', source: 'answers' });

    expect(candidateAnswerForField({
      profile: {},
      answers: { portal_qual_e_la_via_e_il_numero_civico: 'Via Test 1' },
    }, { ...field, id: 'portal_qual_e_la_tua_via_e_il_tuo_numero_civico', label: 'Qual è la tua via e il tuo numero civico?' }))
      .toEqual({ value: 'Via Test 1', source: 'answers' });
    expect(answeredByCandidate({
      answers: { portal_qual_e_la_tua_via_e_il_tuo_numero_civico: 'Via Test 1' },
      portalQuestionsAnswered: [],
    }, 'Qual è la tua via e il numero civico?', 'Via Test 1')).toBe(true);

    // Rolex/SuccessFactors exposes the same combined field in French as
    // «Rue et numéro»; it must reuse the saved Italian portal answer.
    expect(questionTopic('Rue et numéro')).toBe('address');
    expect(candidateAnswerForField({
      answers: { portal_qual_e_la_tua_via_e_il_numero_civico: 'Via Test 1' },
      portalQuestionsAnswered: [],
    }, { id: 'street-number', kind: 'text', label: 'Rue et numéro', required: true, options: [] }))
      .toEqual({ value: 'Via Test 1', source: 'answers' });
  });

  it('uses the alias as the e-mail and keeps sensitive data only from the candidate', () => {
    const candidate = candidateForForm({
      identity: { name: 'Maria Anna Rossi', email: 'c-abcdefghjk@candidature.frontaliereticino.ch', phone: '+41 79 000 00 00' },
      profile: {
        location: 'Como', workPermit: '', experience: [{ role: 'Infermiera', employer: 'Clinica' }],
        address: { street: 'Via Roma 1', postalCode: '22100', city: 'Como', country: 'Italia' }, nationality: 'italiana',
      },
      answers: { work_permit: 'G', portal_start_date: '1.12.2026' },
      draft: { formAnswers: [{ key: 'motivationShort', value: 'Motivo' }], coverLetter: { text: 'Lettera' } },
      portalQuestions: [{ id: 'portal_start_date', question: 'Start date?' }],
    });
    expect(candidate.identity).toMatchObject({ firstName: 'Maria Anna', lastName: 'Rossi', email: 'c-abcdefghjk@candidature.frontaliereticino.ch' });
    // A surname keeps the particles that open it (a real order of 2026-10-07 typed the particle as a given
    // name); the split the candidate chose on the review page wins.
    const named = (identity: any) => candidateForForm({ identity: { email: 'a@example.com', phone: '', ...identity } }).identity;
    expect(named({ name: 'Amina El Amrani' })).toMatchObject({ fullName: 'Amina El Amrani', firstName: 'Amina', lastName: 'El Amrani' });
    expect(named({ name: 'Maria De Luca' })).toMatchObject({ firstName: 'Maria', lastName: 'De Luca' });
    expect(named({ name: 'Amina El Amrani', firstName: 'Amina El', lastName: 'Amrani' })).toMatchObject({ firstName: 'Amina El', lastName: 'Amrani' });
    expect(named({ name: 'Maria' })).toMatchObject({ firstName: 'Maria', lastName: '' });
    expect(candidate.identity.address).toEqual({ street: 'Via Roma 1', postalCode: '22100', city: 'Como', country: 'Italia' });
    expect(candidate.profile).toMatchObject({ nationality: 'italiana', dateOfBirth: '' });
    expect(candidate.portalQuestionsAnswered).toEqual([{ question: 'Start date?', answer: '1.12.2026' }]);
    expect(candidate.texts).toMatchObject({ motivationShort: 'Motivo', coverLetter: 'Lettera' });
  });

  it('masks the address, birth date and nationality read from the CV in the Actions log', () => {
    const profile = { address: { street: 'Via Roma 1', postalCode: '22100', city: 'Como', country: 'Italia' }, dateOfBirth: '01.01.1990', nationality: 'italiana' };
    expect(personalValuesOf({}, profile)).toEqual(expect.arrayContaining(['Via Roma 1', '22100', 'Como', '01.01.1990', 'italiana']));
  });

  it('recognises next, submit, confirmation and validation in four languages', () => {
    for (const text of ['Next', 'Weiter', 'Avanti', 'Suivant', 'Save and continue']) expect(NEXT_RE.test(text)).toBe(true);
    for (const text of ['Submit application', 'Bewerbung absenden', 'Invia candidatura', 'Envoyer ma candidature', 'Postuler']) expect(SUBMIT_RE.test(text)).toBe(true);
    // Giro di prova 2026-10-01: JOIN's review page ends with «Conferma e applica».
    for (const text of ['Conferma e applica', 'Confirm and apply', 'Bestätigen und bewerben', 'Confirmer et postuler', 'Candidati']) expect(SUBMIT_RE.test(text)).toBe(true);
    for (const text of ['Continua', 'Indietro', 'Modifica', 'Applica filtro']) expect(SUBMIT_RE.test(text)).toBe(false);
    // Review of #10725: the whole label, so a filter control is never the submission.
    for (const text of ['Conferma e applica filtro', 'Confirm and apply filters', 'Bestätigen und bewerben später']) expect(SUBMIT_RE.test(text)).toBe(false);
    for (const text of ['Conferma e applica →', 'Confirm and submit']) expect(SUBMIT_RE.test(text)).toBe(true);
    for (const text of ['Indicare la data nel formato indicato.', 'Inserire la data nel formato corretto.', 'Datum im angegebenen Format']) expect(VALIDATION_RE.test(text)).toBe(true);
    for (const text of ['Thank you for applying!', 'Vielen Dank für Ihre Bewerbung', 'La candidatura è stata inviata', 'Votre candidature a bien été envoyée']) expect(CONFIRM_RE.test(text)).toBe(true);
    // The same thanks in more words (an ATS in English, 2026-10-03).
    for (const text of ['Thank you very much for your application', 'Many thanks for your application!']) expect(CONFIRM_RE.test(text)).toBe(true);
    // JOIN says "du"/"tu".
    for (const text of ['Grazie per esserti candidato!', 'La ringraziamo per la sua candidatura', 'Vielen Dank für deine Bewerbung']) expect(CONFIRM_RE.test(text)).toBe(true);
    expect(VALIDATION_RE.test('Dieses Feld ist ein Pflichtfeld')).toBe(true);
    expect(findButton([{ id: 'b1', text: 'Cancel' }, { id: 'b2', text: 'Weiter' }], NEXT_RE)).toEqual({ id: 'b2', text: 'Weiter' });
    // A disabled submit (required fields still empty) is not clicked, but the runner can see it.
    const disabled = [{ id: 'b3', text: 'Bewerbung senden', disabled: true }];
    expect(findButton(disabled, SUBMIT_RE)).toBeNull();
    expect(findButton(disabled, SUBMIT_RE, { includeDisabled: true })).toEqual(disabled[0]);
    // Of two controls with the same name the page's own comes before the site header's (fields.mjs `chrome`),
    // which is pressed only when nothing else answers to the name, or the page's one is disabled.
    const signIn = [{ id: 'h1', text: 'Sign In', chrome: true }, { id: 'c1', text: 'Create Account' }, { id: 'c2', text: 'Sign In' }];
    expect(findButton(signIn, /^sign in$/i)).toEqual(signIn[2]);
    expect(findButton(signIn.slice(0, 2), /^sign in$/i)).toEqual(signIn[0]);
    expect(findButton([signIn[0], { ...signIn[2], disabled: true }], /^sign in$/i)).toEqual(signIn[0]);
    // A search box is answered when its chosen value names what would be typed (Workday's phone code: «+41»
    // typed, «Switzerland (+41)» chosen); another country's code, an empty box or an empty answer are not.
    expect(searchHolds('Switzerland (+41)', '+41')).toBe(true);
    expect(searchHolds(' switzerland  (+41) ', 'Switzerland')).toBe(true);
    expect(searchHolds('United States of America (+1)', '+41')).toBe(false);
    expect(searchHolds('', '+41')).toBe(false);
    expect(searchHolds('Switzerland (+41)', '')).toBe(false);
    expect(slugId('Wann können Sie beginnen?')).toBe('wann_konnen_sie_beginnen');
    expect(WAVE1_CHANNELS.has('workday')).toBe(true);
    expect(WAVE1_CHANNELS.has('linkedin')).toBe(false);
  });

  it('recognises a resumed SuccessFactors OTP page with its code field and Continue button', () => {
    const otpPage = {
      fields: [{ id: 'otp', kind: 'text', inputType: 'text', label: '*Code confidentiel:', required: true }],
      buttons: [{ id: 'continue', text: 'Continuer' }],
      text: '',
    };
    expect(isOtpVerificationPage(otpPage, 'career5.successfactors.eu', { verifiedAt: null })).toBe(true);
    // Loading must win over the generic "successfully" match while the OTP
    // request is still in flight, even if the transient snapshot has no fields.
    expect(verificationOutcome({
      errors: ['Chargement en cours…'],
      text: 'Code successfully sent',
      fields: [],
    })).toBe('pending');
    expect(isOtpVerificationPage(otpPage, 'career5.successfactors.eu', { verifiedAt: 1 })).toBe(false);
    expect(isOtpVerificationPage(otpPage, 'sunrise.wd3.myworkdayjobs.com', { verifiedAt: null })).toBe(false);
    expect(isOtpVerificationPage({ ...otpPage, buttons: [] }, 'career5.successfactors.eu', { verifiedAt: null })).toBe(false);
  });

  it('keeps a resumed OTP page pending while SuccessFactors reports that it is loading', () => {
    const otpPage = {
      fields: [{ id: 'otp', kind: 'text', inputType: 'text', label: '*Code confidentiel:', required: true }],
      buttons: [{ id: 'continue', text: 'Continuer' }],
      text: 'Chargement en cours…',
    };
    expect(isOtpVerificationPage(otpPage, 'career5.successfactors.eu', { verifiedAt: null })).toBe(true);
    expect(verificationIsPending(otpPage)).toBe(true);
    expect(verificationIsPending({ ...otpPage, text: 'Le code est incorrect' })).toBe(false);
    // During the post-OTP route change SuccessFactors can briefly expose a
    // blank document; it is loading, not evidence that verification failed.
    expect(verificationIsPending({ fields: [], buttons: [], errors: [], text: '' })).toBe(true);
    expect(verificationIsPending({ fields: [], buttons: [], errors: [], text: 'Benvenuto' })).toBe(false);
  });
});

// Owner decisions of 2026-10-03 (P4, decision 9): the planner gets the Swiss status as a sentence, the guard reads
// permit, work-authorisation, nationality and citizenship fields in four languages, and a code rule picks the one
// option that says exactly the candidate's status.
describe('portal: the candidate’s Swiss status and nationality', () => {
  const identity = { name: 'Giulia Verdi', email: 'c-abcdefghjk@candidature.frontaliereticino.ch', phone: '+39 333 000 0000' };
  const candidate = (profile: Record<string, any> = {}, answers: Record<string, string> = {}, portalQuestions: any[] = []) => candidateForForm({ identity, profile, answers, portalQuestions, language: 'de' });
  const select = (fieldId: string, value: string, source = 'rule') => ({ fieldId, action: 'select', value, document: 'none', source, evidence: '' });
  const permitField = (label: string, options: string[]) => ({ id: 'p1', kind: 'select', label, required: true, options: options.map((option) => ({ label: option })) });

  it('reads permit, work-authorisation, nationality and citizenship fields as sensitive, never a licence or a country', () => {
    for (const label of ['Nazionalità', 'Cittadinanza', 'Arbeitserlaubnis', 'Are you legally authorised to work in Switzerland?', 'Do you have the right to work in Switzerland?',
      'Will you require sponsorship?', 'Avez-vous un permis de travail valable en Suisse ?', 'Staatsangehörigkeit', 'Citizenship', 'Qual è il suo stato di autorizzazione al lavoro per Svizzera?']) {
      expect([label, SENSITIVE.test(label)]).toEqual([label, true]);
    }
    for (const label of ['Permis de conduire', 'Country', 'E-Mail-Adresse', 'Email address']) expect([label, SENSITIVE.test(label)]).toEqual([label, false]);
    expect(SENSITIVE.test('email e nazionalità')).toBe(true);
    expect(SENSITIVE.test('E-Mail-Adresse (required)')).toBe(false);
    expect(SENSITIVE.test('Email address (obligatoire)')).toBe(false);
  });

  it('never ticks a consent that also declares a work authorisation or a citizenship', () => {
    const box = (label: string) => ownConsent({ kind: 'checkbox', required: true, label });
    expect(box('Ich habe eine gültige Arbeitserlaubnis und akzeptiere die Datenschutzerklärung')).toBe(false);
    expect(box('I am authorised to work in Switzerland and accept the privacy policy')).toBe(false);
    expect(box('Ho la cittadinanza svizzera e accetto l’informativa privacy')).toBe(false);
    expect(box('Ho letto l’informativa privacy e acconsento al trattamento dei dati')).toBe(true);
    expect(box('Do il permesso al trattamento dei dati')).toBe(true);
  });

  it('picks the one option that says exactly the status the candidate chose, whatever the plan chose', () => {
    const field = permitField('Arbeitsbewilligung *', ['B (Aufenthalter)', 'C (Niedergelassene)', 'G (Grenzgänger)', 'Schweizer/in']);
    const picked = guardPlan({ actions: [select('p1', 'B (Aufenthalter)')], missingRequired: [] }, [field], candidate({ permitStatus: 'permit_g' }));
    expect(picked).toEqual({ actions: [select('p1', 'G (Grenzgänger)')], missingRequired: [] });
    const asked = guardPlan({ actions: [], missingRequired: [{ fieldId: 'p1', question: 'Bewilligung?', why: '', type: 'choice', options: [] }] }, [field], candidate({ permitStatus: 'permit_g' }));
    expect(asked).toEqual({ actions: [select('p1', 'G (Grenzgänger)')], missingRequired: [] });
    // «none» is a status too: the option that says no permit is held.
    const none = guardPlan({ actions: [], missingRequired: [] }, [permitField('Bewilligung', ['Keine', 'B', 'G'])], candidate({ permitStatus: 'none' }));
    expect(none.actions).toEqual([select('p1', 'Keine')]);
    // A field that asks what the candidate needs is never answered by the code, nor two options that say the same.
    expect(guardPlan({ actions: [], missingRequired: [] }, [permitField('Welche Bewilligung benötigen Sie?', ['Keine', 'B', 'G'])], candidate({ permitStatus: 'none' })).actions).toEqual([]);
    expect(guardPlan({ actions: [], missingRequired: [] }, [permitField('Bewilligung', ['G (Grenzgänger)', 'Ausweis G EU/EFTA'])], candidate({ permitStatus: 'permit_g' })).actions).toEqual([]);
  });

  it('keeps a permit answer only when it names the candidate’s own status, never a «Ja» that occurs in the data', () => {
    const question = 'Haben Sie eine gültige Arbeitsbewilligung?';
    const yesNo = permitField(question, ['Ja', 'Nein']);
    // «Ja» answers another question of the candidate: the substring rule read it as backing this one.
    for (const permitStatus of ['none', 'permit_b']) {
      const guarded = guardPlan({ actions: [select('p1', 'Ja', 'answers')], missingRequired: [] }, [yesNo], candidate({ permitStatus }, { portal_fuehrerschein: 'Ja' }));
      expect([permitStatus, guarded.actions, guarded.missingRequired.map((item: any) => item.fieldId)]).toEqual([permitStatus, [], ['p1']]);
    }
    // The candidate's own answer to this very question.
    const answered = candidate({ permitStatus: 'none' }, { portal_bewilligung: 'Ja' }, [{ id: 'portal_bewilligung', question }]);
    expect(guardPlan({ actions: [select('p1', 'Ja', 'answers')], missingRequired: [] }, [yesNo], answered).actions).toEqual([select('p1', 'Ja', 'answers')]);
    // Nothing chosen: only the CV's own words.
    const gb = permitField('Work permit', ['G', 'B']);
    expect(guardPlan({ actions: [select('p1', 'G', 'profile')], missingRequired: [] }, [gb], candidate({ workPermit: 'Permesso G' })).actions).toEqual([select('p1', 'G', 'profile')]);
    expect(guardPlan({ actions: [select('p1', 'G', 'profile')], missingRequired: [] }, [gb], candidate({})).missingRequired.map((item: any) => item.fieldId)).toEqual(['p1']);
    // A text field filled with the candidate's own statement.
    const text = { id: 't1', kind: 'text', label: 'Aufenthaltsstatus', required: true };
    const fill = { fieldId: 't1', action: 'fill', value: permitStatement('permit_b', 'de'), document: 'none', source: 'profile', evidence: '' };
    expect(guardPlan({ actions: [fill], missingRequired: [] }, [text], candidate({ permitStatus: 'permit_b' })).actions).toEqual([fill]);
  });

  it('keeps a nationality only when it names the one the candidate gave, Swiss for the status «swiss»', () => {
    const field = { id: 'n1', kind: 'select', label: 'Nationalität', required: true, options: [{ label: 'Italien' }, { label: 'Deutschland' }, { label: 'Schweiz' }] };
    expect(guardPlan({ actions: [select('n1', 'Italien', 'profile')], missingRequired: [] }, [field], candidate({ nationality: 'italiana' })).actions).toEqual([select('n1', 'Italien', 'profile')]);
    expect(guardPlan({ actions: [select('n1', 'Deutschland', 'profile')], missingRequired: [] }, [field], candidate({ nationality: 'italiana' })).missingRequired.map((item: any) => item.fieldId)).toEqual(['n1']);
    expect(guardPlan({ actions: [select('n1', 'Schweiz', 'profile')], missingRequired: [] }, [field], candidate({ permitStatus: 'swiss' })).actions).toEqual([select('n1', 'Schweiz', 'profile')]);
  });

  it('gives the planner the status as a sentence outside the data the substring rule reads, and the birth date as the portals read it', () => {
    const form = candidateForForm({
      identity, profile: { permitStatus: 'permit_b', workPermit: 'Permesso G', dateOfBirth: '14. März 2010' }, answers: { work_permit: 'x', salary_expectation: 'CHF 80k' }, language: 'de',
    });
    expect(form.swissStatus).toEqual({ code: 'permit_b', statement: 'Ich habe eine heute gültige Aufenthaltsbewilligung B.' });
    expect(form.profile).toMatchObject({ workPermit: '', dateOfBirth: '2010-03-14' });
    expect(form.answers).toEqual({ salary_expectation: 'CHF 80k' });
    const known = knownValuesOf(form);
    expect(known).not.toContain('aufenthaltsbewilligung');
    expect(known).not.toContain('permesso g');
    expect(planSystemPrompt('it')).toContain('swissStatus.statement is the candidate\'s own statement of their Swiss status today');
  });
});
