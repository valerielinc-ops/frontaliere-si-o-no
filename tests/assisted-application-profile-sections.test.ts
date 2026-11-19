import { afterEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
  extractFields: vi.fn(),
  planPage: vi.fn(),
  applyActions: vi.fn(),
}));

vi.mock('../scripts/assisted-application/lib/portal/fields.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, extractFields: doubles.extractFields };
});

vi.mock('../scripts/assisted-application/lib/portal/plan.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, planPage: doubles.planPage };
});

vi.mock('../scripts/assisted-application/lib/portal/fill.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, applyActions: doubles.applyActions };
});

import { fillProfileSections } from '../scripts/assisted-application/lib/portal/portal.mjs';

afterEach(() => vi.resetAllMocks());

describe('profile history rows', () => {
  it('overrides planner defaults with each experience and education row date from the CV', async () => {
    const rows = {
      experience: { id: 'experience-start', section: 'Work Experience', label: 'Start Date', kind: 'text', inputType: 'text', required: true, value: '' },
      education: { id: 'education-start', section: 'Education', label: 'Start Date', kind: 'text', inputType: 'text', required: true, value: '' },
    };
    const addButtons = [
      { id: 'add-experience', text: 'Add Experience', section: 'Work Experience', disabled: false },
      { id: 'add-education', text: 'Add Education', section: 'Education', disabled: false },
    ];
    let activeKind: 'experience' | 'education' | null = null;
    const values = new Map();
    const applied = new Map();
    const snapshot = () => ({
      url: 'https://jobs.example.test/apply',
      fields: activeKind ? [{ ...rows[activeKind], value: values.get(rows[activeKind].id) || '' }] : [],
      buttons: activeKind
        ? [...addButtons, { id: `save-${activeKind}`, text: 'Save', section: rows[activeKind].section, disabled: false }]
        : addButtons,
    });
    doubles.extractFields.mockImplementation(async () => snapshot());
    doubles.planPage.mockImplementation(async ({ snapshot: planned }) => ({
      actions: planned.fields.map((field) => ({
        fieldId: field.id, action: 'fill', value: '2099-01', source: 'policy_default', document: 'none', evidence: '',
      })),
      missingRequired: [],
    }));
    doubles.applyActions.mockImplementation(async (_page, fields, actions) => {
      applied.set(fields[0].section, actions);
      for (const action of actions) values.set(action.fieldId, action.value);
      return actions.map(() => ({ ok: true }));
    });

    const frame = {
      locator(selector: string) {
        return {
          first() {
            return {
              async click() {
                const id = /data-aa-id="([^"]+)"/.exec(selector)?.[1];
                if (id === 'add-experience') activeKind = 'experience';
                else if (id === 'add-education') activeKind = 'education';
                else if (id?.startsWith('save-')) activeKind = null;
              },
            };
          },
        };
      },
    };
    const page = {
      url: () => 'https://jobs.example.test/apply',
      frames: () => [frame],
      waitForTimeout: async () => {},
    };
    const candidate = {
      profile: {
        experience: [{ role: 'Example role', employer: 'Example employer', start: '2020-03', end: '2022-05' }],
        education: [{ degree: 'Example diploma', institution: 'Example school', start: '2017-09', end: '2019-06' }],
      },
    };

    const result = await fillProfileSections(page as never, snapshot(), { candidate });

    expect(result.counts).toEqual([{ section: 'experience', added: 1, skipped: 0 }, { section: 'education', added: 1, skipped: 0 }]);
    expect(applied.get('Work Experience')).toEqual([
      expect.objectContaining({ fieldId: 'experience-start', value: '2020-03', source: 'profile', action: 'fill' }),
    ]);
    expect(applied.get('Education')).toEqual([
      expect.objectContaining({ fieldId: 'education-start', value: '2017-09', source: 'profile', action: 'fill' }),
    ]);
  });

  it('associates Workday date wrappers with rows when only the other controls expose ordinals', async () => {
    const fields = [
      { id: 'title-1', section: 'Work Experience 1', label: 'Job Title*', kind: 'text', required: true, value: 'Existing role' },
      { id: 'company-1', section: 'Work Experience 1', label: 'Company*', kind: 'text', required: true, value: 'Existing employer' },
      { id: 'title-2', section: 'Work Experience 2', label: 'Job Title*', kind: 'text', required: true, value: 'Another role' },
      { id: 'company-2', section: 'Work Experience 2', label: 'Company*', kind: 'text', required: true, value: 'Another employer' },
      { id: 'from-2', section: 'Work Experience', label: 'From*', kind: 'text', inputType: 'date', widget: 'workday-date', required: true, value: '', addressContext: { section: 'Work Experience', owners: ['Another role'], unknown: false } },
      { id: 'to-1', section: 'Work Experience', label: 'To*', kind: 'text', inputType: 'date', widget: 'workday-date', required: true, value: '', addressContext: { section: 'Work Experience', owners: ['Existing role'], unknown: false } },
      { id: 'from-1', section: 'Work Experience', label: 'From*', kind: 'text', inputType: 'date', widget: 'workday-date', required: true, value: '', addressContext: { section: 'Work Experience', owners: ['Existing role'], unknown: false } },
      { id: 'to-2', section: 'Work Experience', label: 'To*', kind: 'text', inputType: 'date', widget: 'workday-date', required: true, value: '', addressContext: { section: 'Work Experience', owners: ['Another role'], unknown: false } },
    ];
    const current = {
      url: 'https://rituals.wd3.myworkdayjobs.com/en-US/Rituals/job/Sion/Role_R2420/apply/applyManually',
      fields,
      buttons: [
        { id: 'delete-1', text: 'Delete', section: 'Work Experience', disabled: false },
        { id: 'delete-2', text: 'Delete', section: 'Work Experience', disabled: false },
        { id: 'add-another', text: 'Add Another', section: 'Work Experience', disabled: false },
      ],
    };
    doubles.extractFields.mockImplementation(async () => current);
    doubles.applyActions.mockImplementation(async (_page, rowFields, actions) => {
      for (const action of actions) rowFields.find((field) => field.id === action.fieldId).value = action.value;
      return actions.map((action) => ({ fieldId: action.fieldId, ok: true }));
    });

    const candidate = {
      profile: {
        experience: [
          { role: 'Existing role', employer: 'Existing employer', start: '2022-01', end: '2024-01' },
          { role: 'Another role', employer: 'Another employer', start: '2020-02', end: '2021-03' },
        ],
        education: [],
      },
    };

    const result = await fillProfileSections({ url: () => current.url } as never, current as never, { candidate });

    expect(result.handoff).toBeUndefined();
    expect(current.fields.find((field) => field.id === 'from-1').value).toBe('2022-01');
    expect(current.fields.find((field) => field.id === 'to-1').value).toBe('2024-01');
    expect(current.fields.find((field) => field.id === 'from-2').value).toBe('2020-02');
    expect(current.fields.find((field) => field.id === 'to-2').value).toBe('2021-03');
  });

  it('hands off instead of assigning unowned date wrappers by array position', async () => {
    const current = {
      url: 'https://rituals.wd3.myworkdayjobs.com/en-US/Rituals/job/Sion/Role_R2420/apply/applyManually',
      fields: [
        { id: 'title-1', section: 'Work Experience 1', label: 'Job Title*', kind: 'text', required: true, value: 'Existing role' },
        { id: 'title-2', section: 'Work Experience 2', label: 'Job Title*', kind: 'text', required: true, value: 'Another role' },
        { id: 'from-1', section: 'Work Experience', label: 'From*', kind: 'text', inputType: 'date', widget: 'workday-date', required: true, value: '' },
        { id: 'to-1', section: 'Work Experience', label: 'To*', kind: 'text', inputType: 'date', widget: 'workday-date', required: true, value: '' },
        { id: 'from-2', section: 'Work Experience', label: 'From*', kind: 'text', inputType: 'date', widget: 'workday-date', required: true, value: '' },
        { id: 'to-2', section: 'Work Experience', label: 'To*', kind: 'text', inputType: 'date', widget: 'workday-date', required: true, value: '' },
      ],
      buttons: [{ id: 'add-another', text: 'Add Another', section: 'Work Experience', disabled: false }],
    };
    doubles.extractFields.mockImplementation(async () => current);
    const candidate = {
      profile: {
        experience: [
          { role: 'Existing role', employer: 'Existing employer', start: '2022-01', end: '2024-01' },
          { role: 'Another role', employer: 'Another employer', start: '2020-02', end: '2021-03' },
        ],
        education: [],
      },
    };

    const result = await fillProfileSections({ url: () => current.url } as never, current as never, { candidate });

    expect(result.handoff).toBe('profile_section_row_fill_failed');
    expect(current.fields.filter((field) => /^(?:From|To)\*/.test(field.label)).every((field) => field.value === '')).toBe(true);
  });

  it('associates date wrappers through sectionGroupId when it is the only row owner', async () => {
    const current = {
      url: 'https://rituals.wd3.myworkdayjobs.com/en-US/Rituals/job/Sion/Role_R2420/apply/applyManually',
      fields: [
        { id: 'title-1', section: 'Work Experience 1', label: 'Job Title*', kind: 'text', required: true, value: 'Existing role', sectionGroupId: 'group-1' },
        { id: 'title-2', section: 'Work Experience 2', label: 'Job Title*', kind: 'text', required: true, value: 'Another role', sectionGroupId: 'group-2' },
        { id: 'from-2', section: 'Work Experience', label: 'From*', kind: 'text', inputType: 'date', widget: 'workday-date', required: true, value: '', sectionGroupId: 'group-2' },
        { id: 'to-1', section: 'Work Experience', label: 'To*', kind: 'text', inputType: 'date', widget: 'workday-date', required: true, value: '', sectionGroupId: 'group-1' },
        { id: 'from-1', section: 'Work Experience', label: 'From*', kind: 'text', inputType: 'date', widget: 'workday-date', required: true, value: '', sectionGroupId: 'group-1' },
        { id: 'to-2', section: 'Work Experience', label: 'To*', kind: 'text', inputType: 'date', widget: 'workday-date', required: true, value: '', sectionGroupId: 'group-2' },
      ],
      buttons: [
        { id: 'delete-1', text: 'Delete', section: 'Work Experience', disabled: false },
        { id: 'delete-2', text: 'Delete', section: 'Work Experience', disabled: false },
        { id: 'add-another', text: 'Add Another', section: 'Work Experience', disabled: false },
      ],
    };
    doubles.extractFields.mockImplementation(async () => current);
    doubles.applyActions.mockImplementation(async (_page, rowFields, actions) => {
      for (const action of actions) rowFields.find((field) => field.id === action.fieldId).value = action.value;
      return actions.map((action) => ({ fieldId: action.fieldId, ok: true }));
    });
    const candidate = {
      profile: {
        experience: [
          { role: 'Existing role', employer: 'Existing employer', start: '2022-01', end: '2024-01' },
          { role: 'Another role', employer: 'Another employer', start: '2020-02', end: '2021-03' },
        ],
        education: [],
      },
    };

    const result = await fillProfileSections({ url: () => current.url } as never, current as never, { candidate });

    expect(result.handoff).toBeUndefined();
    expect(current.fields.find((field) => field.id === 'from-1').value).toBe('2022-01');
    expect(current.fields.find((field) => field.id === 'to-1').value).toBe('2024-01');
    expect(current.fields.find((field) => field.id === 'from-2').value).toBe('2020-02');
    expect(current.fields.find((field) => field.id === 'to-2').value).toBe('2021-03');
  });

  it('hands off when an owner-matched date endpoint pair is incomplete', async () => {
    const current = {
      url: 'https://rituals.wd3.myworkdayjobs.com/en-US/Rituals/job/Sion/Role_R2420/apply/applyManually',
      fields: [
        { id: 'title-1', section: 'Work Experience 1', label: 'Job Title*', kind: 'text', required: true, value: 'Existing role' },
        { id: 'from-1', section: 'Work Experience', label: 'From*', kind: 'text', inputType: 'date', widget: 'workday-date', required: true, value: '', addressContext: { section: 'Work Experience', owners: ['Existing role'], unknown: false } },
      ],
      buttons: [{ id: 'add-another', text: 'Add Another', section: 'Work Experience', disabled: false }],
    };
    doubles.extractFields.mockImplementation(async () => current);
    const candidate = {
      profile: {
        experience: [{ role: 'Existing role', employer: 'Existing employer', start: '2022-01', end: '2024-01' }],
        education: [],
      },
    };

    const result = await fillProfileSections({ url: () => current.url } as never, current as never, { candidate });

    expect(result.handoff).toBe('profile_section_row_fill_failed');
    expect(current.fields.find((field) => field.id === 'from-1').value).toBe('');
  });

  it('defaults year-only experience months to 01 and copies missing company from role while deleting unfillable inline rows', async () => {
    let current: any = {
      url: 'https://rituals.wd3.myworkdayjobs.com/en-US/Rituals/job/Sion/Role_R2420/apply/applyManually',
      fields: [
        { id: 'exp-role-1', section: 'Work Experience 1', label: 'Job Title*', kind: 'text', required: true, value: '' },
        { id: 'exp-company-1', section: 'Work Experience 1', label: 'Company*', kind: 'text', required: true, value: '' },
        { id: 'exp-from-1', section: 'Work Experience 1', label: 'From*', kind: 'text', inputType: 'date', widget: 'workday-date', required: true, value: '' },
        { id: 'exp-to-1', section: 'Work Experience 1', label: 'To*', kind: 'text', inputType: 'date', widget: 'workday-date', required: true, value: '' },
        { id: 'edu-degree-1', section: 'Education 1', label: 'Degree*', kind: 'text', required: true, value: 'High School' },
        { id: 'edu-from-1', section: 'Education 1', label: 'From*', kind: 'text', inputType: 'date', widget: 'workday-date', required: true, value: '' },
        { id: 'edu-to-1', section: 'Education 1', label: 'To*', kind: 'text', inputType: 'date', widget: 'workday-date', required: true, value: '' },
      ],
      buttons: [
        { id: 'exp-add', text: 'Add Another', section: 'Work Experience', disabled: false },
        { id: 'exp-del-1', text: 'Delete', section: 'Work Experience 1', disabled: false },
        { id: 'edu-add', text: 'Add Another', section: 'Education', disabled: false },
        { id: 'edu-del-1', text: 'Delete', section: 'Education 1', disabled: false },
      ],
    };
    const deletedButtons: string[] = [];
    doubles.extractFields.mockImplementation(async () => current);
    const makePage = () => {
      const clickFor = (selector: string) => {
        const match = /data-aa-id="([^"]+)"/.exec(selector);
        const buttonId = match?.[1] || '';
        return {
          first: () => ({
            click: async () => {
              deletedButtons.push(buttonId);
              if (buttonId === 'edu-del-1') {
                current = {
                  ...current,
                  fields: current.fields.filter((field: any) => !String(field.section || '').startsWith('Education')),
                  buttons: current.buttons.filter((item: any) => item.id !== 'edu-del-1'),
                };
              }
            },
          }),
        };
      };
      const frame = { locator: clickFor };
      return {
        url: () => current.url,
        waitForTimeout: async () => {},
        frames: () => [frame],
        mainFrame: () => frame,
        locator: clickFor,
      };
    };
    doubles.applyActions.mockImplementation(async (_page: unknown, _fields: unknown, actions: any[]) => {
      for (const action of actions) {
        const target = current.fields.find((field: any) => field.id === action.fieldId);
        if (target) target.value = action.value;
      }
      return actions.map((action) => ({ fieldId: action.fieldId, ok: true }));
    });
    const candidate = {
      profile: {
        experience: [{ role: 'Boutique Owner', employer: '', start: '2017', end: '07/2024' }],
        education: [{ degree: 'High School', institution: 'Local High School', start: '', end: '' }],
      },
    };

    const result = await fillProfileSections(makePage() as never, current as never, { candidate });

    expect(result.handoff).toBeUndefined();
    expect(result.snapshot.fields.find((field: any) => field.id === 'exp-company-1')?.value).toBe('Boutique Owner');
    expect(result.snapshot.fields.find((field: any) => field.id === 'exp-from-1')?.value).toBe('2017-01');
    expect(result.snapshot.fields.find((field: any) => field.id === 'exp-to-1')?.value).toBe('07/2024');
    // No incomplete Work Experience rows remain; Education has undated profile entries so Add is skipped cleanly.
    expect(deletedButtons).toEqual([]);

    // Also verify reconcileExistingInlineProfileRows deletes an inline row that remains incomplete after fill
    // (for example, an extra required field like Field of Study* that profile does not provide).
    const eduOnly = {
      url: current.url,
      fields: [
        { id: 'edu-degree-1', section: 'Education 1', label: 'Degree*', kind: 'text', required: true, value: 'High School' },
        { id: 'edu-school-1', section: 'Education 1', label: 'School*', kind: 'text', required: true, value: '' },
        { id: 'edu-major-1', section: 'Education 1', label: 'Field of Study*', kind: 'text', required: true, value: '' },
      ],
      buttons: [
        { id: 'edu-add', text: 'Add Another', section: 'Education', disabled: false },
        { id: 'edu-del-1', text: 'Delete', section: 'Education 1', disabled: false },
      ],
    };
    current = eduOnly;
    const eduResult = await fillProfileSections(makePage() as never, current as never, {
      candidate: {
        profile: {
          experience: [],
          education: [{ degree: 'High School', institution: 'Local High School', start: '2015', end: '2019' }],
        },
      },
    });
    expect(eduResult.handoff).toBeUndefined();
    expect(deletedButtons).toEqual(['edu-del-1']);
    expect(eduResult.snapshot.fields).toEqual([]);

    // If a Delete click does not actually remove the incomplete row from the DOM, fail closed instead of returning success.
    const sticky = {
      url: current.url,
      fields: [
        { id: 'exp-title-1', section: 'Work Experience 1', label: 'Job Title*', kind: 'text', required: true, value: 'Role' },
        { id: 'exp-extra-1', section: 'Work Experience 1', label: 'Manager Email*', kind: 'text', required: true, value: '' },
      ],
      buttons: [
        { id: 'exp-add', text: 'Add Another', section: 'Work Experience', disabled: false },
        { id: 'exp-del-sticky', text: 'Delete', section: 'Work Experience 1', disabled: false },
      ],
    };
    current = sticky;
    const stickyResult = await fillProfileSections(makePage() as never, current as never, {
      candidate: {
        profile: {
          experience: [{ role: 'Role', employer: 'Employer', start: '2020-01', end: '2024-01' }],
          education: [],
        },
      },
    });
    expect(stickyResult.handoff).toBe('profile_section_row_fill_failed');
  });
});
