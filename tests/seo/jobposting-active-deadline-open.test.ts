/**
 * Emission gate: an ACTIVE JobPosting is never emitted already expired.
 *
 * Measured on 2026-11-10 against data/jobs/by-crawler on main: 471 of 35'473
 * active records resolved to a `validThrough` in the past, because a lapsed
 * derived window (crawlers that never stamp `crawledAt`, anchored to
 * `firstSeenAt` + cap; or a heartbeat older than the 30-day window) was emitted
 * as-is on a page that still presents the offer as open. The archived page is
 * the only one allowed a past deadline (`archive-evidence`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertActiveJobPostingDeadlineOpen,
  buildJobPostingSchema,
  resolveOpenActiveJobPostingValidThrough,
  type JobInput,
} from '../../build-plugins/shared/jobPostingSchema';
import { buildArchivedJobPosting } from '../../build-plugins/shared/archivedJobPosting';
import { resolveActiveJobPostingDeadline } from '../../scripts/lib/jobposting-field-enrichment.mjs';

const DAY = 86_400_000;
// Relative clock (AGENTS: no absolute fixture dates), pinned to a mid-day
// instant so the date-only cases are not sensitive to the UTC midnight edge.
const NOW = new Date(Math.floor(Date.now() / DAY) * DAY + 12 * 3_600_000);
const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();
const day = (days: number) => at(days).slice(0, 10);

const base: JobInput = {
  id: 'acme-1',
  slug: 'tecnico-acme',
  title: 'Tecnico di manutenzione',
  description: 'Descrizione reale dell annuncio con abbastanza testo per passare la soglia minima del contratto.',
  company: 'Acme SA',
  addressLocality: 'Bern',
  addressRegion: 'BE',
  canton: 'BE',
};
const build = (input: JobInput, now: Date = NOW) => buildJobPostingSchema(input, {
  locale: 'it',
  url: 'https://frontaliereticino.ch/cerca-lavoro-berna/tecnico-acme/',
  now,
});
const isOpen = (validThrough: string | null | undefined, now: Date = NOW) =>
  Number.isFinite(Date.parse(String(validThrough))) && Date.parse(String(validThrough)) > now.getTime();

describe('an active JobPosting is never emitted with validThrough <= emission clock', () => {
  it('date-only datePosted with validThrough equal to the observation instant', () => {
    // The shape reported on the live pages: datePosted "YYYY-MM-DD" and a
    // validThrough that is the scrape timestamp of the same day.
    const observedAt = at(-0.1);
    const input: JobInput = {
      ...base,
      postingDateSource: 'reported',
      datePosted: day(0),
      crawledAt: observedAt,
      validThrough: observedAt,
    };
    const schema = build(input);
    expect(schema.datePosted).toBe(day(0));
    expect(isOpen(schema.validThrough)).toBe(true);
    expect(Date.parse(schema.validThrough)).toBeGreaterThan(Date.parse(schema.datePosted));
  });

  it('a crawler that never stamps crawledAt: firstSeenAt + cap lapsed months ago', () => {
    const input: JobInput = {
      ...base,
      postingDateSource: 'unknown',
      datePosted: '',
      firstSeenAt: at(-210),
      validThrough: at(-120),
      validThroughSource: 'last-observed-window',
    };
    const resolved = resolveActiveJobPostingDeadline(input, NOW);
    expect(isOpen(resolved.validThrough)).toBe(true);
    expect(resolved.validThroughSource).toBe('build-clock-fallback');
    expect(isOpen(build(input).validThrough)).toBe(true);
  });

  it('a heartbeat older than the 30-day window', () => {
    const input: JobInput = { ...base, firstSeenAt: at(-120), crawledAt: at(-45), datePosted: at(-120) };
    const resolved = resolveActiveJobPostingDeadline(input, NOW);
    expect(isOpen(resolved.validThrough)).toBe(true);
    expect(resolved.validThroughSource).toBe('build-clock-fallback');
  });

  it('the lapsed-window fallback is byte-stable while it is still future', () => {
    const input: JobInput = { ...base, firstSeenAt: at(-210) };
    const first = resolveActiveJobPostingDeadline(input, NOW);
    const later = new Date(NOW.getTime() + 10 * DAY);
    const rebuilt = resolveActiveJobPostingDeadline({ ...input, ...first }, later);
    expect(rebuilt).toEqual(first);
  });

  it('a fresh heartbeat still wins over the fallback', () => {
    const input: JobInput = { ...base, firstSeenAt: at(-210), crawledAt: at(-1) };
    const resolved = resolveActiveJobPostingDeadline({
      ...input,
      validThrough: at(-120),
      validThroughSource: 'build-clock-fallback',
    }, NOW);
    expect(resolved.validThroughSource).toBe('last-observed-window');
    expect(resolved.validThrough).toBe(new Date(Date.parse(at(-1)) + 30 * DAY).toISOString());
  });

  it('a date-only source deadline of today closes at the end of the day', () => {
    const resolved = resolveActiveJobPostingDeadline({ ...base, crawledAt: at(-1), validThrough: day(0) }, NOW);
    expect(resolved.validThroughSource).toBe('source');
    expect(resolved.validThrough).toBe(`${day(0)}T23:59:59.999Z`);
    expect(isOpen(resolved.validThrough)).toBe(true);
  });

  it('a date-only source deadline at the very last instant of its day yields to the bounded window', () => {
    const lastInstant = new Date(`${day(0)}T23:59:59.999Z`);
    const resolved = resolveActiveJobPostingDeadline({ ...base, validThrough: day(0) }, lastInstant);
    expect(isOpen(resolved.validThrough, lastInstant)).toBe(true);
    expect(resolved.validThroughSource).toBe('build-clock-fallback');
    expect(() => assertActiveJobPostingDeadlineOpen(resolved.validThrough, lastInstant, 'x')).not.toThrow();
    expect(() => build({ ...base, validThrough: day(0) }, lastInstant)).not.toThrow();
  });

  it('holds over every combination of deadline evidence', () => {
    const offsets = [undefined, -400, -91, -45, -31, -1, -0.01, 0.01, 1, 29, 400];
    const sources = [undefined, 'source', 'last-observed-window', 'job-type-cap', 'build-clock-fallback'];
    const kinds = ['FULL_TIME', 'TEMPORARY', 'CONTRACTOR'];
    let checked = 0;
    for (const vt of offsets) for (const src of sources) for (const crawled of offsets) for (const first of offsets)
      for (const employmentType of kinds) {
        const input: JobInput = {
          ...base,
          employmentType,
          validThrough: vt === undefined ? undefined : at(vt),
          validThroughSource: src,
          crawledAt: crawled === undefined ? undefined : at(crawled),
          firstSeenAt: first === undefined ? undefined : at(first),
        };
        const resolved = resolveActiveJobPostingDeadline(input, NOW);
        if (!isOpen(resolved.validThrough)) {
          throw new Error(`born-expired active deadline for ${JSON.stringify(input)} -> ${JSON.stringify(resolved)}`);
        }
        checked++;
      }
    expect(checked).toBe(offsets.length ** 3 * sources.length * kinds.length);
  });
});

describe('the gate fails closed on every active emitter', () => {
  it('assertActiveJobPostingDeadlineOpen rejects a past, equal or missing deadline', () => {
    expect(() => assertActiveJobPostingDeadlineOpen(at(-1), NOW, 'x')).toThrow(/already expired/);
    expect(() => assertActiveJobPostingDeadlineOpen(NOW.toISOString(), NOW, 'x')).toThrow(/already expired/);
    expect(() => assertActiveJobPostingDeadlineOpen(null, NOW, 'x')).toThrow(/already expired/);
    expect(() => assertActiveJobPostingDeadlineOpen(at(1), NOW, 'x')).not.toThrow();
    expect(() => assertActiveJobPostingDeadlineOpen(at(-1), NOW, '')).toThrow(/\(unidentified job\)/);
  });

  it('the reused-page refresh resolves through the same gate', () => {
    const input: JobInput = { ...base, firstSeenAt: at(-210), validThrough: at(-120), validThroughSource: 'last-observed-window' };
    expect(isOpen(resolveOpenActiveJobPostingValidThrough(input, NOW))).toBe(true);
  });

  it('the archived page keeps its past deadline and is not subject to the active gate', () => {
    const schema = buildArchivedJobPosting({
      ...base,
      postingDateSource: 'unknown',
      firstSeenAt: at(-8),
      expiredAt: at(-3),
    }, 'Offerta archiviata e non più disponibile.', { locale: 'it', url: 'https://frontaliereticino.ch/x/', now: NOW })!;
    expect(schema).toBeTruthy();
    expect(Date.parse(schema.validThrough)).toBeLessThan(NOW.getTime());
  });
});

describe('archived JobPosting dates follow the evidence the page shows', () => {
  it('datePosted is the first sighting, not the expiry day', () => {
    // Live 2026-11-10: an expired Planzer page showed "Pubblicata il 2026-11-02"
    // while its JobPosting said datePosted "2026-11-07" == the expiry day.
    const firstSeenAt = at(-8);
    const expiredAt = at(-3);
    const schema = buildArchivedJobPosting({
      ...base,
      postingDateSource: 'unknown',
      firstSeenAt,
      expiredAt,
    }, 'Offerta archiviata e non più disponibile.', { locale: 'it', url: 'https://frontaliereticino.ch/x/', now: NOW })!;
    expect(schema.datePosted).toBe(firstSeenAt);
    expect(schema.validThrough).toBe(expiredAt);
    expect(Date.parse(schema.datePosted)).toBeLessThan(Date.parse(schema.validThrough));
  });
});

// Observer on the dataset the build publishes: every record of the active
// inventory, resolved through the emission rule, is open. Runs wherever the
// crawler slices are materialized (CI checkout and full local clones); a
// sparse worktree without data/ has nothing to observe.
const SLICES_DIR = path.resolve(__dirname, '../../data/jobs/by-crawler');
const hasSlices = fs.existsSync(SLICES_DIR)
  && fs.readdirSync(SLICES_DIR).some((file) => file.endsWith('.json'));

describe.runIf(hasSlices)('active inventory observer (data/jobs/by-crawler)', () => {
  it('no active record resolves to a validThrough at or before now', () => {
    const now = new Date();
    const offenders: string[] = [];
    let total = 0;
    for (const file of fs.readdirSync(SLICES_DIR)) {
      if (!file.endsWith('.json')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(SLICES_DIR, file), 'utf8'));
      } catch {
        continue; // malformed/scratch companions are other gates' concern
      }
      const jobs = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { jobs?: unknown })?.jobs) ? (parsed as { jobs: unknown[] }).jobs : [];
      for (const job of jobs as JobInput[]) {
        if (!job || typeof job !== 'object') continue;
        total++;
        const resolved = resolveActiveJobPostingDeadline(job, now);
        if (!isOpen(resolved.validThrough, now)) {
          offenders.push(`${file}:${job.slug || job.id} -> ${resolved.validThrough} (${resolved.validThroughSource})`);
        }
      }
    }
    console.log(`[active-deadline-observer] active records=${total} born-expired=${offenders.length}`);
    expect(offenders.slice(0, 20)).toEqual([]);
  });
});
