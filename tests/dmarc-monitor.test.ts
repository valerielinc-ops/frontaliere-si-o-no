import { describe, it, expect } from 'vitest';
import { analyze, isKnown, nextEnforcementStep } from '../scripts/dmarc-monitor.mjs';

// Helper: build a GraphQL-shaped source row.
function row(sourceOrgName: string, total: number, dmarc: number, sourceIP = '1.2.3.4') {
  return {
    dimensions: { sourceOrgName, headerFrom: 'frontaliereticino.ch', sourceIP, spf: 'pass', dkim: 'pass', disposition: 'none' },
    sum: { totalMatchingMessages: total, dmarc, spfPass: dmarc, dkimPass: dmarc },
  };
}

describe('dmarc-monitor', () => {
  describe('isKnown', () => {
    it('matches expected senders case-insensitively as substrings', () => {
      expect(isKnown('MAILJET SAS')).toBe(true);
      expect(isKnown('Amazon.com, Inc.')).toBe(true);
      expect(isKnown('The Constant Company, LLC')).toBe(true);
      expect(isKnown('Google LLC')).toBe(true);
    });
    it('flags orgs not in the allowlist as unknown', () => {
      expect(isKnown('Equinix (EMEA) Acquisition Enterprises B.V.')).toBe(false);
      expect(isKnown('Random Hosting GmbH')).toBe(false);
      expect(isKnown('')).toBe(false);
      expect(isKnown(undefined as unknown as string)).toBe(false);
    });
  });

  describe('analyze', () => {
    it('aggregates multiple rows of the same org', () => {
      const a = analyze([row('MAILJET SAS', 300, 300), row('MAILJET SAS', 200, 200)]);
      const mailjet = a.sources.find((s) => s.org === 'MAILJET SAS')!;
      expect(mailjet.total).toBe(500);
      expect(mailjet.pass).toBe(500);
      expect(mailjet.fail).toBe(0);
    });

    it('marks the domain READY when all legit traffic passes and a lone fail is below the volume floor', () => {
      // Mirrors the real production snapshot: 889 msgs, 1 isolated failure.
      const a = analyze([
        row('MAILJET SAS', 582, 582),
        row('Amazon.com, Inc.', 216, 216),
        row('The Constant Company, LLC', 89, 89),
        row('Equinix (EMEA) Acquisition Enterprises B.V.', 1, 0),
        row('Google LLC', 1, 1),
      ]);
      expect(a.total).toBe(889);
      expect(a.totalFail).toBe(1);
      expect(a.failingSources).toHaveLength(0);
      expect(a.ready).toBe(true);
    });

    it('raises a failing source when one exceeds the volume floor, and is NOT ready', () => {
      const a = analyze([
        row('MAILJET SAS', 500, 500),
        row('Sketchy Spoofer Ltd', 50, 0, '9.9.9.9'), // 50 fails > floor (20)
      ]);
      expect(a.failingSources).toHaveLength(1);
      const bad = a.failingSources[0];
      expect(bad.org).toBe('Sketchy Spoofer Ltd');
      expect(bad.known).toBe(false);
      expect(bad.fail).toBe(50);
      expect(bad.topFailIP).toBe('9.9.9.9');
      expect(a.ready).toBe(false);
    });

    it('flags a KNOWN sender too when it fails in volume (misconfig, would break under enforcement)', () => {
      const a = analyze([
        row('MAILJET SAS', 500, 500),
        row('Amazon.com, Inc.', 80, 40), // 40 fails > floor
      ]);
      const failing = a.failingSources.find((s) => s.org === 'Amazon.com, Inc.')!;
      expect(failing).toBeTruthy();
      expect(failing.known).toBe(true);
      expect(a.ready).toBe(false);
    });

    it('is not ready when the total sample is too small even with a clean pass rate', () => {
      const a = analyze([row('MAILJET SAS', 10, 10)]); // below READY_MIN_TOTAL (50)
      expect(a.totalFail).toBe(0);
      expect(a.failingSources).toHaveLength(0);
      expect(a.ready).toBe(false);
    });

    it('handles an empty window without throwing', () => {
      const a = analyze([]);
      expect(a.total).toBe(0);
      expect(a.ready).toBe(false);
      expect(a.failingSources).toHaveLength(0);
    });
  });

  describe('nextEnforcementStep', () => {
    const readyClean = analyze([
      row('MAILJET SAS', 582, 582),
      row('Amazon.com, Inc.', 216, 216),
      row('The Constant Company, LLC', 89, 89),
    ]);
    const notReady = analyze([
      row('MAILJET SAS', 500, 500),
      row('Sketchy Spoofer Ltd', 50, 0),
    ]);

    it('suggests quarantine when clean and currently at p=none', () => {
      expect(nextEnforcementStep('none', readyClean)).toBe('quarantine');
    });
    it('suggests reject when clean and currently at p=quarantine', () => {
      expect(nextEnforcementStep('quarantine', readyClean)).toBe('reject');
    });
    it('suggests nothing at p=reject (already fully protected)', () => {
      expect(nextEnforcementStep('reject', readyClean)).toBeNull();
    });
    it('suggests nothing when the policy could not be read (null)', () => {
      // Guards against nagging "move to quarantine" off a guessed policy.
      expect(nextEnforcementStep(null, readyClean)).toBeNull();
    });
    it('suggests nothing when not ready, regardless of policy', () => {
      expect(nextEnforcementStep('none', notReady)).toBeNull();
      expect(nextEnforcementStep('quarantine', notReady)).toBeNull();
    });
  });
});
