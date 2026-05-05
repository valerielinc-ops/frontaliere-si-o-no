import { describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pure-ESM script. The CLI block is gated on `import.meta.url ===
// file://${process.argv[1]}`, so importing is side-effect-free.
import * as scheduler from '../../scripts/schedule-fb-jobs-daily.mjs';

interface JobLike {
  id: string;
  title?: string;
  slug?: string;
  slugByLocale?: Record<string, string>;
  hiringOrganization?: { name?: string };
  company?: string;
  location?: string;
  jobLocation?: { address?: { addressLocality?: string } };
  description?: string;
  descriptionByLocale?: Record<string, string>;
  baseSalary?: {
    currency?: string;
    value?: { minValue?: number; maxValue?: number };
  };
  salaryMin?: number;
  salaryMax?: number;
  employmentType?: string;
  sector?: string;
  firstSeenAt?: string;
  crawledAt?: string;
  postedDate?: string;
}

interface PostedEntry {
  id: string;
  url: string;
  ts: string;
  fbPostId: string;
}

interface PostedLedger {
  schemaVersion: number;
  posted: PostedEntry[];
}

interface Payload {
  jobId: string;
  url: string;
  message: string;
  scheduled_publish_time: number;
}

const {
  pickNextSlots,
  selectUnpostedJobs,
  buildJobCaption,
  buildJobHashtags,
  buildJobUrl,
  loadPosted,
  appendPosted,
  loadPlaceIds,
  lookupPlaceId,
  run,
} = scheduler as unknown as {
  pickNextSlots: (
    volume: number,
    occupied: Iterable<number>,
    now: Date | number,
  ) => number[];
  selectUnpostedJobs: (
    jobs: JobLike[],
    postedSet: Set<string>,
    limit: number,
  ) => JobLike[];
  buildJobCaption: (job: JobLike) => string;
  buildJobHashtags: (job: JobLike) => string;
  buildJobUrl: (job: JobLike) => string | null;
  loadPosted: (repoRoot: string) => PostedLedger;
  appendPosted: (repoRoot: string, entries: PostedEntry[]) => void;
  loadPlaceIds: (repoRoot: string) => Record<string, string>;
  lookupPlaceId: (
    location: string | null | undefined,
    placeIds: Record<string, string>,
  ) => string | null;
  run: (opts: {
    env?: Record<string, string | undefined>;
    now?: Date;
    repoRoot?: string;
    fetchImpl?: typeof fetch;
    log?: (...a: unknown[]) => void;
    warn?: (...a: unknown[]) => void;
  }) => Promise<{
    ok: boolean;
    scheduled: number;
    dryRun: boolean;
    payloads: Payload[];
  }>;
};

// ── pickNextSlots ─────────────────────────────────────────

describe('pickNextSlots', () => {
  // Pick a deterministic "now" with seconds=0 so slot math is easy.
  const NOW = new Date(Date.UTC(2026, 4, 5, 6, 0, 0)); // 2026-05-05 06:00:00 UTC

  it('volume=24 → all minutes are :05, exactly 24 slots, all ≥ now+600', () => {
    const slots = pickNextSlots(24, [], NOW);
    expect(slots).toHaveLength(24);
    const minLeadMs = NOW.getTime() + 600 * 1000;
    for (const s of slots) {
      expect(s * 1000).toBeGreaterThanOrEqual(minLeadMs);
      expect(new Date(s * 1000).getUTCMinutes()).toBe(5);
    }
    // Sorted ascending
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i]).toBeGreaterThan(slots[i - 1]);
    }
  });

  it('volume=72 → minutes ∈ {5,25,45}, exactly 72 slots, all ≥ now+600', () => {
    const slots = pickNextSlots(72, [], NOW);
    expect(slots).toHaveLength(72);
    const minLeadMs = NOW.getTime() + 600 * 1000;
    for (const s of slots) {
      expect(s * 1000).toBeGreaterThanOrEqual(minLeadMs);
      expect([5, 25, 45]).toContain(new Date(s * 1000).getUTCMinutes());
    }
  });

  it('volume=144 → minutes ∈ {5,15,25,35,45,55}, exactly 144 slots', () => {
    const slots = pickNextSlots(144, [], NOW);
    expect(slots).toHaveLength(144);
    const minLeadMs = NOW.getTime() + 600 * 1000;
    for (const s of slots) {
      expect(s * 1000).toBeGreaterThanOrEqual(minLeadMs);
      expect([5, 15, 25, 35, 45, 55]).toContain(
        new Date(s * 1000).getUTCMinutes(),
      );
    }
  });

  it('skips occupied slots', () => {
    // Reserve the first :05 slot of the next hour after now.
    // For NOW=06:00:00, MIN_LEAD=06:10:00, first slot is 07:05.
    const firstSlotSec = Math.floor(
      Date.UTC(2026, 4, 5, 7, 5, 0) / 1000,
    );
    const slots = pickNextSlots(24, [firstSlotSec], NOW);
    expect(slots).toHaveLength(24);
    expect(slots).not.toContain(firstSlotSec);
    // The new earliest slot should be 08:05.
    expect(slots[0]).toBe(Math.floor(Date.UTC(2026, 4, 5, 8, 5, 0) / 1000));
  });

  it('respects 10-minute lead window — does not pick a slot < now+600s', () => {
    // NOW=06:04:00 → MIN_LEAD=06:14:00. With volume=144 (minute=15 valid),
    // first slot must be ≥ 06:15:00, NOT 06:05 or 06:14.
    const earlyNow = new Date(Date.UTC(2026, 4, 5, 6, 4, 0));
    const slots = pickNextSlots(144, [], earlyNow);
    expect(slots[0] * 1000).toBeGreaterThanOrEqual(
      earlyNow.getTime() + 600 * 1000,
    );
    // 06:15 is exactly at MIN_LEAD+60s, fine.
    expect(slots[0]).toBe(Math.floor(Date.UTC(2026, 4, 5, 6, 15, 0) / 1000));
  });

  it('falls back to volume=24 minutes for an unknown volume', () => {
    const slots = pickNextSlots(99 as unknown as 24, [], NOW);
    expect(slots).toHaveLength(24);
    for (const s of slots) {
      expect(new Date(s * 1000).getUTCMinutes()).toBe(5);
    }
  });
});

// ── selectUnpostedJobs ────────────────────────────────────

describe('selectUnpostedJobs', () => {
  const jobs: JobLike[] = [
    { id: 'a', firstSeenAt: '2026-05-01T00:00:00Z' },
    { id: 'b', firstSeenAt: '2026-05-04T00:00:00Z' },
    { id: 'c', crawledAt: '2026-05-03T00:00:00Z' },
    { id: 'd', postedDate: '2026-05-02' },
    { id: 'e' }, // no date → epoch
    { id: 'f', firstSeenAt: 'not-a-date' }, // malformed → epoch
  ];

  it('excludes already-posted IDs', () => {
    const out = selectUnpostedJobs(jobs, new Set(['b']), 10);
    expect(out.map((j) => j.id)).not.toContain('b');
  });

  it('sorts by recency descending (firstSeenAt → crawledAt → postedDate)', () => {
    const out = selectUnpostedJobs(jobs, new Set(), 4);
    // b (May 4) > c (May 3) > d (May 2) > a (May 1)
    expect(out.slice(0, 4).map((j) => j.id)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('respects the limit', () => {
    const out = selectUnpostedJobs(jobs, new Set(), 2);
    expect(out).toHaveLength(2);
  });

  it('handles malformed dates by sorting them last (epoch)', () => {
    const out = selectUnpostedJobs(jobs, new Set(), 10);
    const ids = out.map((j) => j.id);
    // e and f have epoch — they should be last (in some order).
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('e'));
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('f'));
  });

  it('returns [] when jobs is not an array', () => {
    expect(
      selectUnpostedJobs(null as unknown as JobLike[], new Set(), 5),
    ).toEqual([]);
  });

  it('skips entries without an id', () => {
    const j = [{ title: 'no id' } as unknown as JobLike, { id: 'x' }];
    const out = selectUnpostedJobs(j, new Set(), 10);
    expect(out.map((x) => x.id)).toEqual(['x']);
  });
});

// ── buildJobCaption ───────────────────────────────────────

describe('buildJobCaption', () => {
  const fullJob: JobLike = {
    id: 'job-1',
    title: 'Sviluppatore Senior Java',
    hiringOrganization: { name: 'Acme SA' },
    jobLocation: { address: { addressLocality: 'Lugano' } },
    baseSalary: { currency: 'CHF', value: { minValue: 90000, maxValue: 110000 } },
    employmentType: 'FULL_TIME',
    sector: 'IT',
    descriptionByLocale: {
      it: 'Cerchiamo uno sviluppatore senior Java per progetto innovativo a Lugano. Ottime competenze richieste. Ambiente dinamico.',
    },
  };

  it('includes title, company, city, salary, employment label', () => {
    const c = buildJobCaption(fullJob);
    expect(c).toContain('💼 Sviluppatore Senior Java');
    expect(c).toContain('Acme SA');
    expect(c).toContain('📍 Lugano');
    expect(c).toContain('CHF');
    expect(c).toContain("90'000");
    expect(c).toContain('📋 Tempo pieno');
  });

  it('total length ≤ 5000 (FB hard limit)', () => {
    // Synthesize a pathological body to confirm clamp.
    const huge: JobLike = {
      ...fullJob,
      description: 'X'.repeat(50000),
      descriptionByLocale: undefined,
    };
    expect(buildJobCaption(huge).length).toBeLessThanOrEqual(5000);
  });

  it('truncates body at sentence boundary near 140 chars', () => {
    const c = buildJobCaption(fullJob);
    // The description has 3 sentences; the truncated body should end at a
    // sentence terminator (`.`, `!`, `?`) and be ≤ 140 chars.
    const lines = c.split('\n');
    // Find the body line — first non-empty line after the header(s).
    const bodyIdx = lines.findIndex(
      (l, i) =>
        i >= 2 && l && !l.startsWith('#') && !l.startsWith('💼') && !l.startsWith('📍'),
    );
    expect(bodyIdx).toBeGreaterThan(0);
    const body = lines[bodyIdx];
    expect(body.length).toBeLessThanOrEqual(141); // small slack
    expect(/[.!?]$/.test(body)).toBe(true);
  });

  it('omits the salary segment when neither min nor max is present', () => {
    const j: JobLike = { ...fullJob, baseSalary: undefined, salaryMin: undefined, salaryMax: undefined };
    const c = buildJobCaption(j);
    expect(c).not.toContain('💰');
  });

  it('omits the employment label when employmentType is missing', () => {
    const j: JobLike = { ...fullJob, employmentType: undefined };
    const c = buildJobCaption(j);
    expect(c).not.toContain('📋');
  });

  it('omits the company suffix when hiringOrganization.name is missing', () => {
    const j: JobLike = { ...fullJob, hiringOrganization: undefined, company: undefined };
    const c = buildJobCaption(j);
    expect(c).toContain('💼 Sviluppatore Senior Java');
    expect(c).not.toContain(' · ');
  });

  it('strips HTML from descriptions', () => {
    const j: JobLike = {
      ...fullJob,
      descriptionByLocale: {
        it: '<p>Ruolo <strong>fantastico</strong> a Lugano.</p>',
      },
    };
    const c = buildJobCaption(j);
    expect(c).not.toContain('<p>');
    expect(c).not.toContain('<strong>');
    expect(c).toContain('Ruolo fantastico');
  });
});

// ── buildJobHashtags ──────────────────────────────────────

describe('buildJobHashtags', () => {
  it('produces at most 5 tags', () => {
    const job: JobLike = {
      id: 'x',
      title: 'Sviluppatore Java',
      jobLocation: { address: { addressLocality: 'Lugano' } },
      sector: 'IT',
    };
    const tags = buildJobHashtags(job).split(' ');
    expect(tags.length).toBeLessThanOrEqual(5);
    expect(tags).toContain('#frontalieri');
    expect(tags).toContain('#lavoroticino');
    expect(tags).toContain('#Sviluppatore');
    expect(tags).toContain('#Lugano');
    expect(tags).toContain('#IT');
  });

  it('strips diacritics and spaces from tag bodies', () => {
    const job: JobLike = {
      id: 'x',
      title: 'Operaio',
      jobLocation: { address: { addressLocality: 'Mendrisio Distretto' } },
      sector: 'Cantieristica & Edilizia',
    };
    const tags = buildJobHashtags(job).split(' ');
    // City uses just first word (no spaces, no diacritics).
    expect(tags).toContain('#Mendrisio');
    // Sector keeps alphanum only — `Cantieristica & Edilizia` → `CantieristicaEdilizia`.
    expect(tags.some((t) => t === '#CantieristicaEdilizia')).toBe(true);
    // No tag contains a space.
    for (const t of tags) {
      expect(t.includes(' ')).toBe(false);
    }
  });

  it('falls back to #Ticino when sector is missing', () => {
    const job: JobLike = {
      id: 'x',
      title: 'Cuoco',
      jobLocation: { address: { addressLocality: 'Bellinzona' } },
    };
    const tags = buildJobHashtags(job).split(' ');
    expect(tags).toContain('#Ticino');
  });

  it('drops the role tag when no role keyword matches', () => {
    const job: JobLike = {
      id: 'x',
      title: 'Posizione strana e atipica',
      jobLocation: { address: { addressLocality: 'Lugano' } },
      sector: 'X',
    };
    const tags = buildJobHashtags(job).split(' ');
    // No role keyword, but #frontalieri/#lavoroticino must still be present.
    expect(tags).toContain('#frontalieri');
    expect(tags).toContain('#lavoroticino');
  });

  it('dedupes case-insensitively', () => {
    const job: JobLike = {
      id: 'x',
      title: 'Frontalieri lavoro',
      jobLocation: { address: { addressLocality: 'Lugano' } },
      sector: 'frontalieri', // would dupe with the always-on tag
    };
    const tags = buildJobHashtags(job).split(' ');
    const lc = tags.map((t) => t.toLowerCase());
    expect(new Set(lc).size).toBe(lc.length);
  });
});

// ── buildJobUrl ──────────────────────────────────────────

describe('buildJobUrl', () => {
  it('uses slugByLocale.it when present', () => {
    const u = buildJobUrl({
      id: 'x',
      slugByLocale: { it: 'cuoco-lugano-acme', en: 'chef-lugano-acme' },
    });
    expect(u).toBe(
      'https://frontaliereticino.ch/cerca-lavoro-ticino/cuoco-lugano-acme/',
    );
  });

  it('falls back to slug', () => {
    const u = buildJobUrl({ id: 'x', slug: 'foo-bar' });
    expect(u).toBe('https://frontaliereticino.ch/cerca-lavoro-ticino/foo-bar/');
  });

  it('returns null when no slug at all', () => {
    expect(buildJobUrl({ id: 'x' })).toBeNull();
  });
});

// ── loadPosted / appendPosted ─────────────────────────────

describe('loadPosted', () => {
  it('returns empty when the file is missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-jobs-'));
    const out = loadPosted(tmp);
    expect(out.posted).toEqual([]);
    expect(out.schemaVersion).toBe(1);
  });

  it('returns empty on malformed JSON without throwing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-jobs-'));
    mkdirSync(join(tmp, 'data'), { recursive: true });
    writeFileSync(join(tmp, 'data', 'fb-posted-jobs.json'), 'not-json');
    const out = loadPosted(tmp);
    expect(out.posted).toEqual([]);
  });

  it('returns empty when shape is wrong (no posted array)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-jobs-'));
    mkdirSync(join(tmp, 'data'), { recursive: true });
    writeFileSync(
      join(tmp, 'data', 'fb-posted-jobs.json'),
      JSON.stringify({ schemaVersion: 1 }),
    );
    expect(loadPosted(tmp).posted).toEqual([]);
  });

  it('round-trips a valid ledger', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-jobs-'));
    mkdirSync(join(tmp, 'data'), { recursive: true });
    const ledger: PostedLedger = {
      schemaVersion: 1,
      posted: [
        { id: 'a', url: 'https://x', ts: 't', fbPostId: 'p1' },
      ],
    };
    writeFileSync(
      join(tmp, 'data', 'fb-posted-jobs.json'),
      JSON.stringify(ledger),
    );
    const out = loadPosted(tmp);
    expect(out.posted).toHaveLength(1);
    expect(out.posted[0].id).toBe('a');
  });
});

describe('appendPosted', () => {
  it('creates the file when missing and writes entries', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-jobs-'));
    mkdirSync(join(tmp, 'data'), { recursive: true });
    appendPosted(tmp, [
      { id: 'j1', url: 'u1', ts: 't1', fbPostId: 'p1' },
    ]);
    const after = loadPosted(tmp);
    expect(after.posted.map((e) => e.id)).toEqual(['j1']);
  });

  it('appends to an existing ledger', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-jobs-'));
    mkdirSync(join(tmp, 'data'), { recursive: true });
    appendPosted(tmp, [{ id: 'a', url: 'u', ts: 't', fbPostId: 'p' }]);
    appendPosted(tmp, [{ id: 'b', url: 'u', ts: 't', fbPostId: 'p' }]);
    const after = loadPosted(tmp);
    expect(after.posted.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('trims to last 1000 entries', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-jobs-'));
    mkdirSync(join(tmp, 'data'), { recursive: true });
    const big: PostedEntry[] = [];
    for (let i = 0; i < 1200; i++) {
      big.push({ id: `j${i}`, url: 'u', ts: 't', fbPostId: 'p' });
    }
    appendPosted(tmp, big);
    const after = loadPosted(tmp);
    expect(after.posted).toHaveLength(1000);
    // Most recent 1000 are kept (slice from the tail).
    expect(after.posted[0].id).toBe('j200');
    expect(after.posted[after.posted.length - 1].id).toBe('j1199');
  });

  it('is a no-op when given an empty array', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-jobs-'));
    mkdirSync(join(tmp, 'data'), { recursive: true });
    appendPosted(tmp, []);
    expect(existsSync(join(tmp, 'data', 'fb-posted-jobs.json'))).toBe(false);
  });
});

// ── run() integration ─────────────────────────────────────

describe('run() — DRY_RUN mode', () => {
  function setupTmp(jobs: JobLike[]): string {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-jobs-run-'));
    mkdirSync(join(tmp, 'data'), { recursive: true });
    writeFileSync(join(tmp, 'data', 'jobs.json'), JSON.stringify(jobs));
    writeFileSync(
      join(tmp, 'data', 'fb-posted-jobs.json'),
      JSON.stringify({ schemaVersion: 1, posted: [] }),
    );
    return tmp;
  }

  it('does NOT call fetch and emits expected payloads with DRY_RUN=1', async () => {
    const tmp = setupTmp([
      {
        id: 'job-A',
        title: 'Cuoco',
        slugByLocale: { it: 'cuoco-lugano' },
        jobLocation: { address: { addressLocality: 'Lugano' } },
        firstSeenAt: '2026-05-04T00:00:00Z',
        sector: 'Ristorazione',
        employmentType: 'FULL_TIME',
        descriptionByLocale: { it: 'Posto in ristorante.' },
      },
      {
        id: 'job-B',
        title: 'Sviluppatore',
        slugByLocale: { it: 'dev-lugano' },
        jobLocation: { address: { addressLocality: 'Lugano' } },
        firstSeenAt: '2026-05-03T00:00:00Z',
        sector: 'IT',
        employmentType: 'FULL_TIME',
        descriptionByLocale: { it: 'Ruolo IT.' },
      },
    ]);
    const fetchSpy = vi.fn<typeof fetch>();
    const result = await run({
      env: { DRY_RUN: '1', FB_JOB_VOLUME: '24', FB_PAGE_ID: 'pid', FB_PAGE_ACCESS_TOKEN: 'tok' },
      now: new Date(Date.UTC(2026, 4, 5, 6, 0, 0)),
      repoRoot: tmp,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      log: () => {},
      warn: () => {},
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.payloads).toHaveLength(2);

    // Recency: job-A (May 4) before job-B (May 3).
    expect(result.payloads[0].jobId).toBe('job-A');
    expect(result.payloads[0].url).toBe(
      'https://frontaliereticino.ch/cerca-lavoro-ticino/cuoco-lugano/',
    );
    // Slot for first payload is 07:05 UTC = unix-sec.
    expect(result.payloads[0].scheduled_publish_time).toBe(
      Math.floor(Date.UTC(2026, 4, 5, 7, 5, 0) / 1000),
    );
    expect(result.payloads[1].scheduled_publish_time).toBe(
      Math.floor(Date.UTC(2026, 4, 5, 8, 5, 0) / 1000),
    );

    // Ledger untouched in dry-run.
    const ledger = loadPosted(tmp);
    expect(ledger.posted).toHaveLength(0);
  });

  it('emits a real POST per job and updates the ledger when DRY_RUN is unset', async () => {
    const tmp = setupTmp([
      {
        id: 'job-X',
        title: 'Operaio',
        slugByLocale: { it: 'operaio-mendrisio' },
        jobLocation: { address: { addressLocality: 'Mendrisio' } },
        firstSeenAt: '2026-05-04T00:00:00Z',
        sector: 'Edilizia',
        employmentType: 'FULL_TIME',
      },
    ]);

    const fetchSpy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      // Pre-flight call.
      if (u.includes('/scheduled_posts')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      // /feed POST call.
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ id: 'pid_postid_1' }), { status: 200 });
    });

    const result = await run({
      env: { FB_JOB_VOLUME: '24', FB_PAGE_ID: 'pid', FB_PAGE_ACCESS_TOKEN: 'tok' },
      now: new Date(Date.UTC(2026, 4, 5, 6, 0, 0)),
      repoRoot: tmp,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      log: () => {},
      warn: () => {},
    });

    expect(result.scheduled).toBe(1);
    expect(result.ok).toBe(true);
    // Pre-flight + 1 POST = 2 fetch calls.
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Ledger has the entry now.
    const ledger = loadPosted(tmp);
    expect(ledger.posted).toHaveLength(1);
    expect(ledger.posted[0].id).toBe('job-X');
    expect(ledger.posted[0].fbPostId).toBe('pid_postid_1');
  });

  it('soft-fails when credentials are missing (no fetch, ok=false)', async () => {
    const tmp = setupTmp([
      {
        id: 'job-Y',
        title: 'Cuoco',
        slugByLocale: { it: 'y' },
        jobLocation: { address: { addressLocality: 'Lugano' } },
        firstSeenAt: '2026-05-04T00:00:00Z',
      },
    ]);
    const fetchSpy = vi.fn<typeof fetch>();
    const warns: string[] = [];
    const result = await run({
      env: { FB_JOB_VOLUME: '24' }, // no creds
      now: new Date(Date.UTC(2026, 4, 5, 6, 0, 0)),
      repoRoot: tmp,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      log: () => {},
      warn: (...a) => warns.push(a.join(' ')),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(warns.some((w) => w.toLowerCase().includes('missing'))).toBe(true);
  });

  it('exits gracefully when no jobs are available', async () => {
    const tmp = setupTmp([]);
    const fetchSpy = vi.fn<typeof fetch>();
    const result = await run({
      env: { DRY_RUN: '1', FB_JOB_VOLUME: '24' },
      now: new Date(Date.UTC(2026, 4, 5, 6, 0, 0)),
      repoRoot: tmp,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      log: () => {},
      warn: () => {},
    });
    expect(result.scheduled).toBe(0);
    expect(result.payloads).toEqual([]);
  });
});

describe('loadPlaceIds + lookupPlaceId', () => {
  it('returns {} when fb-place-ids.json is missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-place-miss-'));
    expect(loadPlaceIds(tmp)).toEqual({});
  });

  it('returns flat name → id map from valid file', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-place-ok-'));
    mkdirSync(join(tmp, 'data'), { recursive: true });
    writeFileSync(
      join(tmp, 'data', 'fb-place-ids.json'),
      JSON.stringify({
        schemaVersion: 1,
        places: {
          Lugano: { id: '106534719384213', name: 'Lugano, Switzerland' },
          Bern: { id: '122996511681850', name: 'Bern, Switzerland' },
          Broken: { name: 'no-id-key' },
        },
      }),
    );
    const map = loadPlaceIds(tmp);
    expect(map.Lugano).toBe('106534719384213');
    expect(map.Bern).toBe('122996511681850');
    expect(map.Broken).toBeUndefined();
  });

  it('returns {} on malformed JSON, never throws', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-place-bad-'));
    mkdirSync(join(tmp, 'data'), { recursive: true });
    writeFileSync(join(tmp, 'data', 'fb-place-ids.json'), '{not-json');
    expect(loadPlaceIds(tmp)).toEqual({});
  });

  it('lookupPlaceId: exact match', () => {
    const map = { Lugano: '106534719384213', Bern: '122996511681850' };
    expect(lookupPlaceId('Lugano', map)).toBe('106534719384213');
  });

  it('lookupPlaceId: strips canton suffix " (XX)"', () => {
    const map = { Aesch: '111', Erlenbach: '222' };
    expect(lookupPlaceId('Aesch (BL)', map)).toBe('111');
    expect(lookupPlaceId('Erlenbach (ZH)', map)).toBe('222');
  });

  it('lookupPlaceId: handles slash forms (e.g., "Biel/Bienne" → "Biel")', () => {
    const map = { Biel: '999' };
    expect(lookupPlaceId('Biel/Bienne', map)).toBe('999');
  });

  it('lookupPlaceId: returns null when no match', () => {
    expect(lookupPlaceId('Nowhere', { Lugano: '1' })).toBeNull();
    expect(lookupPlaceId(null, { Lugano: '1' })).toBeNull();
    expect(lookupPlaceId('Lugano', null as unknown as Record<string, string>)).toBeNull();
  });
});

// Quick sanity-check: tmpdir ledger path matches the script's expectation.
describe('ledger path', () => {
  it('reads/writes from <repoRoot>/data/fb-posted-jobs.json', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-jobs-path-'));
    mkdirSync(join(tmp, 'data'), { recursive: true });
    appendPosted(tmp, [
      { id: 'a', url: 'u', ts: 't', fbPostId: 'p' },
    ]);
    const raw = readFileSync(join(tmp, 'data', 'fb-posted-jobs.json'), 'utf-8');
    expect(JSON.parse(raw).posted[0].id).toBe('a');
  });
});
