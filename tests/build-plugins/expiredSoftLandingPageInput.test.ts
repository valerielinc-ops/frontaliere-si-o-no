import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildExpiredSoftLandingPageInput,
  canonicalizeInput,
  computeInputHash,
  expiredSoftLandingPayloadDigest,
} from '../../build-plugins/shared/incrementalManifest.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../..');
const JOBS_SEO_PLUGIN = path.join(ROOT, 'build-plugins/jobsSeoPagesPlugin.ts');

// The bytes the soft-landing template really emits: `expiredDataObj` serialized
// into `<script>window.__EXPIRED_JOB_DATA__=…</script>`. Two payloads that
// differ only in a field the page input never carried — `descriptionByLocale`,
// which on an orphan slug comes from data/orphan-enriched-data/part-*.json and
// is read with `fs.readFileSync` at render time.
const payload = (description: string, impressions: number) => JSON.stringify({
  slug: 'addetto-vendita-manor-lugano',
  title: 'Addetto Vendita',
  company: 'Manor',
  companyKey: 'manor',
  location: 'Lugano',
  descriptionByLocale: { it: description },
  slugByLocale: { it: 'addetto-vendita-manor-lugano' },
  sector: 'commercio',
  gscQueries: ['lavoro manor lugano', 'addetto vendita ticino'],
  gscImpressions: impressions,
  gscClicks: 3,
});

const OLD_PAYLOAD = payload('Posizione di addetto vendita presso Manor Lugano.', 812);
const NEW_PAYLOAD = payload('Posizione di addetto alla vendita presso Manor a Lugano.', 977);

const EJ_DATA = Object.freeze({
  id: 'expired-7',
  slug: 'addetto-vendita-manor-lugano',
  updatedAt: '2026-08-02T06:00:00.000Z',
  company: 'Manor',
});

const softLandingInput = (overrides: Record<string, unknown> = {}) => buildExpiredSoftLandingPageInput({
  job: EJ_DATA,
  locale: 'it',
  slug: EJ_DATA.slug,
  relatedJobs: [{ id: 'related-1', slug: 'related-1', title: 'Related one' }],
  path: 'lavoro-scaduto/addetto-vendita-manor-lugano',
  title: 'Addetto Vendita a Lugano — Offerta scaduta',
  trackingPaths: ['/lavoro-scaduto/addetto-vendita-manor-lugano/'],
  company: 'Manor',
  location: 'Lugano',
  canton: 'TI',
  sector: 'commercio',
  contract: 'permanent',
  datePosted: '2026-07-01',
  expiredAt: '2026-08-01',
  gscQueries: ['lavoro manor lugano', 'addetto vendita ticino'],
  currentYear: 2026,
  candidatePaths: ['/lavoro-scaduto/addetto-vendita-manor-lugano/'],
  prosePaths: [],
  keepProse: false,
  action: 'full',
  expiredPayloadJson: OLD_PAYLOAD,
  postalCode: '6900',
  derivedFromUnhashedSource: true,
  ...overrides,
});

const softLandingHash = (overrides: Record<string, unknown> = {}) => computeInputHash(
  softLandingInput(overrides),
  'expired-soft-landing',
);

describe('expired soft-landing input carries the ledger-derived payload', () => {
  it('hashes the same expired record differently when the GSC ledger moved', () => {
    // Identical job record, identical path, title, company, location, canton,
    // sector, contract, dates, first six queries and traffic decision: only
    // data/orphan-enriched-data/part-*.json published a new description and new
    // impressions. Before this contract the two hashes were equal, the cached
    // HTML was reused, and the page kept serving the old
    // `window.__EXPIRED_JOB_DATA__` and the old prose.
    expect(softLandingHash()).not.toBe(softLandingHash({ expiredPayloadJson: NEW_PAYLOAD }));
  });

  it('hashes differently when only the slug-derived postal code moved', () => {
    // `postalCode` comes from data/swiss-postal-codes.json via
    // `extractInfoFromSlug` and is the one rendered field the inline payload
    // does not carry: it reaches the JobPosting JSON-LD, which AGENTS.md
    // non-negotiable #3 requires on every job page.
    expect(softLandingHash()).not.toBe(softLandingHash({ postalCode: '6600' }));
  });

  it('keeps the hash stable when neither ledger moved', () => {
    expect(softLandingHash()).toBe(softLandingHash());
    // A payload rebuilt byte for byte must hash identically: the digest is over
    // the emitted bytes, not over object identity.
    expect(softLandingHash()).toBe(softLandingHash({
      expiredPayloadJson: payload('Posizione di addetto vendita presso Manor Lugano.', 812),
    }));
  });

  it('stores a short digest, never the payload itself', () => {
    const canonical = canonicalizeInput(softLandingInput());
    expect(canonical).toContain('"expiredPayloadDigest"');
    expect(canonical).not.toContain('gscImpressions');
    expect(canonical).not.toContain('Posizione di addetto vendita');
    expect(softLandingInput().expiredPayloadDigest).toMatch(/^[a-f0-9]{16}$/);
  });

  it('survives the runtime-input key filter that silently drops build metadata', () => {
    // `canonicalValue()` deletes keys like `lastmod`/`generatedAt` from every
    // input. A field named into that set would look present and hash to
    // nothing — assert the digest really reaches the canonical string.
    const canonical = canonicalizeInput(softLandingInput());
    expect(canonical).toContain(expiredSoftLandingPayloadDigest(OLD_PAYLOAD, '6900'));
    expect(canonical).not.toContain(expiredSoftLandingPayloadDigest(NEW_PAYLOAD, '6900'));
  });

  it('costs nothing on pages no unhashed ledger can reach', () => {
    // This is the cost contract, not a nicety. `slugInfo` exists exactly when
    // `ejData.title` is missing and `gscInfo` exactly when the orphan ledger
    // knows the slug; with neither, every field of the emitted payload is a
    // projection of `ejData`, `slug` and `locale`, all already in the hash.
    // Adding the digest there would re-render the largest reuse block
    // (258'998 pages on the IT leg of deploy 35507082715) for nothing.
    const plain = softLandingInput({ derivedFromUnhashedSource: false });
    expect(plain).not.toHaveProperty('expiredPayloadDigest');
    expect(canonicalizeInput(plain)).not.toContain('expiredPayloadDigest');
    // And the payload it would have digested cannot move the hash either.
    expect(
      computeInputHash(plain, 'expired-soft-landing'),
    ).toBe(
      computeInputHash(
        softLandingInput({ derivedFromUnhashedSource: false, expiredPayloadJson: NEW_PAYLOAD }),
        'expired-soft-landing',
      ),
    );
  });

  it('digests an absent payload without throwing', () => {
    expect(expiredSoftLandingPayloadDigest('', '')).toBe(
      expiredSoftLandingPayloadDigest(undefined, undefined),
    );
    expect(expiredSoftLandingPayloadDigest('', '')).not.toBe(
      expiredSoftLandingPayloadDigest(OLD_PAYLOAD, '6900'),
    );
    // The two components must not be able to trade places: a payload ending in
    // the postal code and an empty code would otherwise collide.
    expect(expiredSoftLandingPayloadDigest('a', 'b')).not.toBe(
      expiredSoftLandingPayloadDigest('ab', ''),
    );
  });
});

describe('jobsSeoPagesPlugin wires the payload the renderer actually emits', () => {
  const source = fs.readFileSync(JOBS_SEO_PLUGIN, 'utf8');
  const codeLines = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));

  it('feeds the soft-landing input with the emitted inline payload', () => {
    expect(source).toContain('buildExpiredSoftLandingPageInput({');
    expect(source).toContain('expiredPayloadJson: expiredWindowData,');
    expect(source).toContain('derivedFromUnhashedSource: Boolean(gscInfo) || Boolean(slugInfo),');
  });

  it('keeps one emit site for the inline payload, so the digest cannot miss one', () => {
    // `window.__EXPIRED_JOB_DATA__` is serialized in exactly one template and
    // assembled in exactly one place. A second site would emit ledger bytes the
    // digest above never sees — the shape of the defect this test guards.
    expect(codeLines.filter((line) => line.includes('window.__EXPIRED_JOB_DATA__'))).toHaveLength(1);
    expect(codeLines.filter((line) => line.includes('const expiredWindowData ='))).toHaveLength(1);
  });

  it('assembles the soft-landing input only through the shared builder', () => {
    // The defect was born from an input assembled inline at the emit site while
    // the block was rendered elsewhere. One builder, one place to keep true.
    expect(codeLines.filter((line) => line.includes('buildExpiredSoftLandingPageInput('))).toHaveLength(1);
    expect(source).not.toContain("registerIncrementalPage(locale, relPath, 'expired-soft-landing', {");
  });
});
