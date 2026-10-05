import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useJobReadingIntent } from '@/hooks/useJobReadingIntent';
import { summarizeJourneyRows, journeyReportRequest } from '../scripts/job-application-funnel-report.mjs';

beforeEach(() => { vi.resetModules(); sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('application journey cohorts', () => {
 it('preserves one ID across list, detail, failed auth, reload, success and handoff; deduplicates stages', async () => {
  const job = { jobSlug: 'infermiere-demo-lugano', employerKey: 'demo-hospital' };
  const first = await import('@/services/jobApplicationJourney');
  const events = ['list_select', 'detail_view', 'gate_view', 'auth_start', 'auth_error'].map((step) => first.recordJobJourneyStep(job, step as never)!);
  expect(first.recordJobJourneyStep(job, 'gate_view')).toBeNull();
  vi.resetModules(); // OAuth full-page redirect: tab storage survives the module.
  const resumed = await import('@/services/jobApplicationJourney');
  for (const step of ['auth_success', 'apply_click', 'handoff'] as const) events.push(resumed.recordJobJourneyStep(job, step)!);
  expect(new Set(events.map((event) => event.journey_id)).size).toBe(1);
  expect(events.every((event) => event.journey_context.length < 100)).toBe(true);
  expect(events.at(-1)).toMatchObject({ journey_path: 'list_select>detail_view>gate_view>auth_success>apply_click>handoff', employer_key: 'demo-hospital' });
  expect(resumed.recordJobJourneyStep(job, 'handoff')).toBeNull();
  expect(JSON.stringify(events)).not.toMatch(/email=|token=|@|uid/);
 });

 it('preserves list CTA intent through the assisted/rewarded detail host', async () => {
  const { recordJobJourneyStep } = await import('@/services/jobApplicationJourney');
  const job = { jobSlug: 'list-application', employerKey: 'demo', jobId: 'demo-id' };
  const events = ['list_select', 'apply_click', 'detail_view', 'handoff'].map((step) => recordJobJourneyStep(job, step as never)!);
  expect(new Set(events.map((event) => event.journey_id)).size).toBe(1);
  const rows = events.map((e) => ({ dimensionValues: [e.journey_context, e.journey_device, e.employer_key].map((value) => ({ value })), metricValues: [{ value: '1' }] }));
  expect(summarizeJourneyRows(rows).segments[0].transitions['apply_click→handoff']).toEqual({ numerator: 1, denominator: 1, rate: 1 });
  const source = readFileSync(resolve(process.cwd(), 'components/community/JobBoard.tsx'), 'utf8');
  const handler = source.slice(source.indexOf(' const handleApply ='), source.indexOf(' // Receipts of earlier rewarded grants'));
  expect(handler.indexOf("'list_select'")).toBeLessThan(handler.indexOf('trackPublisherApplySignals'));
  expect(handler.match(/openDetail\(job, true\)/g)).toHaveLength(2);
  expect(source).toContain('openDetail(assistedApplicationJob, true)');
  expect(source).toContain('openDetail(rewardedApplicationJob, true)');
 });

 it('keeps source and employer fixed and starts a separate journey for another offer', async () => {
  const { recordJobJourneyStep, classifyJobJourneySource } = await import('@/services/jobApplicationJourney');
  window.history.replaceState({}, '', '/?utm_source=job_alert&utm_medium=email&token=private');
  const first = recordJobJourneyStep({ jobSlug: 'first', employerKey: 'first-employer' }, 'detail_view')!;
  window.history.replaceState({}, '', '/?utm_source=arbitrary-sensitive-value');
  expect(recordJobJourneyStep({ jobSlug: 'first', employerKey: 'changed' }, 'apply_click')).toMatchObject({ journey_source: 'job_alert', employer_key: 'first-employer', journey_id: first.journey_id });
  expect(recordJobJourneyStep({ jobSlug: 'second' }, 'detail_view')!.journey_id).not.toBe(first.journey_id);
  expect(classifyJobJourneySource('?utm_source=private@example.com', '')).toBe('direct');
  expect(classifyJobJourneySource('', 'https://www.google.ch/search?q=private')).toBe('search');
  expect(sessionStorage.getItem('ft_job_application_journeys_v1')).not.toContain('private');
  window.history.replaceState({}, '', '/');
 });

 it('keeps a midnight crossing in the original cohort and expires it after 30 minutes', async () => {
  vi.useFakeTimers();
  const nearMidnight = new Date(); nearMidnight.setUTCHours(23, 59, 0, 0);
  vi.setSystemTime(nearMidnight);
  const { recordJobJourneyStep } = await import('@/services/jobApplicationJourney');
  const first = recordJobJourneyStep({ jobSlug: 'midnight' }, 'detail_view')!;
  vi.advanceTimersByTime(2 * 60_000);
  expect(recordJobJourneyStep({ jobSlug: 'midnight' }, 'apply_click')).toMatchObject({ journey_cohort: first.journey_cohort, journey_id: first.journey_id });
  vi.advanceTimersByTime(30 * 60_000);
  expect(recordJobJourneyStep({ jobSlug: 'midnight' }, 'detail_view')!.journey_id).not.toBe(first.journey_id);
 });

 it('uses the actual predecessor in the same cohort, never unrelated apply/handoff counts', async () => {
  const { recordJobJourneyStep } = await import('@/services/jobApplicationJourney');
  const events = [];
  for (const [jobSlug, steps] of [
   ['completed', ['detail_view', 'gate_view', 'auth_success', 'apply_click', 'handoff']],
   ['abandoned', ['detail_view', 'gate_view']],
   ['already-signed-in', ['detail_view', 'apply_click', 'handoff']],
  ] as const) for (const step of steps) events.push(recordJobJourneyStep({ jobSlug, employerKey: 'demo' }, step)!);
  const rows = events.map((e) => ({ dimensionValues: [e.journey_context, e.journey_device, e.employer_key].map((value) => ({ value })), metricValues: [{ value: '1' }] }));
  const report = summarizeJourneyRows(rows);
  expect(report.segments[0].transitions['gate_view→auth_success']).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
  expect(report.segments[0].transitions['detail_view→handoff']).toEqual({ numerator: 2, denominator: 3, rate: 2 / 3 });
  expect(report.segments[0].transitions['apply_click→handoff']).toEqual({ numerator: 2, denominator: 2, rate: 1 });
  const date = events[0].journey_cohort;
  expect(journeyReportRequest(date, date).dimensionFilter.andGroup.expressions).toContainEqual({ filter: { fieldName: 'hostName', stringFilter: { value: 'frontaliereticino.ch', matchType: 'EXACT' } } });
 });

 it('keeps an observed transition partial when its predecessor row is missing', () => {
  const report = summarizeJourneyRows([{
   dimensionValues: [
    { value: '2026-10-05|direct|direct|handoff|d>h' },
    { value: 'desktop' },
    { value: 'demo-employer' },
   ],
   metricValues: [{ value: '1' }],
  }]);
  const transition = report.segments[0].transitions['detail_view→handoff'];
  expect(transition).toEqual({ numerator: 1, denominator: 0, rate: null });
  expect(report).toMatchObject({
   quality: 'partial',
   incompleteTransitions: [{ transition: 'detail_view→handoff', numerator: 1, denominator: 0 }],
  });
 });
});

function ReadingProbe({ route }: { route: string }) {
 const ready = useJobReadingIntent(route);
 return <div>{ready ? 'eligible' : 'reading'}</div>;
}
describe('alert reading and frequency controls', () => {
 it('waits for both dwell and scroll, resets on navigation', () => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  const view = render(<ReadingProbe route="first" />);
  act(() => vi.advanceTimersByTime(20_000));
  expect(screen.getByText('reading')).toBeTruthy();
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 200 });
  fireEvent.scroll(window);
  expect(screen.getByText('eligible')).toBeTruthy();
  view.rerender(<ReadingProbe route="second" />);
  expect(screen.getByText('reading')).toBeTruthy();
 });

 it('caps company/category prompts together per session and honors seven-day dismissal', async () => {
  const policy = await import('@/services/jobAlertPromptPolicy');
  expect(policy.canShowJobAlertPrompt()).toBe(true);
  policy.markJobAlertPromptShown();
  expect(policy.canShowJobAlertPrompt()).toBe(false);
  policy.dismissJobAlertPrompt();
  sessionStorage.clear(); vi.resetModules();
  const nextSession = await import('@/services/jobAlertPromptPolicy');
  expect(nextSession.canShowJobAlertPrompt()).toBe(false);
  expect(nextSession.canShowJobAlertPrompt(Date.now() + 8 * 86400_000)).toBe(true);
 });
});
