import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';

vi.unmock('@/services/analytics');
vi.mock('@/services/firebase', () => ({ getAnalytics: vi.fn(async () => ({})), getConfigValue: vi.fn(async () => '') }));
import { logEvent } from 'firebase/analytics';
import { captureEvent } from '@/services/posthog';
import { Analytics } from '@/services/analytics';

beforeEach(() => { vi.mocked(logEvent).mockClear(); vi.mocked(captureEvent).mockClear(); sessionStorage.clear(); });

describe('actual application analytics emitters', () => {
 it('joins list, detail, provider failure/retry and external handoff in Firebase only', async () => {
  const job = { slug: 'demo-application', slugByLocale: { it: 'demo-application' }, companyKey: 'demo-employer' };
  const identity = { jobSlug: job.slug, employerKey: job.companyKey };
  Analytics.trackJobApplicationStep(identity, 'list_select');
  Analytics.trackJobApplicationStep(identity, 'detail_view');
  Analytics.trackJobAuthGate('view', { jobSlug: job.slug, surface: 'inline' });
  Analytics.trackJobAuthGate('method_click', { jobSlug: job.slug, method: 'google' });
  Analytics.trackJobAuthGate('fail', { jobSlug: job.slug, method: 'google' });
  Analytics.trackJobAuthGate('method_click', { jobSlug: job.slug, method: 'email' });
  Analytics.trackJobAuthGate('success', { jobSlug: job.slug, method: 'email', authState: 'pending_email' });
  Analytics.trackJobApplicationStep(identity, 'apply_click');
  expect(Analytics.trackJobApplyHandoff(job, 'https://employer.example/apply/?token=secret')).toBe(true);
  const events = () => vi.mocked(logEvent).mock.calls.filter((call) => call[1] === 'job_application_journey').map((call) => call[2]!);
  await waitFor(() => expect(events()).toHaveLength(8));
  expect(new Set(events().map((event) => event.journey_id)).size).toBe(1);
  expect(events().map((event) => event.journey_step)).toEqual(['list_select', 'detail_view', 'gate_view', 'auth_start', 'auth_error', 'auth_success', 'apply_click', 'handoff']);
  expect(events().at(-1)?.journey_path).toBe('list_select>detail_view>gate_view>auth_success>apply_click>handoff');
  expect(JSON.stringify(events())).not.toContain('secret');
  expect(vi.mocked(captureEvent).mock.calls.some(([name]) => name === 'job_application_journey')).toBe(false);
 });

 it('rejects an invalid destination without claiming a handoff', () => {
  expect(Analytics.trackJobApplyHandoff({ slug: 'invalid' }, 'javascript:alert(1)')).toBe(false);
  expect(vi.mocked(logEvent).mock.calls.filter((call) => call[1] === 'job_application_journey')).toHaveLength(0);
 });
});
