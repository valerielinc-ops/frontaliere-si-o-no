import { describe, it, expect } from 'vitest';

import { shouldSync } from '../scripts/sync-main-checkout.mjs';

// Regressione dell'incidente 2026-08-24: il checkout base è rimasto parcheggiato
// su un branch-sonda per 3 giorni, e ogni sessione aperta dalla root ha rotto il
// proprio Stop hook (MODULE_NOT_FOUND) quando main ha guadagnato un file che
// quel checkout non aveva. Fail-safe: sincronizza SOLO su main pulito.

describe('shouldSync', () => {
  it('sincronizza quando il checkout è su main e pulito', () => {
    expect(shouldSync({ branch: 'main', dirty: '' })).toBe(true);
  });

  it('non tocca un branch diverso da main', () => {
    expect(shouldSync({ branch: 'zz-probe-echo', dirty: '' })).toBe(false);
    expect(shouldSync({ branch: null, dirty: '' })).toBe(false);
  });

  it('non tocca un checkout sporco (foreign work tollerato da AGENTS.md)', () => {
    expect(shouldSync({ branch: 'main', dirty: ' M data/jobs/foo.json' })).toBe(false);
  });

  it('fail-safe se lo stato non è leggibile', () => {
    expect(shouldSync({ branch: 'main', dirty: null })).toBe(false);
  });
});
