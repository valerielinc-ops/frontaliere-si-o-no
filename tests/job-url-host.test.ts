// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { jobUrlHost } from '../scripts/lib/job-url-host.mjs';
import { isIpersonalJob } from '../scripts/lib/ipersonal-job-parser.mjs';
import { isMedIpersonalJob } from '../scripts/lib/med-ipersonal-job-parser.mjs';
import { isRheinmetallAirDefenceJob } from '../scripts/lib/rheinmetall-air-defence-job-parser.mjs';
import { isBreitlingJob } from '../scripts/lib/breitling-job-parser.mjs';
import { isKomaxJob } from '../scripts/lib/komax-group-job-parser.mjs';

describe('jobUrlHost', () => {
  it('reads the host of a scheme-less URL instead of throwing', () => {
    // `new URL('med-ipersonal.ch/jobs/1')` is a TypeError: every caller that
    // wrapped it in a try/catch returning false dropped the row (#7721).
    expect(jobUrlHost('med-ipersonal.ch/jobs/1')).toBe('med-ipersonal.ch');
    expect(jobUrlHost('//med-ipersonal.ch/jobs/1')).toBe('med-ipersonal.ch');
    expect(jobUrlHost('WWW.Med-Ipersonal.CH/jobs/1')).toBe('www.med-ipersonal.ch');
  });

  it('keeps the host exact — a look-alike host in the path is not the host', () => {
    // The property #7474 established, which normalizing the scheme must not undo.
    expect(jobUrlHost('https://evil.com/med-ipersonal.ch')).toBe('evil.com');
    expect(jobUrlHost('evil.com/med-ipersonal.ch')).toBe('evil.com');
    expect(jobUrlHost('https://med-ipersonal.ch.evil.com/x')).toBe('med-ipersonal.ch.evil.com');
  });

  it('never invents a host', () => {
    expect(jobUrlHost('')).toBe('');
    expect(jobUrlHost(undefined)).toBe('');
    // A scheme that carries no authority stays authority-less.
    expect(jobUrlHost('mailto:jobs@med-ipersonal.ch')).toBe('');
  });
});

describe('keyless fallback with a scheme-less URL', () => {
  it('lets the owning parser claim its own scheme-less row, and only it', () => {
    const medipersonalRow = { url: 'med-ipersonal.ch/jobs/1' };
    expect(isIpersonalJob(medipersonalRow)).toBe(true);
    expect(isMedIpersonalJob(medipersonalRow)).toBe(false);

    const ipersonalRow = { url: 'ipersonal.ch/jobs/1' };
    expect(isMedIpersonalJob(ipersonalRow)).toBe(true);
    expect(isIpersonalJob(ipersonalRow)).toBe(false);
  });

  it('still refuses a foreign host that merely quotes the domain in its path', () => {
    for (const url of [
      'https://evil.com/med-ipersonal.ch',
      'evil.com/med-ipersonal.ch',
      'https://evil.com/ipersonal.ch',
      'evil.com/ipersonal.ch',
    ]) {
      expect(isIpersonalJob({ url })).toBe(false);
      expect(isMedIpersonalJob({ url })).toBe(false);
    }
  });

  it('does not let the host override a declared companyKey', () => {
    // #7570's invariant: a row that declares its owner belongs to it and to no other.
    expect(isIpersonalJob({ companyKey: 'med-ipersonal', url: 'https://med-ipersonal.ch/x' })).toBe(false);
    expect(isMedIpersonalJob({ companyKey: 'ipersonal', url: 'https://ipersonal.ch/x' })).toBe(false);
  });

  it('applies to every parser that derives the host in its keyless matcher', () => {
    // Same construct, same class of bug (AGENTS.md #6).
    expect(
      isRheinmetallAirDefenceJob({
        company: 'Rheinmetall Air Defence AG (Zürich)',
        url: 'www.rheinmetall.com/en/career/vacancies/1',
      }),
    ).toBe(true);
    expect(
      isRheinmetallAirDefenceJob({
        company: 'Rheinmetall Air Defence AG (Zürich)',
        url: 'evil.com/www.rheinmetall.com',
      }),
    ).toBe(false);

    expect(isBreitlingJob({ url: 'careers.breitling.com/job/1' })).toBe(true);
    expect(isBreitlingJob({ url: 'evil.com/www.breitling.com' })).toBe(false);

    expect(isKomaxJob({ url: 'jobs.komaxgroup.com/1' })).toBe(true);
    expect(isKomaxJob({ url: 'evil.com/komaxgroup.com' })).toBe(false);
  });
});
