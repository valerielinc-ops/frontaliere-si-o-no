import { describe, expect, it } from 'vitest';
import { buildPatDownAlert } from '../../scripts/ci/alert-pat-down.mjs';

describe('alert-pat-down — segnali strutturati (#6685)', () => {
  it('preserva la descrizione e rende misurabili token vuoto e run', () => {
    const alert = buildPatDownAlert({
      workflow: 'Follow-up drainer',
      runUrl: 'https://github.com/example/repo/actions/runs/42',
    });

    expect(alert.description).toContain('GITHUB_PAT');
    expect(alert.signals).toMatchObject({
      cosa: expect.stringContaining('GITHUB_PAT'),
      metrica: { osservato: 'vuoto', atteso: 'token PAT presente' },
      comando: expect.stringContaining('alert-pat-down.mjs'),
    });
    expect(alert.signals.evidenza).toEqual(expect.arrayContaining([
      'workflow=Follow-up drainer',
      'run=https://github.com/example/repo/actions/runs/42',
    ]));
  });
});
