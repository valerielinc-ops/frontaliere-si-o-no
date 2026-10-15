import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { constPrefix, pascalIdentifier } from '../scripts/lib/crawler-identifier.mjs';
import { scanParserSource } from '../scripts/ci/check-parser-contract.mjs';

const source = fs.readFileSync(
  path.resolve(__dirname, '../scripts/scaffold-crawler.mjs'),
  'utf8',
);

function generatedParser(tier: string) {
  // Execute only the real template construction; never run scaffold writers,
  // manifest registration, logo fetching or generated cron in a test.
  const prefix = source.slice(source.indexOf('const args ='), source.indexOf('/* ── Template: Runner'));
  return vm.runInNewContext(`${prefix}\natsTier === 'workday' ? workdayParserContent : parserContent`, {
    process: { argv: ['node', 'scaffold', 'fixture-employer', '--ats', tier], exit: () => { throw new Error('unexpected scaffold exit'); } },
    fs: { existsSync: () => false }, path, ROOT: '/fixture-only', constPrefix, pascalIdentifier, console,
  }) as string;
}

const CONTRACT_ALIGNED_PARSERS = [
  'sta',
  'stellentreff',
  'stellenpartner',
  'okjob',
  'ete',
  'anker-swiss',
  'accor',
  'gmo',
  'michaelpage',
  'recruitingapp-2649',
  'abbott',
  'alcon',
  'ardian',
  'csl-behring',
  // medtronic: ora un consumatore della factory Workday condivisa, coperta in
  // tests/workday-employment-contract-consistency.test.ts (issue 5253).
  'rituals-cosmetics',
  'stryker',
];

describe('scaffold-crawler — generated contract follows employmentType', () => {
  it('does not emit a hardcoded full-time contract beside a calculated type', () => {
    const generatedJob = source.slice(
      source.indexOf('const employmentType = detectEmploymentType(listing.timeType || title);'),
      source.indexOf('jobs.push(job);', source.indexOf('const employmentType = detectEmploymentType(listing.timeType || title);')),
    );

    expect(generatedJob).toMatch(
      /contract:\s*employmentType === 'PART_TIME'\s*\?\s*'part-time'\s*:\s*employmentType === 'FULL_TIME'\s*\?\s*'full-time'\s*:\s*'other',/,
    );
    expect(generatedJob).toContain('employmentType,');
    expect(generatedJob).not.toContain("contract: 'full-time'");
  });

  it('keeps every contract-aligned parser emission tied to employmentType', () => {
    for (const parser of CONTRACT_ALIGNED_PARSERS) {
      const parserSource = fs.readFileSync(
        path.resolve(__dirname, `../scripts/lib/${parser}-job-parser.mjs`),
        'utf8',
      );

      expect(parserSource, parser).toMatch(
        // The detail's `timeType` may back the listing row's, which the CXS
        // listing endpoint never fills.
        /const employmentType = detectEmploymentType\(listing\.timeType \|\| (?:(?:detailInfo|info)\.timeType \|\| )?(?:title|''\s*,\s*title)\);/,
      );
      expect(parserSource, parser).toContain(
        "contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',",
      );
      expect(parserSource, parser).toContain('employmentType,');
      expect(parserSource, parser).not.toMatch(
        /contract: 'full-time',\n\s+employmentType: detectEmploymentType\(listing\.timeType \|\| title\),/,
      );
    }
  });

  it('genera il ramo prospected senza violazioni R6', () => {
    const generated = generatedParser('prospected');
    const violations = scanParserSource(
      generated,
      'scripts/lib/fixture-employer-job-parser.mjs',
    );

    expect(violations.filter(({ rule }) => rule === 'R6')).toEqual([]);
    expect(generated).toContain('sourceBackedSwissGeographyFields');
    expect(generated).toContain('const sourceGeographyEvidence = {');
    expect(generated).toContain('const resolvedGeography = resolveSourceBackedSwissGeography(listing);');
    expect(generated).toContain('addressRegion,');
    expect(generated).toContain('postalCode,');
    expect(generated).toContain('streetAddress,');
  });

  it('mantiene il ramo non-prospected basato su listing.location e sui campi raw', () => {
    const generated = generatedParser('custom');

    expect(generated).toContain("const location = normalizeSpace(listing.location || '');");
    expect(generated).toContain("const canton = inferSwissTargetCanton(location) || '';");
    expect(generated).toContain(
      'addressLocality: normalizeSpace(listing.addressLocality || location.split(/[,;/|]/)[0]),',
    );
    expect(generated).toContain('addressRegion: normalizeSpace(listing.addressRegion || canton),');
    expect(generated).toContain("addressCountry: normalizeSpace(listing.addressCountry || 'CH'),");
    expect(generated).toContain("country: normalizeSpace(listing.addressCountry || 'CH'),");
    expect(generated).toContain("...(listing.postalCode ? { postalCode: normalizeSpace(listing.postalCode) } : {}),");
    expect(generated).toContain("...(listing.streetAddress ? { streetAddress: normalizeSpace(listing.streetAddress) } : {}),");
    expect(generated).not.toContain('sourceGeographyEvidence');
    expect(generated).not.toContain('sourceBackedSwissGeographyFields');
  });
});
