// @vitest-environment jsdom
/**
 * The save bookmark contract on every job card: signed in → save; anonymous →
 * sign-in prompt, then the save replays once a uid exists, on any page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { toggleSavedJob, ensureSavedJob, trackEvent, requestSlot, releaseSlot } = vi.hoisted(() => ({
  toggleSavedJob: vi.fn(() => 'saved'),
  ensureSavedJob: vi.fn(() => 'saved'),
  trackEvent: vi.fn(),
  requestSlot: vi.fn(() => true),
  releaseSlot: vi.fn(),
}));

vi.mock('@/services/savedJobsService', () => ({ toggleSavedJob, ensureSavedJob }));
vi.mock('@/services/analytics', () => ({ Analytics: { trackEvent } }));
vi.mock('@/services/popupQueue', () => ({ requestSlot, releaseSlot, POPUP_PRIORITY: { AUTH_GATE: 100 } }));

import {
  _resetJobSaveGateForTests,
  consumePendingSavedFilter,
  dismissSavePrompt,
  isSavePromptOpen,
  peekPendingSave,
  requestJobSave,
  requestSavedFilterSignIn,
  syncJobSaveAuth,
  toSaveableJob,
} from '@/services/jobSaveGate';
import { savePendingSaveJobIntent } from '@/services/pendingSaveJob';

const job = toSaveableJob({ id: 'pfister-1', slug: 'verkaeufer', title: 'Verkäufer', company: 'Möbel Pfister AG' });

describe('jobSaveGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    window.localStorage.clear();
    _resetJobSaveGateForTests();
  });

  it('saves straight away when signed in, with no prompt', () => {
    syncJobSaveAuth('uid-1');
    requestJobSave(job, 'card_static');
    expect(toggleSavedJob).toHaveBeenCalledWith(job, 'uid-1');
    expect(isSavePromptOpen()).toBe(false);
    expect(trackEvent).toHaveBeenCalledWith('job_saved', expect.objectContaining({ job_id: 'pfister-1', surface: 'card_static' }));
  });

  it('never writes on an anonymous tap: it stashes the job and opens the prompt', () => {
    requestJobSave(job, 'card_static');
    expect(toggleSavedJob).not.toHaveBeenCalled();
    expect(isSavePromptOpen()).toBe(true);
    expect(requestSlot).toHaveBeenCalledWith('save-auth-prompt', 100);
    expect(peekPendingSave()).toEqual({ kind: 'save_job', entry: job, surface: 'card_static' });
  });

  it('replays the pending save after sign-in, once, and closes the prompt', () => {
    requestJobSave(job, 'card_static');
    syncJobSaveAuth('uid-1');
    syncJobSaveAuth('uid-1');
    expect(ensureSavedJob).toHaveBeenCalledTimes(1);
    expect(ensureSavedJob).toHaveBeenCalledWith(job, 'uid-1');
    expect(isSavePromptOpen()).toBe(false);
    expect(releaseSlot).toHaveBeenCalledWith('save-auth-prompt');
  });

  it('replays an intent stashed by another tab (magic link opened on a fresh page)', () => {
    savePendingSaveJobIntent({ kind: 'save_job', entry: job, surface: 'list' });
    syncJobSaveAuth('uid-1');
    expect(ensureSavedJob).toHaveBeenCalledWith(job, 'uid-1');
  });

  it('keeps the intent in memory when localStorage refuses it (issue 9575)', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    requestJobSave(job, 'card_static');
    expect(trackEvent).toHaveBeenCalledWith('save_signin_prompt_shown', expect.objectContaining({ pending_stored: false }));
    syncJobSaveAuth('uid-1');
    expect(ensureSavedJob).toHaveBeenCalledWith(job, 'uid-1');
  });

  it('dismiss closes the prompt but keeps the intent for a late magic link', () => {
    requestJobSave(job, 'card_static');
    dismissSavePrompt();
    expect(isSavePromptOpen()).toBe(false);
    expect(peekPendingSave()?.kind).toBe('save_job');
  });

  it('leaves the saved-filter intent for JobBoard to consume', () => {
    requestSavedFilterSignIn();
    syncJobSaveAuth('uid-1');
    expect(ensureSavedJob).not.toHaveBeenCalled();
    expect(consumePendingSavedFilter()).toBe(true);
    expect(consumePendingSavedFilter()).toBe(false);
  });
});
