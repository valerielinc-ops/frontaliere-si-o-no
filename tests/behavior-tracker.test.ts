/**
 * Tests for behaviorTracker.ts — localStorage CRUD + merge logic.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
 getBehaviorData,
 readBehaviorAndMarkVisit,
 trackJobViewBehavior,
 trackApplicationIntent,
  trackSearch,
  trackFilterUsage,
  getLastVisitTimestamp,
  updateLastVisit,
  mergeBehavior,
  type BehaviorData,
} from '@/services/behaviorTracker';

// ── Setup ──────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
});

function emptyBehavior(): BehaviorData {
  return {
    version: 1,
    lastVisit: null,
    viewedJobs: [],
    searches: [],
    filterUsage: { category: {}, location: {}, contract: {} },
    syncedAt: null,
  };
}

// ── getBehaviorData ────────────────────────────────────────────

describe('getBehaviorData', () => {
  it('returns empty behavior when no data exists', () => {
    const data = getBehaviorData();
    expect(data.version).toBe(1);
    expect(data.viewedJobs).toEqual([]);
    expect(data.searches).toEqual([]);
    expect(data.lastVisit).toBeNull();
  });

  it('recovers from corrupt JSON', () => {
    localStorage.setItem('frontaliere_job_personalization', '{invalid json');
    const data = getBehaviorData();
    expect(data.version).toBe(1);
    expect(data.viewedJobs).toEqual([]);
  });

  it('resets when version mismatches', () => {
    localStorage.setItem('frontaliere_job_personalization', JSON.stringify({ version: 99 }));
    const data = getBehaviorData();
    expect(data.version).toBe(1);
  });
});

// ── trackJobViewBehavior ───────────────────────────────────────

describe('trackJobViewBehavior', () => {
  it('tracks a job view and persists to localStorage', () => {
    trackJobViewBehavior({ slug: 'test-job', category: 'tech', company: 'Acme', location: 'Lugano' });
    const data = getBehaviorData();
    expect(data.viewedJobs).toHaveLength(1);
    expect(data.viewedJobs[0].slug).toBe('test-job');
    expect(data.viewedJobs[0].category).toBe('tech');
  });

  it('deduplicates by slug (updates timestamp)', () => {
    trackJobViewBehavior({ slug: 'test-job', category: 'tech', company: 'Acme', location: 'Lugano' });
    trackJobViewBehavior({ slug: 'test-job', category: 'tech', company: 'Acme', location: 'Lugano' });
    const data = getBehaviorData();
    expect(data.viewedJobs).toHaveLength(1);
  });

  it('skips empty slug', () => {
    trackJobViewBehavior({ slug: '', category: 'tech', company: 'X', location: 'Y' });
    const data = getBehaviorData();
    expect(data.viewedJobs).toHaveLength(0);
  });

  it('prunes at 100 entries (FIFO)', () => {
    for (let i = 0; i < 110; i++) {
      trackJobViewBehavior({ slug: `job-${i}`, category: 'tech', company: 'X', location: 'Y' });
    }
    const data = getBehaviorData();
    expect(data.viewedJobs.length).toBeLessThanOrEqual(100);
    // Most recent entries should be preserved
    expect(data.viewedJobs.some((v) => v.slug === 'job-109')).toBe(true);
  });
});

describe('application-intent ranking projection', () => {
  it('stores only a bounded redirect-only key and its 90-day retention', () => {
    const now = Date.parse('2026-09-26T12:00:00.000Z');
    expect(trackApplicationIntent('acme:software-engineer-lugano', now)).toBe(true);
    const intent = getBehaviorData().applicationIntent?.intents[0];
    expect(intent).toEqual({
      jobKey: 'acme:software-engineer-lugano',
      application_status: 'redirect_only',
      timestamp: now,
      retentionUntil: now + 90 * 24 * 60 * 60 * 1000,
    });
    expect(JSON.stringify(intent)).not.toContain('application_completed');
  });

  it('does not record a ranking signal after applicationIntent.optedOut', () => {
    localStorage.setItem('frontaliere_job_personalization', JSON.stringify({
      ...emptyBehavior(),
      applicationIntent: { optedOut: true, intents: [] },
    }));
    expect(trackApplicationIntent('acme:software-engineer-lugano')).toBe(false);
    expect(getBehaviorData().applicationIntent?.optedOut).toBe(true);
    expect(getBehaviorData().applicationIntent?.intents).toEqual([]);
  });

  it('prunes expired application intents while merging opt-out fail-closed', () => {
    const now = Date.now();
    const local = emptyBehavior();
    local.applicationIntent = {
      optedOut: false,
      intents: [{
        jobKey: 'acme:expired',
        application_status: 'redirect_only',
        timestamp: now - 91 * 24 * 60 * 60 * 1000,
        retentionUntil: now - 24 * 60 * 60 * 1000,
      }],
    };
    const cloud = emptyBehavior();
    cloud.applicationIntent = { optedOut: true, intents: [] };
    const merged = mergeBehavior(local, cloud);
    expect(merged.applicationIntent?.optedOut).toBe(true);
    expect(merged.applicationIntent?.intents).toEqual([]);
  });
});

// ── trackSearch ────────────────────────────────────────────────

describe('trackSearch', () => {
  it('tracks a search query', () => {
    trackSearch('infermiere', 15);
    const data = getBehaviorData();
    expect(data.searches).toHaveLength(1);
    expect(data.searches[0].query).toBe('infermiere');
    expect(data.searches[0].resultCount).toBe(15);
  });

  it('skips empty query', () => {
    trackSearch('', 0);
    trackSearch('   ', 0);
    const data = getBehaviorData();
    expect(data.searches).toHaveLength(0);
  });

  it('prunes at 50 entries', () => {
    for (let i = 0; i < 55; i++) {
      trackSearch(`query-${i}`, i);
    }
    const data = getBehaviorData();
    expect(data.searches.length).toBeLessThanOrEqual(50);
  });
});

// ── trackFilterUsage ───────────────────────────────────────────

describe('trackFilterUsage', () => {
  it('increments filter usage counters', () => {
    trackFilterUsage('category', 'tech');
    trackFilterUsage('category', 'tech');
    trackFilterUsage('category', 'health');
    const data = getBehaviorData();
    expect(data.filterUsage.category['tech']).toBe(2);
    expect(data.filterUsage.category['health']).toBe(1);
  });

  it('skips empty value', () => {
    trackFilterUsage('category', '');
    const data = getBehaviorData();
    expect(Object.keys(data.filterUsage.category)).toHaveLength(0);
  });
});

// ── lastVisit ──────────────────────────────────────────────────

describe('lastVisit', () => {
  it('returns null when no visit recorded', () => {
    expect(getLastVisitTimestamp()).toBeNull();
  });

 it('records and retrieves last visit', () => {
    const before = Date.now();
    updateLastVisit();
    const ts = getLastVisitTimestamp();
    expect(ts).not.toBeNull();
    expect(ts!).toBeGreaterThanOrEqual(before - 1000);
 expect(ts!).toBeLessThanOrEqual(Date.now() + 1000);
 });

 it('returns the previous timestamp before recording the current visit', () => {
 const previous = Date.parse('2026-09-17T08:00:00.000Z');
 const data = emptyBehavior();
 data.lastVisit = new Date(previous).toISOString();
 localStorage.setItem('frontaliere_job_personalization', JSON.stringify(data));

 const snapshot = readBehaviorAndMarkVisit();

 expect(snapshot.previousLastVisit).toBe(previous);
 expect(snapshot.data.lastVisit).not.toBe(data.lastVisit);
 expect(getLastVisitTimestamp()).toBeGreaterThan(previous);
 });

 it('treats a malformed visit stamp like a first visit and repairs it', () => {
 const data = emptyBehavior();
 data.lastVisit = 'not-a-date';
 localStorage.setItem('frontaliere_job_personalization', JSON.stringify(data));

 const snapshot = readBehaviorAndMarkVisit();

 expect(snapshot.previousLastVisit).toBeNull();
 expect(Number.isFinite(new Date(snapshot.data.lastVisit!).getTime())).toBe(true);
 });
});

// ── mergeBehavior ──────────────────────────────────────────────

describe('mergeBehavior', () => {
  it('merges empty local + empty cloud → empty', () => {
    const result = mergeBehavior(emptyBehavior(), emptyBehavior());
    expect(result.viewedJobs).toEqual([]);
    expect(result.searches).toEqual([]);
  });

  it('unions viewed jobs by slug, keeping most recent', () => {
    const now = Date.now();
    const local = emptyBehavior();
    local.viewedJobs = [
      { slug: 'job-1', category: 'tech', company: 'A', location: 'L', ts: now - 2000 },
      { slug: 'job-2', category: 'health', company: 'B', location: 'M', ts: now - 1000 },
    ];
    const cloud = emptyBehavior();
    cloud.viewedJobs = [
      { slug: 'job-1', category: 'tech', company: 'A', location: 'L', ts: now }, // newer
      { slug: 'job-3', category: 'admin', company: 'C', location: 'N', ts: now - 1500 },
    ];
    const result = mergeBehavior(local, cloud);
    expect(result.viewedJobs).toHaveLength(3);
    const job1 = result.viewedJobs.find((v) => v.slug === 'job-1');
    expect(job1?.ts).toBe(now); // local wins because it overrides cloud (Map iteration order)
  });

  it('deduplicates searches by query+ts', () => {
    const now = Date.now();
    const local = emptyBehavior();
    local.searches = [
      { query: 'test', ts: now - 1000, resultCount: 5 },
    ];
    const cloud = emptyBehavior();
    cloud.searches = [
      { query: 'test', ts: now - 1000, resultCount: 5 }, // same
      { query: 'other', ts: now, resultCount: 10 },
    ];
    const result = mergeBehavior(local, cloud);
    expect(result.searches).toHaveLength(2);
  });

  it('merges filter usage with max (not sum)', () => {
    const local = emptyBehavior();
    local.filterUsage = { category: { tech: 5 }, location: { lugano: 3 }, contract: {} };
    const cloud = emptyBehavior();
    cloud.filterUsage = { category: { tech: 3, health: 2 }, location: {}, contract: { 'full-time': 1 } };
    const result = mergeBehavior(local, cloud);
    expect(result.filterUsage.category['tech']).toBe(5); // max(5, 3)
    expect(result.filterUsage.category['health']).toBe(2);
    expect(result.filterUsage.location['lugano']).toBe(3);
    expect(result.filterUsage.contract['full-time']).toBe(1);
  });
});

// ── 90-day expiry ──────────────────────────────────────────────

describe('expiry pruning', () => {
  it('prunes entries older than 90 days', () => {
    const now = Date.now();
    const old = now - 91 * 24 * 60 * 60 * 1000;
    const raw: BehaviorData = {
      version: 1,
      lastVisit: null,
      viewedJobs: [
        { slug: 'old-job', category: 'tech', company: 'X', location: 'Y', ts: old },
        { slug: 'new-job', category: 'tech', company: 'X', location: 'Y', ts: now },
      ],
      searches: [
        { query: 'old', ts: old, resultCount: 5 },
        { query: 'new', ts: now, resultCount: 10 },
      ],
      filterUsage: { category: {}, location: {}, contract: {} },
      syncedAt: null,
    };
    localStorage.setItem('frontaliere_job_personalization', JSON.stringify(raw));
    const data = getBehaviorData();
    expect(data.viewedJobs).toHaveLength(1);
    expect(data.viewedJobs[0].slug).toBe('new-job');
    expect(data.searches).toHaveLength(1);
    expect(data.searches[0].query).toBe('new');
  });
});
