import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  savePendingJobAlert,
  consumePendingJobAlert,
  clearPendingJobAlert,
} from '@/services/pendingJobAlert';
import { saveIntent } from '@/services/pendingIntentStore';
import { savePendingSalaryAlert } from '@/services/pendingSalaryAlert';
import { savePendingSaveJobIntent } from '@/services/pendingSaveJob';
import { savePendingCompanyFollow } from '@/services/companyFollowIntent';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { JobAlertConfig } from '@/services/jobAlertService';

const config: JobAlertConfig = {
  keywords: ['infermiere'],
  locations: ['Lugano'],
  contractTypes: [],
  sectors: [],
  cantonFilter: null,
  frequency: 'daily',
  locale: 'it',
};
const pending = { config, origin: 'inline_card' as const };

describe('pendingJobAlert', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('round-trips a saved config', () => {
    savePendingJobAlert(config, 'inline_card');
    expect(consumePendingJobAlert()).toEqual(pending);
  });

  it('consumes once — a second consume returns null', () => {
    savePendingJobAlert(config, 'inline_card');
    expect(consumePendingJobAlert()).toEqual(pending);
    expect(consumePendingJobAlert()).toBeNull();
  });

  it('returns null when nothing is pending', () => {
    expect(consumePendingJobAlert()).toBeNull();
  });

  it('expires entries older than the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T10:00:00Z'));
    savePendingJobAlert(config, 'inline_card');
    // 16 minutes later — past the 15-minute TTL.
    vi.setSystemTime(new Date('2026-06-22T10:16:00Z'));
    expect(consumePendingJobAlert()).toBeNull();
  });

  it('honours a config saved just within the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T10:00:00Z'));
    savePendingJobAlert(config, 'inline_card');
    vi.setSystemTime(new Date('2026-06-22T10:14:00Z'));
    expect(consumePendingJobAlert()).toEqual(pending);
  });

  it('clear removes a pending entry', () => {
    savePendingJobAlert(config, 'inline_card');
    clearPendingJobAlert();
    expect(consumePendingJobAlert()).toBeNull();
  });

  it('returns null on malformed storage', () => {
    localStorage.setItem('pending_job_alert', '{not json');
    expect(consumePendingJobAlert()).toBeNull();
  });

  it('persists in localStorage (survives a new tab / autologin redirect), not sessionStorage', () => {
    // Regression guard for #2730: sessionStorage is per-tab, so a logged-out
    // user who filled the form in tab A and opened the newsletter-autologin
    // email link in tab B lost the intent. localStorage is shared across tabs +
    // persists across reloads, so the replay fires on every sign-in surface.
    savePendingJobAlert(config, 'inline_card');
    expect(localStorage.getItem('pending_job_alert')).not.toBeNull();
    expect(sessionStorage.getItem('pending_job_alert')).toBeNull();
    // A fresh page context (new tab / post-redirect reload) reads the same
    // shared localStorage and recovers the config.
    expect(consumePendingJobAlert()).toEqual(pending);
  });

  // Issue 9575 — the stash outcome is typed and reaches the caller, so a guest
  // submit is never sent through sign-in on the promise of a replay that the
  // storage layer has already made impossible.
  it('reports ok when the intent is stored and readable back', () => {
    expect(savePendingJobAlert(config, 'inline_card')).toEqual({ ok: true });
  });

  it('reports storage_unavailable when localStorage.setItem throws (private mode / quota)', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    expect(savePendingJobAlert(config, 'inline_card')).toEqual({ ok: false, reason: 'storage_unavailable' });
    expect(consumePendingJobAlert()).toBeNull();
  });

  it('reports storage_unavailable when a storage shim swallows the write', () => {
    // No throw, nothing stored: without the read-back this was a silent
    // success followed by consumePendingJobAlert() === null after sign-in.
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => undefined);
    expect(savePendingJobAlert(config, 'inline_card')).toEqual({ ok: false, reason: 'storage_unavailable' });
    expect(consumePendingJobAlert()).toBeNull();
  });

  it('shared saveIntent returns false on a swallowed write too (class-level guard)', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => undefined);
    expect(saveIntent('pending_probe', { a: 1 })).toBe(false);
  });

  // Issue 9576 — the CTA origin survives the auth round-trip.
  it('round-trips the CTA origin alongside the config', () => {
    savePendingJobAlert(config, 'inline_card');
    expect(consumePendingJobAlert()?.origin).toBe('inline_card');
  });

  it('replays a legacy bare config (stored before the origin was carried) with origin null', () => {
    localStorage.setItem('pending_job_alert', JSON.stringify({ value: config, savedAt: Date.now() }));
    expect(consumePendingJobAlert()).toEqual({ config, origin: null });
  });

  it('drops an unknown origin instead of attributing to an arbitrary surface', () => {
    localStorage.setItem(
      'pending_job_alert',
      JSON.stringify({ value: { config, origin: 'post_auth_auto' }, savedAt: Date.now() }),
    );
    expect(consumePendingJobAlert()).toEqual({ config, origin: null });
  });

  // Same class, sibling intents (sibling-patterns gate): the stash outcome
  // reaches the caller, and each caller keeps an in-tab recovery path.
  it('the sibling salary-alert, save-job and company-follow stashes report a failed write too', () => {
    const follow = { company: 'Board International SA', companyKey: null, locale: 'it' as const, sourceJobSlug: null, sourceJobUrl: null, sourceJobTitle: null, email: 'anon@example.com' };
    expect(savePendingSalaryAlert(config)).toBe(true);
    expect(savePendingSaveJobIntent({ kind: 'show_saved_only' })).toBe(true);
    expect(savePendingCompanyFollow(follow)).toBe(true);
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    expect(savePendingSalaryAlert(config)).toBe(false);
    expect(savePendingSaveJobIntent({ kind: 'show_saved_only' })).toBe(false);
    expect(savePendingCompanyFollow({ ...follow, company: 'Coop' })).toBe(false);
  });

  it('the sibling callers keep an in-memory fallback that every reader consults', () => {
    const root = resolve(__dirname, '..');
    const salary = readFileSync(resolve(root, 'components/calculator/SalaryAlertCTA.tsx'), 'utf8');
    expect(salary).toContain('inMemoryPendingRef.current = stored ? null : config;');
    expect(salary).toContain('consumePendingSalaryAlert() ?? inMemoryPendingRef.current');
    expect(salary).toContain('pending_stored: stored');

    const board = readFileSync(resolve(root, 'components/community/JobBoard.tsx'), 'utf8');
    expect(board).toContain('pendingSaveFallbackRef.current = stored ? null : intent;');
    // Every consumer of the pending save intent falls back to the ref.
    const readers = board.match(/(?:consume|peek)PendingSaveJobIntent\(\)[^;\n]*/g) ?? [];
    expect(readers.length).toBeGreaterThanOrEqual(3);
    for (const reader of readers) expect(reader).toContain('?? pendingSaveFallbackRef.current');
    // No direct stash left that would drop the outcome again.
    expect(board.match(/savePendingSaveJobIntent\(/g) ?? []).toHaveLength(1);

    const followButton = readFileSync(resolve(root, 'components/community/CompanyFollowButton.tsx'), 'utf8');
    expect(followButton).toContain('const parked = savePendingCompanyFollow({');
    expect(followButton).toMatch(/if \(!parked\) \{\s*setStatus\('error'\);/);
  });
});
