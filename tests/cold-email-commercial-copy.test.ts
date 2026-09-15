import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildSequence as rawBuildSequence,
  compareOutreachTargets,
  selectOutreachMetric,
} from '../scripts/generate-cold-emails.mjs';
import {
  calendarParts,
  formatItalianPeriodLabel,
} from '../scripts/lib/cold-email-sequence.mjs';

type SequenceArgs = {
  company: string;
  candidates?: number;
  metricValue?: number | null;
  metricLabel?: string;
  periodLabel: string | { from: string; to: string; inclusive?: string; timezone?: string };
  contactName?: string;
  topRole?: string;
};

const buildSequence = rawBuildSequence as unknown as (
  args: SequenceArgs,
) => ReturnType<typeof rawBuildSequence>;

const PERIOD = 'negli ultimi 90 giorni';
const HUMAN_REPORT_WINDOW = 'dal 12 giugno fino al 9 settembre 2026';
const RAW_ISO_PERIOD = '2026-06-10T00:00:00.000Z → 2026-09-08T00:00:00.000Z';
const HUMAN_ISO_PERIOD = "dal 10 giugno fino all'8 settembre 2026";

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
    expect(selectOutreachMetric({ candidates: 23 })).toBeNull();
  });

  it('ranks raw apply clicks before a larger proxy and shares that comparator with sending', () => {
    const ranked = [
      { entry: { key: 'proxy-first', applyClickProxy: 40 }, metric: selectOutreachMetric({ applyClickProxy: 40 }) },
      { entry: { key: 'click-first', applyClicks: 31 }, metric: selectOutreachMetric({ applyClicks: 31 }) },
    ].sort(compareOutreachTargets);

    expect(ranked.map(({ entry }) => entry.key)).toEqual(['click-first', 'proxy-first']);
    expect(fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'scripts/send-cold-emails.mjs'), 'utf8'))
      .toContain('compareOutreachTargets');
    expect(fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'scripts/enrich-employer-contacts.mjs'), 'utf8'))
      .toContain('compareOutreachTargets');
  });

  it('uses the canonical metric labels at both web-UI callsites', () => {
    const root = path.resolve(import.meta.dirname, '..');
    expect(fs.readFileSync(path.join(root, 'functions/src/adminSendColdEmail.js'), 'utf8'))
      .toContain('OUTREACH_METRIC_LABELS.applyClicks');
    expect(fs.readFileSync(path.join(root, 'components/pages/AdminPanel.tsx'), 'utf8'))
      .toContain('OUTREACH_METRIC_LABELS.applyClicks');
  });

  it('uses the proxy when raw apply clicks are zero and keeps an unlabeled metric neutral', () => {
    expect(selectOutreachMetric({ applyClicks: 0, applyClickProxy: 23, candidates: 23 })).toEqual({
      value: 23,
      label: 'segnali di interesse',
      source: 'applyClickProxy',
    });

    const [t1] = buildSequence({
      company: 'Acme SA',
      metricValue: 23,
      metricLabel: 'segnali di interesse',
      periodLabel: PERIOD,
    });
    expect(t1.body).toContain('23 segnali di interesse');
    expect(t1.body).not.toContain('23 click per candidarsi');
  });

  it('does not turn a legacy candidates field into a commercial number', () => {
    const sequence = buildSequence({
      company: 'Acme SA',
      candidates: 23,
      periodLabel: PERIOD,
    });
    const copy = sequence.map((touch: { subject: string; body: string }) => `${touch.subject}\n${touch.body}`).join('\n');

    expect(copy).not.toContain('23 segnali di interesse');
    expect(copy).not.toContain('23 click per candidarsi');
  });

  it('omits an empty touch-2 metric hook when its number or period is unavailable', () => {
    const [, t2] = buildSequence({
      company: 'Acme SA',
      periodLabel: '',
      contactName: 'Denise Rossi',
    });
    expect(t2.body).toContain('Ciao Denise,\n\nCon l\'annuncio sponsorizzato');
    expect(t2.body).not.toContain('Ciao Denise,\n\n\nCon l\'annuncio sponsorizzato');
  });

  it('formats an ISO period for the commercial email and never exposes the raw timestamp', () => {
    const [t1] = buildSequence({
      company: 'Acme SA',
      metricValue: 31,
      metricLabel: 'click per candidarsi',
      periodLabel: RAW_ISO_PERIOD,
    });

    expect(t1.body).toContain(`${HUMAN_ISO_PERIOD} abbiamo registrato 31 click per candidarsi`);
    expect(t1.body).not.toContain(RAW_ISO_PERIOD);
  });

  it('propagates the report timezone and exclusive end into readable copy', () => {
    expect(formatItalianPeriodLabel({
      from: '2026-06-12T00:00:00.000Z',
      to: '2026-09-10T00:00:00.000Z',
      timezone: 'UTC',
      inclusive: '[from,to)',
    }, { strict: true })).toBe(HUMAN_REPORT_WINDOW);
  });

  it('rejects malformed ranges in strict mode and never falls back to UTC without timezone data', () => {
    expect(() => formatItalianPeriodLabel('2026-06-12 → not-a-date', { strict: true }))
      .toThrow(/(?:valid from and to dates|ISO from and to dates)/);
    expect(() => formatItalianPeriodLabel('12 giugno 2026 → 10 settembre 2026', { strict: true }))
      .toThrow(/ISO from and to dates/);
    expect(() => formatItalianPeriodLabel('2026-06-12T00:00:00.000Z', { strict: true }))
      .toThrow(/explicit from\/to range/);
    expect(calendarParts('2026-06-12T00:00:00.000Z', { requireTimeZone: false, timeZone: 'Invalid/Zone' })).toBeNull();
    expect(() => calendarParts('2026-06-12T00:00:00.000Z', { requireTimeZone: true, timeZone: 'Invalid/Zone' }))
      .toThrow(/Unable to resolve calendar date/);
  });

  it('keeps the measurement window in the commercial message', () => {
    const sequence = buildSequence({
      company: 'Acme SA',
      metricValue: 31,
      metricLabel: 'click per candidarsi',
      periodLabel: RAW_ISO_PERIOD,
    });
    const copy = sequence.map((touch: { body: string }) => touch.body).join('\n');

    expect(copy).toContain(HUMAN_ISO_PERIOD);
  });

  it.each([
    '23 persone',
    '23 candidati',
    'candidati inviati',
    'dati reali (annunci, visite, candidati)',
  ])('does not present the outreach proxy as people or applications: %s', (forbiddenPhrase) => {
    const sequence = buildSequence({
      company: 'Acme SA',
      metricValue: 23,
      metricLabel: 'segnali di interesse',
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
        window: {
          from: '2026-06-12T00:00:00.000Z',
          to: '2026-09-10T00:00:00.000Z',
          timezone: 'UTC',
          inclusive: '[from,to)',
        },
        employers: [{
          key: 'proxy-first',
          name: 'Proxy First SA',
          applyClickProxy: 40,
          applyClicks: 5,
        }, {
          key: 'click-first',
          name: 'Click First SA',
          applyClickProxy: 10,
          applyClicks: 31,
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
      expect(fs.existsSync(path.join(outDir, '01-click-first.md'))).toBe(true);
      expect(fs.existsSync(path.join(outDir, '01-proxy-first.md'))).toBe(false);
      const draft = fs.readFileSync(path.join(outDir, '01-click-first.md'), 'utf8').toLowerCase();
      expect(draft).toContain(`click per candidarsi (${HUMAN_REPORT_WINDOW}): **31**`);
      expect(draft).not.toContain('candidati inviati');
      expect(draft).not.toContain('23 persone');
      expect(draft).not.toContain('23 candidati');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses a numeric draft when the report has no explicit window', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-a2-no-window-'));
    try {
      const reportPath = path.join(tempDir, 'report.json');
      const contactsPath = path.join(tempDir, 'contacts.json');
      const outDir = path.join(tempDir, 'drafts');
      fs.writeFileSync(reportPath, JSON.stringify({
        source: 'posthog',
        employers: [{ key: 'unscoped', name: 'Unscoped SA', applyClicks: 31, applyClickProxy: 31 }],
      }), 'utf8');
      fs.writeFileSync(contactsPath, '{}', 'utf8');

      const result = spawnSync(process.execPath, [
        'scripts/generate-cold-emails.mjs',
        '--report', reportPath,
        '--contacts', contactsPath,
        '--out', outDir,
        '--top', '1',
        '--min', '1',
      ], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });

      expect(result.status).not.toBe(0);
      expect(fs.existsSync(outDir)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
