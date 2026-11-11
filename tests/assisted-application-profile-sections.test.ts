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
});
