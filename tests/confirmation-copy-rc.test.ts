/**
 * scripts/experiments/confirmation-copy-rc.mjs — the Remote Config switch of
 * the confirmation-copy experiment (#6317).
 *
 * What is pinned here is the part an operator relies on at 2 a.m.: a typo is
 * refused instead of being clamped, only the rollout key is ever staged, the
 * two template shapes the Cloud Function would not read as written are
 * refused, and the post-publish comparison names keys without ever printing a
 * value (the same template carries the project's secrets).
 */
import { describe, expect, it } from 'vitest';
import {
  buildRolloutValue,
  diffTemplateKeyNames,
  parseArgs,
  stageRolloutValue,
} from '../scripts/experiments/confirmation-copy-rc.mjs';
import {
  CONFIRMATION_COPY_ROLLOUT_RC_KEY,
  readConfirmationCopyConfig,
} from '../functions/src/lib/confirmationCopyExperiment.js';

const KEY = CONFIRMATION_COPY_ROLLOUT_RC_KEY;
const SECRET = 'VALUE-THAT-MUST-NEVER-BE-PRINTED';

function templateWith(parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    parameters: { OTHER_SECRET: { defaultValue: { value: SECRET }, valueType: 'STRING' }, ...parameters },
    parameterGroups: {},
    conditions: [],
    ...extra,
  };
}

describe('parseArgs', () => {
  it('is a dry-run without --apply and has no default rollout', () => {
    expect(parseArgs([])).toEqual({ apply: false, rollout: null });
    expect(parseArgs(['--rollout', '0.5'])).toEqual({ apply: false, rollout: '0.5' });
  });

  it('--kill is rollout 0, and --dry-run wins back over an earlier --apply', () => {
    expect(parseArgs(['--kill', '--apply'])).toEqual({ apply: true, rollout: '0' });
    expect(parseArgs(['--apply', '--rollout', '1', '--dry-run'])).toEqual({ apply: false, rollout: '1' });
  });

  it('refuses an unknown flag and a flag without its value', () => {
    expect(() => parseArgs(['--force'])).toThrow(/unknown argument --force/);
    expect(() => parseArgs(['--rollout'])).toThrow(/--rollout needs a value/);
  });
});

describe('buildRolloutValue', () => {
  it('returns the canonical string for the values the experiment uses', () => {
    expect(buildRolloutValue({ rollout: '0' })).toBe('0');
    expect(buildRolloutValue({ rollout: '0.5' })).toBe('0.5');
    expect(buildRolloutValue({ rollout: ' 1 ' })).toBe('1');
    expect(buildRolloutValue({ rollout: '0.50' })).toBe('0.5');
  });

  it('refuses instead of clamping: the function would silently read these as 0 or 1', () => {
    for (const rollout of ['1.5', '-0.1', '50', 'abc', '0,5', 'NaN', 'Infinity']) {
      expect(() => buildRolloutValue({ rollout }), rollout).toThrow(/between 0 and 1/);
    }
  });

  it('refuses a missing value: there is no implicit launch configuration', () => {
    for (const rollout of [null, undefined, '', '   ']) {
      expect(() => buildRolloutValue({ rollout }), String(rollout)).toThrow(/--rollout <0\.\.1> or --kill/);
    }
  });

  it('every accepted value is read back unchanged by the function parser', () => {
    for (const rollout of ['0', '0.1', '0.25', '0.5', '0.75', '1']) {
      const value = buildRolloutValue({ rollout });
      expect(readConfirmationCopyConfig({ [KEY]: value }).rollout).toBe(Number(rollout));
    }
  });
});

describe('stageRolloutValue', () => {
  it('adds the key when it is absent and leaves every other parameter untouched', () => {
    const template = templateWith();
    const before = JSON.stringify(template.parameters.OTHER_SECRET);
    expect(stageRolloutValue(template, '0.5')).toEqual({ key: KEY, before: null, after: '0.5', changed: true });
    expect(template.parameters[KEY]).toMatchObject({ defaultValue: { value: '0.5' }, valueType: 'STRING' });
    expect(String((template.parameters[KEY] as { description: string }).description)).toContain('#6317');
    expect(JSON.stringify(template.parameters.OTHER_SECRET)).toBe(before);
    expect(Object.keys(template.parameters).sort()).toEqual([KEY, 'OTHER_SECRET'].sort());
  });

  it('is a no-op when the key already holds the value', () => {
    const existing = { defaultValue: { value: '0.5' }, valueType: 'STRING', description: 'kept' };
    const template = templateWith({ [KEY]: existing });
    expect(stageRolloutValue(template, '0.5')).toEqual({ key: KEY, before: '0.5', after: '0.5', changed: false });
    expect(template.parameters[KEY]).toBe(existing);
  });

  it('the kill switch overwrites the value and keeps the existing description and type', () => {
    const template = templateWith({ [KEY]: { defaultValue: { value: '0.5' }, valueType: 'STRING', description: 'kept' } });
    expect(stageRolloutValue(template, '0')).toEqual({ key: KEY, before: '0.5', after: '0', changed: true });
    expect(template.parameters[KEY]).toEqual({ defaultValue: { value: '0' }, valueType: 'STRING', description: 'kept' });
  });

  it('refuses a copy of the key inside a parameter group: the function reads top-level parameters only', () => {
    const template = templateWith({}, { parameterGroups: { Experiments: { parameters: { [KEY]: { defaultValue: { value: '1' } } } } } });
    expect(() => stageRolloutValue(template, '0.5')).toThrow(/parameter group "Experiments"/);
    expect(template.parameters[KEY]).toBeUndefined();
  });

  it('refuses a key with conditional values: the function reads the default value only', () => {
    const template = templateWith({
      [KEY]: { defaultValue: { value: '0' }, conditionalValues: { ios: { value: '1' } } },
    });
    expect(() => stageRolloutValue(template, '0.5')).toThrow(/conditional values/);
    expect((template.parameters[KEY] as { defaultValue: { value: string } }).defaultValue.value).toBe('0');
  });
});

describe('diffTemplateKeyNames', () => {
  it('reports the rollout key as the single difference, by name', () => {
    const before = templateWith();
    const after = templateWith({ [KEY]: { defaultValue: { value: '0.5' }, valueType: 'STRING' } });
    expect(diffTemplateKeyNames(before, after)).toEqual({
      added: [KEY],
      removed: [],
      changed: [],
      parameterGroupsChanged: false,
      conditionsChanged: false,
      onlyExpected: true,
    });
  });

  it('a change of the rollout value alone is still the expected difference', () => {
    const before = templateWith({ [KEY]: { defaultValue: { value: '0.5' } } });
    const after = templateWith({ [KEY]: { defaultValue: { value: '0' } } });
    expect(diffTemplateKeyNames(before, after)).toMatchObject({ added: [], changed: [KEY], onlyExpected: true });
  });

  it('flags any other difference: another key, a removal, groups or conditions', () => {
    const base = templateWith({ [KEY]: { defaultValue: { value: '0' } } });
    const rolled = { [KEY]: { defaultValue: { value: '0.5' } } };
    const otherChanged = templateWith({ ...rolled, OTHER_SECRET: { defaultValue: { value: 'rotated' } } });
    expect(diffTemplateKeyNames(base, otherChanged)).toMatchObject({ changed: [KEY, 'OTHER_SECRET'].sort(), onlyExpected: false });

    const removed = { parameters: rolled, parameterGroups: {}, conditions: [] };
    expect(diffTemplateKeyNames(base, removed)).toMatchObject({ removed: ['OTHER_SECRET'], onlyExpected: false });

    const groups = templateWith(rolled, { parameterGroups: { New: { parameters: {} } } });
    expect(diffTemplateKeyNames(base, groups)).toMatchObject({ parameterGroupsChanged: true, onlyExpected: false });

    const conditions = templateWith(rolled, { conditions: [{ name: 'ios', expression: "device.os == 'ios'" }] });
    expect(diffTemplateKeyNames(base, conditions)).toMatchObject({ conditionsChanged: true, onlyExpected: false });
  });

  it('a publish that changed nothing, or only another key, is not the expected difference', () => {
    const same = templateWith({ [KEY]: { defaultValue: { value: '0.5' } } });
    expect(diffTemplateKeyNames(same, templateWith({ [KEY]: { defaultValue: { value: '0.5' } } })).onlyExpected).toBe(false);
    const onlyOther = templateWith({ [KEY]: { defaultValue: { value: '0.5' } }, OTHER_SECRET: { defaultValue: { value: 'rotated' } } });
    expect(diffTemplateKeyNames(same, onlyOther)).toMatchObject({ changed: ['OTHER_SECRET'], onlyExpected: false });
  });

  it('never carries a parameter value, whatever changed', () => {
    const before = templateWith({ [KEY]: { defaultValue: { value: '0' } } });
    const after = templateWith({
      [KEY]: { defaultValue: { value: '0.5' } },
      OTHER_SECRET: { defaultValue: { value: `${SECRET}-rotated` } },
      ADDED_SECRET: { defaultValue: { value: SECRET } },
    });
    const printed = JSON.stringify(diffTemplateKeyNames(before, after));
    expect(printed).not.toContain(SECRET);
    expect(printed).toContain('ADDED_SECRET');
  });
});
