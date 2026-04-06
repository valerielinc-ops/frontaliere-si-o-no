import { describe, expect, it } from 'vitest';

import { stripEmsChemieTitleSuffix, buildJob } from '../scripts/lib/ems-chemie-job-parser.mjs';

/**
 * The EMS career portal appends a " | <Location> | EMS-CHEMIE AG <Location>"
 * suffix (and a sister " | <Location> | EFTEC AG <Location>" suffix on the
 * subsidiary) to every job title. If we slug-build from the raw title, the
 * suffix leaks into the slug as `…-ems-chemie-ag-domat-ems`, then the build
 * appends its own company suffix and produces a doubled
 * `…-ems-chemie-ag-domat-ems-ems-chemie-ag-domat-ems` slug. The validator
 * catches that as a `german_slug_in_it` warning.
 *
 * `stripEmsChemieTitleSuffix()` runs inside `buildJob()` so the slug is
 * always built from the clean role name only.
 */
describe('stripEmsChemieTitleSuffix', () => {
  it('strips the EMS-CHEMIE AG location suffix', () => {
    const input = 'Leiter Controlling | Domat/Ems | EMS-CHEMIE AG Domat/Ems';
    expect(stripEmsChemieTitleSuffix(input)).toBe('Leiter Controlling');
  });

  it('strips the EFTEC AG subsidiary suffix', () => {
    const input = 'Transportdisponent / Sachbearbeiter Export 100% (m/w) 100% | Romanshorn | EFTEC AG Romanshorn';
    expect(stripEmsChemieTitleSuffix(input)).toBe('Transportdisponent / Sachbearbeiter Export 100% (m/w) 100%');
  });

  it('is a no-op for clean titles', () => {
    expect(stripEmsChemieTitleSuffix('Leiter Controlling')).toBe('Leiter Controlling');
  });

  it('handles empty / nullish input safely', () => {
    expect(stripEmsChemieTitleSuffix('')).toBe('');
    expect(stripEmsChemieTitleSuffix(undefined as unknown as string)).toBe('');
  });

  it('is idempotent', () => {
    const input = 'Leiter Finanzbuchhaltung (m/w/d) 100% | Domat/Ems | EMS-CHEMIE AG Domat/Ems';
    const once = stripEmsChemieTitleSuffix(input);
    const twice = stripEmsChemieTitleSuffix(once);
    expect(twice).toBe(once);
    expect(once).toBe('Leiter Finanzbuchhaltung (m/w/d) 100%');
  });
});

describe('buildJob — slug excludes title suffix', () => {
  it('builds a clean slug from a portal title with the EMS suffix', () => {
    const job = buildJob({
      title: 'Leiter Controlling (m/w/d) 100% | Domat/Ems | EMS-CHEMIE AG Domat/Ems',
      location: 'Domat/Ems',
      url: 'https://jobs.ems-group.com/job/leiter-controlling',
    });
    expect(job).not.toBeNull();
    expect(job!.title).toBe('Leiter Controlling (m/w/d) 100%');
    // The slug must NOT contain the doubled `ems-chemie-ag-domat-ems` segment
    // that the bug produced before the suffix-stripping fix.
    expect(job!.slug).not.toContain('ems-chemie-ag-domat-ems-ems-chemie');
    expect(job!.slugByLocale.it).not.toContain('ems-chemie-ag-domat-ems-ems-chemie');
  });
});
