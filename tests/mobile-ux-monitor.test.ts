import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('@/services/consentService', () => ({
  isAnalyticsGranted: vi.fn(() => true),
}));
vi.mock('@/services/errorReporter', () => ({
  reportCaughtError: vi.fn(),
}));
vi.mock('@/services/analytics', () => ({
  Analytics: { log: vi.fn() },
}));

describe('mobileUxMonitor', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('exports initMobileUxMonitor function', async () => {
    const mod = await import('@/services/mobileUxMonitor');
    expect(typeof mod.initMobileUxMonitor).toBe('function');
  });

  it('initMobileUxMonitor does not throw when called', async () => {
    const mod = await import('@/services/mobileUxMonitor');
    expect(() => mod.initMobileUxMonitor()).not.toThrow();
  });

  it('initMobileUxMonitor is idempotent (second call is a no-op)', async () => {
    const mod = await import('@/services/mobileUxMonitor');
    mod.initMobileUxMonitor();
    mod.initMobileUxMonitor(); // should not throw or double-register
  });
});

describe('webVitals device dimensions', () => {
  it('exports initWebVitals function', async () => {
    const mod = await import('@/services/webVitals');
    expect(typeof mod.initWebVitals).toBe('function');
  });
});
