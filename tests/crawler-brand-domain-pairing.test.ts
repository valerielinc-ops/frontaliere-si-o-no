// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IPERSONAL_KEY,
  IPERSONAL_COMPANY_NAME,
  IPERSONAL_COMPANY_DOMAIN,
  isIpersonalJob,
} from '../scripts/lib/ipersonal-job-parser.mjs';
import {
  MED_IPERSONAL_KEY,
  MED_IPERSONAL_COMPANY_NAME,
  MED_IPERSONAL_COMPANY_DOMAIN,
  isMedIpersonalJob,
} from '../scripts/lib/med-ipersonal-job-parser.mjs';

const PARSER_DIR = join(process.cwd(), 'scripts', 'lib');

/**
 * The brand a host actually publishes, verified against the live sources on
 * 2026-09-05: med-ipersonal.ch is the nursing temp agency "MediPersonal",
 * www.ipersonal.ch is the generalist "iPersonal AG". The two crawler keys are
 * named after each other's host, which is how the labels got crossed (#7474):
 * pinning the table here makes a re-swap impossible by construction.
 */
const BRAND_BY_DOMAIN: Record<string, string> = {
  'med-ipersonal.ch': 'MediPersonal',
  'ipersonal.ch': 'iPersonal AG',
};

/**
 * Tokens that carry no brand identity of their own: legal forms and the
 * connectives that survive folding. Dropping them lets "iPersonal AG" compare
 * equal to the host `ipersonal.ch` without ever letting a merely shared word
 * ("bern", "zurich", "personal") glue two unrelated brands together.
 */
const GENERIC_TOKENS = new Set([
  'ag', 'sa', 'sagl', 'sarl', 'gmbh', 'srl', 'spa', 'llc', 'inc', 'ltd', 'plc',
  'kg', 'bv', 'nv', 'se', 'co', 'holding', 'group', 'groupe', 'gruppe',
  'the', 'und', 'and', 'di', 'de', 'der', 'das',
]);

function identityTokens(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !GENERIC_TOKENS.has(token));
}

/** The brand reduced to its identity: a trailing qualifier in parentheses is noise. */
function brandIdentity(name: string) {
  return identityTokens(name.replace(/\s*\([^)]*\)\s*/g, ' ')).join('');
}

/** The host reduced to its identity: no crawler subdomain, no TLD. */
function domainIdentity(domain: string) {
  return identityTokens(
    domain
      .replace(/^(?:www|jobs|karriere|careers|recruitingapp-\d+)\./, '')
      .replace(/\.[a-z]{2,4}$/, ''),
  ).join('');
}

/**
 * A brand and a host name the same entity only when their identities are the
 * SAME token sequence. The predicate used to be bidirectional containment on
 * the folded strings (`name.includes(core) || core.includes(name)`), which has
 * no token boundary: "Stadt Bern" claimed `bern.ch`, "Banque Cantonale
 * Vaudoise" claimed `vaudoise.ch`, and 19 pairs of unrelated parsers sat one
 * side away from the blocking `crossed && !straight` verdict (#7720). Equality
 * on the identity is what makes the guard fire on a real swap only.
 */
function sameEntity(brand: string, host: string) {
  return host.length > 3 && brand === host;
}

type ParserBrand = { file: string; name: string; domain: string };

function readParserBrands(): ParserBrand[] {
  const brands: ParserBrand[] = [];
  for (const file of readdirSync(PARSER_DIR)) {
    if (!file.endsWith('-job-parser.mjs')) continue;
    const source = readFileSync(join(PARSER_DIR, file), 'utf8');
    const name = source.match(/export const \w*COMPANY_NAME\s*=\s*['"`]([^'"`]+)/)?.[1];
    const domain = source.match(/export const \w*COMPANY_DOMAIN\s*=\s*['"`]([^'"`]+)/)?.[1];
    if (!name || !domain) continue;
    brands.push({ file, name, domain });
  }
  return brands;
}

describe('ipersonal / med-ipersonal brand ↔ source domain pairing', () => {
  it('labels each crawler with the brand its own host publishes', () => {
    expect(BRAND_BY_DOMAIN[IPERSONAL_COMPANY_DOMAIN]).toBe(IPERSONAL_COMPANY_NAME);
    expect(BRAND_BY_DOMAIN[MED_IPERSONAL_COMPANY_DOMAIN]).toBe(MED_IPERSONAL_COMPANY_NAME);
    // The keys stay named after the other host on purpose: renaming them would
    // move the slice files and the crawler-generation roster. Assert the trap
    // explicitly so a future reader does not "fix" the label back.
    expect(IPERSONAL_KEY).toBe('ipersonal');
    expect(IPERSONAL_COMPANY_DOMAIN).toBe('med-ipersonal.ch');
    expect(MED_IPERSONAL_KEY).toBe('med-ipersonal');
    expect(MED_IPERSONAL_COMPANY_DOMAIN).toBe('ipersonal.ch');
  });

  it('keeps the crawler spec companyName in sync with the parser label', () => {
    for (const [key, expected] of [
      [IPERSONAL_KEY, IPERSONAL_COMPANY_NAME],
      [MED_IPERSONAL_KEY, MED_IPERSONAL_COMPANY_NAME],
    ] as const) {
      const spec = JSON.parse(
        readFileSync(join(process.cwd(), 'data', 'prospector', 'crawlers', `${key}.json`), 'utf8'),
      );
      // spec-crawler.mjs falls back to spec.companyName for `company`, so a
      // stale spec re-introduces the crossed label through the back door.
      expect(spec.companyName).toBe(expected);
    }
  });

  it('never lets one sibling claim the other sibling rows', () => {
    const ipersonalRow = {
      companyKey: IPERSONAL_KEY,
      company: IPERSONAL_COMPANY_NAME,
      url: 'https://med-ipersonal.ch/jobs/123/',
    };
    const medRow = {
      companyKey: MED_IPERSONAL_KEY,
      company: MED_IPERSONAL_COMPANY_NAME,
      url: 'https://www.ipersonal.ch/jobs/456/',
    };
    expect(isIpersonalJob(ipersonalRow)).toBe(true);
    expect(isMedIpersonalJob(ipersonalRow)).toBe(false);
    expect(isMedIpersonalJob(medRow)).toBe(true);
    expect(isIpersonalJob(medRow)).toBe(false);
  });

  it('still recognises the legacy rows that carry the crossed label', () => {
    // The published slices keep the wrong `company` until the next crawl. The
    // declared companyKey has to keep them attached to their own crawler, or
    // the fix would retire 28 live routes instead of relabelling them.
    expect(isIpersonalJob({ companyKey: 'ipersonal', company: 'iPersonal AG' })).toBe(true);
    expect(isMedIpersonalJob({ companyKey: 'med-ipersonal', company: 'MediPersonal' })).toBe(true);
    expect(isMedIpersonalJob({ companyKey: 'ipersonal', company: 'iPersonal AG' })).toBe(false);
    expect(isIpersonalJob({ companyKey: 'med-ipersonal', company: 'MediPersonal' })).toBe(false);
  });
});

function findSwappedPairs(brands: ParserBrand[]): string[] {
  const swapped: string[] = [];
  for (let i = 0; i < brands.length; i++) {
    for (let j = i + 1; j < brands.length; j++) {
      const a = brands[i];
      const b = brands[j];
      const [nameA, nameB] = [brandIdentity(a.name), brandIdentity(b.name)];
      const [coreA, coreB] = [domainIdentity(a.domain), domainIdentity(b.domain)];
      if (coreA === coreB) continue;
      const crossed = sameEntity(nameA, coreB) && sameEntity(nameB, coreA);
      const straight = sameEntity(nameA, coreA) && sameEntity(nameB, coreB);
      if (crossed && !straight) {
        swapped.push(`${a.file} (${a.name} / ${a.domain}) <=> ${b.file} (${b.name} / ${b.domain})`);
      }
    }
  }
  return swapped;
}

describe('dedicated crawler parsers, as a class', () => {
  it('has no pair of parsers whose brand labels are swapped with each other', () => {
    const brands = readParserBrands();
    expect(brands.length).toBeGreaterThan(400);
    expect(findSwappedPairs(brands)).toEqual([]);
  });

  it('still flags the pre-#7570 pair that really was crossed', () => {
    // The guard has to stay a guard: hardening the predicate must not turn the
    // one swap this suite exists for into something it can no longer see.
    const swapped = findSwappedPairs([
      { file: 'ipersonal-job-parser.mjs', name: 'iPersonal AG', domain: 'med-ipersonal.ch' },
      { file: 'med-ipersonal-job-parser.mjs', name: 'MediPersonal', domain: 'ipersonal.ch' },
    ]);
    expect(swapped).toHaveLength(1);
  });

  it('does not flag two brands that merely share a generic token with the other host', () => {
    // Sharing "personal" is not a swap, and neither is sharing a city name:
    // `Stadt Bern`/`bern.ch` vs `Universität Bern`/`unibe.ch` is one of the 19
    // real pairs the old containment predicate left one side from red (#7720).
    expect(
      findSwappedPairs([
        { file: 'a-job-parser.mjs', name: 'Personal Service AG', domain: 'x-personal.ch' },
        { file: 'b-job-parser.mjs', name: 'MediPersonal', domain: 'personal-med.ch' },
      ]),
    ).toEqual([]);
    expect(
      findSwappedPairs([
        { file: 'stadt-bern-job-parser.mjs', name: 'Stadt Bern', domain: 'bern.ch' },
        { file: 'unibe-job-parser.mjs', name: 'Universität Bern', domain: 'unibe.ch' },
      ]),
    ).toEqual([]);
  });
});
