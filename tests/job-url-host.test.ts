// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { jobUrlHost, absoluteJobUrl, canonicalJobHost } from '../scripts/lib/job-url-host.mjs';
import { isIpersonalJob } from '../scripts/lib/ipersonal-job-parser.mjs';
import { isMedIpersonalJob } from '../scripts/lib/med-ipersonal-job-parser.mjs';
import { isRheinmetallAirDefenceJob } from '../scripts/lib/rheinmetall-air-defence-job-parser.mjs';
import { isBreitlingJob } from '../scripts/lib/breitling-job-parser.mjs';
import { isKomaxJob, KOMAX_COMPANY_DOMAIN } from '../scripts/lib/komax-group-job-parser.mjs';
import { RHEINMETALL_AIR_DEFENCE_COMPANY_DOMAIN } from '../scripts/lib/rheinmetall-air-defence-job-parser.mjs';
import { KSGL_COMPANY_DOMAIN } from '../scripts/lib/ksgl-job-parser.mjs';
import { LUPS_COMPANY_DOMAIN } from '../scripts/lib/lups-job-parser.mjs';
import { normalizeSourceHost } from '../scripts/lib/crawler-source-hosts.mjs';
import { normalizeHost } from '../scripts/lib/prospector/registrable.mjs';

const jobUrlHostSource = readFileSync(resolve(__dirname, '../scripts/lib/job-url-host.mjs'), 'utf8');

describe('job-url-host browser boundary', () => {
  it('does not import the Node-only URL module', () => {
    expect(jobUrlHostSource).not.toMatch(/['"]node:url['"]/);
  });
});

describe('jobUrlHost', () => {
  it('reads the host of a scheme-less URL instead of throwing', () => {
    // `new URL('med-ipersonal.ch/jobs/1')` is a TypeError: every caller that
    // wrapped it in a try/catch returning false dropped the row (#7721).
    expect(jobUrlHost('med-ipersonal.ch/jobs/1')).toBe('med-ipersonal.ch');
    expect(jobUrlHost('//med-ipersonal.ch/jobs/1')).toBe('med-ipersonal.ch');
    expect(jobUrlHost('WWW.Med-Ipersonal.CH/jobs/1')).toBe('www.med-ipersonal.ch');
  });

  it('reads the host of a scheme-less URL that carries a port', () => {
    // `-` and `.` are legal scheme characters, so the scheme test matched
    // `med-ipersonal.ch:8080/...` too and `new URL()` read it as the protocol
    // `med-ipersonal.ch:` with an empty hostname — the row stayed dropped.
    expect(jobUrlHost('med-ipersonal.ch:8080/jobs/1')).toBe('med-ipersonal.ch');
    expect(jobUrlHost('med-ipersonal.ch:8080')).toBe('med-ipersonal.ch');
    expect(jobUrlHost('https://med-ipersonal.ch:8080/jobs/1')).toBe('med-ipersonal.ch');
    // Exactness survives the port form too.
    expect(jobUrlHost('evil.com:8080/med-ipersonal.ch')).toBe('evil.com');
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
    // Same, when the opaque part starts with a digit: the port-authority test
    // must not disarm the scheme guard here, or the prepend turns the local
    // part into userinfo and invents `med-ipersonal.ch` out of a mailto.
    expect(jobUrlHost('mailto:24h@med-ipersonal.ch')).toBe('');
    // `tel:0041` has a port-SHAPED opaque part (4 digits, in range) but no
    // dotted authority, so it must stay host-less rather than become
    // `https://tel:0041` → `tel`. The 13-digit form below is the same claim,
    // not a stronger one: it would also be caught by the out-of-range port.
    expect(jobUrlHost('tel:0041')).toBe('');
    expect(jobUrlHost('tel:0041791234567')).toBe('');
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

  it('claims a scheme-less row that carries a port, and only the owner does', () => {
    expect(isIpersonalJob({ url: 'med-ipersonal.ch:8080/jobs/1' })).toBe(true);
    expect(isMedIpersonalJob({ url: 'med-ipersonal.ch:8080/jobs/1' })).toBe(false);
    expect(isBreitlingJob({ url: 'careers.breitling.com:8443/job/1' })).toBe(true);
    expect(isBreitlingJob({ url: 'evil.com:8443/www.breitling.com' })).toBe(false);
  });
});

describe('absoluteJobUrl', () => {
  it('rewrites a scheme-less URL to its absolute form', () => {
    // A row claimed by #7721/#7758 but persisted scheme-less is a broken apply
    // CTA (`href` resolves relative to frontaliereticino.ch) and a liveness
    // probe that fails on the shape instead of on the listing.
    expect(absoluteJobUrl('med-ipersonal.ch/jobs/1')).toBe('https://med-ipersonal.ch/jobs/1');
    expect(absoluteJobUrl('med-ipersonal.ch:8080/jobs/1')).toBe('https://med-ipersonal.ch:8080/jobs/1');
    expect(absoluteJobUrl('//med-ipersonal.ch/jobs/1')).toBe('https://med-ipersonal.ch/jobs/1');
    expect(absoluteJobUrl('  med-ipersonal.ch/jobs/1  ')).toBe('https://med-ipersonal.ch/jobs/1');
  });

  it('leaves a URL that already carries a scheme untouched', () => {
    expect(absoluteJobUrl('https://med-ipersonal.ch/jobs/1')).toBe('https://med-ipersonal.ch/jobs/1');
    expect(absoluteJobUrl('http://med-ipersonal.ch/jobs/1')).toBe('http://med-ipersonal.ch/jobs/1');
    // Never invent a host that was not there.
    expect(absoluteJobUrl('mailto:jobs@med-ipersonal.ch')).toBe('mailto:jobs@med-ipersonal.ch');
    expect(absoluteJobUrl('tel:0041')).toBe('tel:0041');
  });

  it('returns the input untouched when no absolute form can be derived', () => {
    expect(absoluteJobUrl('')).toBe('');
    expect(absoluteJobUrl('   ')).toBe('');
    expect(absoluteJobUrl(undefined)).toBe('');
  });

  it('never turns a relative path into an invented host', () => {
    // `https://${anything}` parses, so "it parses" is not a guard: without the
    // authority-shape check these are persisted as the apply CTA and fetched
    // by the liveness probe as `https://en/jobs/123` / `https://jobs/1`.
    expect(absoluteJobUrl('/en/jobs/123')).toBe('/en/jobs/123');
    expect(absoluteJobUrl('jobs/1')).toBe('jobs/1');
    expect(absoluteJobUrl('/careers.html')).toBe('/careers.html');
    expect(absoluteJobUrl('offerte')).toBe('offerte');
    expect(jobUrlHost('/en/jobs/123')).toBe('');
    expect(jobUrlHost('jobs/1')).toBe('');
  });

  it('agrees with jobUrlHost on the authority it exposes', () => {
    for (const raw of ['med-ipersonal.ch/jobs/1', 'evil.com:8080/med-ipersonal.ch', 'https://med-ipersonal.ch.evil.com/x']) {
      expect(new URL(absoluteJobUrl(raw)).hostname.toLowerCase()).toBe(jobUrlHost(raw));
    }
  });
});

describe('canonicalJobHost', () => {
  it('puts an IDN host and its punycode spelling on one key', () => {
    // `new URL()` punycodes the authority, so a host that arrives written in
    // unicode and the same host read back out of a parsed URL were two
    // different strings for every `===`/`Set.has` comparison downstream.
    expect(canonicalJobHost('münchen-jobs.ch')).toBe('xn--mnchen-jobs-thb.ch');
    expect(canonicalJobHost('xn--mnchen-jobs-thb.ch')).toBe('xn--mnchen-jobs-thb.ch');
    expect(canonicalJobHost('MÜNCHEN-jobs.CH.')).toBe('xn--mnchen-jobs-thb.ch');
  });

  it('does not truncate a raw host identity into a trusted hostname', () => {
    expect(canonicalJobHost('evil.com/med-ipersonal.ch')).toBe('evil.com/med-ipersonal.ch');
    expect(canonicalJobHost('evil.com\\med-ipersonal.ch')).toBe('evil.com\\med-ipersonal.ch');
    expect(canonicalJobHost('x@med-ipersonal.ch')).toBe('x@med-ipersonal.ch');
    expect(canonicalJobHost('med-ipersonal.ch:8080')).toBe('med-ipersonal.ch:8080');
  });

  it.each(['%2F', '%40', '%3A', '%5C'])('does not decode an authority delimiter %s into a trusted host', (encoded) => {
    const raw = `evil.com${encoded}med-ipersonal.ch`;
    expect(canonicalJobHost(raw)).toBe(raw.toLowerCase());
  });

  it('keeps the raw spelling when the host cannot be mapped', () => {
    // `domainToASCII` answers '' on an unmappable host. That is a rejection,
    // not a canonical form: collapsing to '' would make two unrelated bad
    // hosts compare EQUAL to each other.
    expect(canonicalJobHost('a..b')).toBe('a..b');
    expect(canonicalJobHost('')).toBe('');
    expect(canonicalJobHost('  ')).toBe('');
  });

  it('leaves every host constant the parsers compare against untouched', () => {
    // The constant side of those comparisons is only safe while it is already
    // canonical; a constant added in unicode would match nothing, silently.
    for (const domain of [
      KOMAX_COMPANY_DOMAIN,
      RHEINMETALL_AIR_DEFENCE_COMPANY_DOMAIN,
      KSGL_COMPANY_DOMAIN,
      LUPS_COMPANY_DOMAIN,
      'med-ipersonal.ch',
      'ohws.prospective.ch',
    ]) {
      expect(canonicalJobHost(domain)).toBe(domain);
    }
  });
});

describe('IDN hosts across the host normalisers', () => {
  it('normalises a bare host with a backslash separator before extracting the registrable name', () => {
    expect(normalizeHost('evil.com\\med-ipersonal.ch')).toBe('evil.com');
  });

  it('claims a scheme-less IDN row instead of dropping it for its alphabet', () => {
    // The authority shape was ASCII-only, so a scheme-less unicode host looked
    // like a bare path, stayed untouched and answered '' — the #7758 drop, in
    // the form that carries an umlaut.
    expect(absoluteJobUrl('zürich-spital.ch/stelle/1')).toBe('https://zürich-spital.ch/stelle/1');
    expect(absoluteJobUrl('//zürich-spital.ch/stelle/1')).toBe('https://zürich-spital.ch/stelle/1');
    expect(absoluteJobUrl('zürich-spital.ch:8080/stelle/1')).toBe('https://zürich-spital.ch:8080/stelle/1');
    expect(jobUrlHost('zürich-spital.ch/stelle/1')).toBe('xn--zrich-spital-dlb.ch');
    expect(jobUrlHost('zürich-spital.ch:8080/stelle/1')).toBe('xn--zrich-spital-dlb.ch');
    expect(jobUrlHost('https://zürich-spital.ch/stelle/1')).toBe('xn--zrich-spital-dlb.ch');
  });

  it('gives one identity to a host scraped as text and the same host parsed', () => {
    // `crawler-source-hosts` feeds `normalizeSourceHost` from BOTH a raw-text
    // regex over the slice JSON and `new URL().hostname`: two spellings would
    // split one front door into two owners.
    expect(normalizeSourceHost('www.zürich-spital.ch:8443')).toBe('xn--zrich-spital-dlb.ch');
    expect(normalizeSourceHost(new URL('https://www.zürich-spital.ch/x').hostname)).toBe(
      'xn--zrich-spital-dlb.ch',
    );
    expect(normalizeHost('https://zürich-spital.ch/x')).toBe(normalizeHost('zürich-spital.ch'));
  });
});
