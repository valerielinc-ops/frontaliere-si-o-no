import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error — plain .mjs helper, no types
import { buildSequence, selectOutreachMetric } from '../scripts/generate-cold-emails.mjs';

const PERIOD = 'negli ultimi 90 giorni';

describe('cold-email commercial copy', () => {
  it('selects raw apply clicks before the legacy proxy and labels the fallback', () => {
    expect(selectOutreachMetric({ applyClicks: 31, applyClickProxy: 23, candidates: 23 })).toEqual({
      value: 31,
      label: 'click per candidarsi',
      source: 'applyClicks',
    });
    expect(selectOutreachMetric({ applyClickProxy: 23, candidates: 23 })).toEqual({
      value: 23,
      label: 'segnali di interesse',
      source: 'applyClickProxy',
    });
    expect(selectOutreachMetric({ candidates: 23 })).toEqual({
      value: 23,
      label: 'segnali di interesse',
      source: 'candidates',
    });
  });

  it.each([
    '23 persone',
    '23 candidati',
    'candidati inviati',
    'dati reali (annunci, visite, candidati)',
  ])('does not present the outreach proxy as people or applications: %s', (forbiddenPhrase) => {
    const sequence = buildSequence({
      company: 'Acme SA',
      candidates: 23,
      periodLabel: PERIOD,
      contactName: 'Denise Rossi',
      topRole: 'Magazziniere',
    });
    const copy = sequence.map((touch: { subject: string; body: string }) => `${touch.subject}\n${touch.body}`).join('\n');

    expect(copy.toLowerCase()).not.toContain(forbiddenPhrase);
  });

  it('uses raw apply clicks in the generated draft and declares the period', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-a2-copy-'));
    try {
      const reportPath = path.join(tempDir, 'report.json');
      const contactsPath = path.join(tempDir, 'contacts.json');
      const outDir = path.join(tempDir, 'drafts');
      fs.writeFileSync(reportPath, JSON.stringify({
        source: 'posthog',
        days: 90,
        window: { from: '2026-06-12T00:00:00.000Z', to: '2026-09-10T00:00:00.000Z' },
        employers: [{
          key: 'acme-sa',
          name: 'Acme SA',
          candidates: 23,
          applyClickProxy: 23,
          applyClicks: 31,
          clicks: 31,
        }],
      }), 'utf8');
      fs.writeFileSync(contactsPath, '{}', 'utf8');

      const result = spawnSync(process.execPath, [
        'scripts/generate-cold-emails.mjs',
        '--report', reportPath,
        '--contacts', contactsPath,
        '--out', outDir,
        '--top', '1',
        '--min', '1',
        '--days-label', PERIOD,
      ], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const draft = fs.readFileSync(path.join(outDir, '01-acme-sa.md'), 'utf8').toLowerCase();
      expect(draft).toContain(`click per candidarsi (${PERIOD}): **31**`);
      expect(draft).not.toContain('candidati inviati');
      expect(draft).not.toContain('23 persone');
      expect(draft).not.toContain('23 candidati');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
