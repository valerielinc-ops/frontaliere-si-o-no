import { describe, expect, it } from 'vitest';
import { stageRcParam } from '../scripts/lib/remote-config-admin.mjs';

describe('stageRcParam', () => {
  it('keeps the conditional values of an existing parameter', () => {
    const conditionalValues = { client_mask: { useInAppDefault: true } };
    const template = { parameters: { FLAG: { defaultValue: { value: 'old' }, valueType: 'STRING', conditionalValues } } };
    expect(stageRcParam(template, 'FLAG', 'new', 'd')).toBe(true);
    expect(template.parameters.FLAG).toEqual({
      defaultValue: { value: 'new' }, valueType: 'STRING', description: 'd', conditionalValues,
    });
  });

  it('creates a missing parameter and skips an unchanged one', () => {
    const template = { parameters: {} } as { parameters: Record<string, unknown> };
    expect(stageRcParam(template, 'FLAG', 'v', 'd')).toBe(true);
    expect(template.parameters.FLAG).toEqual({ defaultValue: { value: 'v' }, valueType: 'STRING', description: 'd' });
    expect(stageRcParam(template, 'FLAG', 'v', 'd')).toBe(false);
  });
});
