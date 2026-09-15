import { describe, expect, it } from 'vitest';
import {
  createPostHogQuotaFilter,
  POSTHOG_EVENT_SAMPLE_RATE,
  shouldCapturePostHogEvent,
} from '@/services/posthogQuota';

function event(sessionId: string, name = 'custom_event') {
  return { event: name, properties: { $session_id: sessionId } };
}

describe('PostHog quota sampling', () => {
  it('keeps replay snapshots and identity events even at zero analytics sampling', () => {
    expect(shouldCapturePostHogEvent(event('session-a', '$snapshot'), 0)).toBe(true);
    expect(shouldCapturePostHogEvent(event('session-a', '$exception'), 0)).toBe(true);
    expect(shouldCapturePostHogEvent(event('session-a', '$identify'), 0)).toBe(true);
    expect(shouldCapturePostHogEvent(event('session-a', 'decision_moment_completed'), 0)).toBe(true);
    expect(shouldCapturePostHogEvent(event('session-a', 'decision_moment_next_action'), 0)).toBe(true);
    expect(shouldCapturePostHogEvent(event('session-a'), 0)).toBe(false);
  });

  it('makes one stable decision for every event in the same session', () => {
    const decisions = ['$pageview', 'funnel_step', 'simulation_complete'].map((name) =>
      shouldCapturePostHogEvent(event('session-stable', name)),
    );

    expect(new Set(decisions).size).toBe(1);
  });

  it('keeps roughly the configured fraction of different sessions', () => {
    const kept = Array.from({ length: 10000 }, (_, index) =>
      shouldCapturePostHogEvent(event(`session-${index}`), 0.1),
    ).filter(Boolean).length;

    expect(kept).toBeGreaterThan(800);
    expect(kept).toBeLessThan(1200);
    expect(POSTHOG_EVENT_SAMPLE_RATE).toBe(0);
  });

  it('fails open when the SDK event has no sampling identifier', () => {
    const payload = { event: 'custom_event', properties: {} };
    expect(shouldCapturePostHogEvent(payload, 0.1)).toBe(true);
    expect(shouldCapturePostHogEvent(payload, 0)).toBe(false);
  });

  it('returns null for a null event and preserves accepted events', () => {
    const filter = createPostHogQuotaFilter(1);
    const payload = event('session-kept');

    expect(filter(null)).toBeNull();
    expect(filter(payload)).toBe(payload);
  });
});
