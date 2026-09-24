import { describe, expect, it } from 'vitest';
import {
  buildOptOutRepairFields,
  needsOptOutRepair,
} from '../scripts/remediate-binding-newsletter-optouts.mjs';

describe('remediate-binding-newsletter-optouts', () => {
  it('selects a binding opt-out whose status was resurrected', () => {
    const row = {
      status: 'confirmed',
      isActive: true,
      active: true,
      unsubscribed_at: '2026-09-01T10:00:00.000Z',
    };
    expect(needsOptOutRepair(row)).toBe(true);
    expect(buildOptOutRepairFields(row)).toEqual({
      status: 'unsubscribed',
      isActive: false,
      active: false,
      opt_out_integrity_repair_reason: 'binding_opt_out',
    });
  });

  it('does not select a clean suppressed row or an explicit later re-opt-in', () => {
    expect(needsOptOutRepair({
      status: 'unsubscribed',
      isActive: false,
      active: false,
      unsubscribedAt: '2026-09-01T10:00:00.000Z',
    })).toBe(false);
    expect(needsOptOutRepair({
      status: 'confirmed',
      isActive: true,
      active: true,
      unsubscribed_at: '2026-09-01T10:00:00.000Z',
      resubscribed_at: '2026-09-02T10:00:00.000Z',
    })).toBe(false);
  });

  it('repairs stale flags without replacing a hard address suppression', () => {
    const row = {
      status: 'bounced',
      isActive: true,
      active: true,
      unsubscribed_at: '2026-09-01T10:00:00.000Z',
    };
    expect(needsOptOutRepair(row)).toBe(true);
    expect(buildOptOutRepairFields(row).status).toBe('bounced');
  });
});
