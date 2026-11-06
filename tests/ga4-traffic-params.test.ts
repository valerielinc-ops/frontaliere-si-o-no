import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
 GA4_SESSION_IDLE_MS,
 isStalePassiveGa4Event,
 neutralizeGa4TrafficParams,
} from '@/services/ga4TrafficParams';

const analyticsSource = readFileSync(resolve(__dirname, '../services/analytics.ts'), 'utf8');

describe('neutralizeGa4TrafficParams', () => {
 it('renames every parameter GA4 reads as traffic attribution', () => {
  expect(neutralizeGa4TrafficParams({
   source: 'direct', medium: 'direct', campaign: '(none)', term: '(none)', content: '(none)', referrer_host: 'direct',
  })).toEqual({
   event_source: 'direct',
   event_medium: 'direct',
   event_campaign: '(none)',
   event_term: '(none)',
   event_content: '(none)',
   referrer_host: 'direct',
  });
 });

 it('leaves events without those parameters untouched', () => {
  expect(neutralizeGa4TrafficParams({ step: 'entry', page_path: '/' })).toEqual({ step: 'entry', page_path: '/' });
 });

 it('runs on the single Firebase path, after the PostHog mirror', () => {
  const body = analyticsSource.slice(analyticsSource.indexOf('const logFirebaseOnly ='), analyticsSource.indexOf('const log = ('));
  expect(body).toContain('params = neutralizeGa4TrafficParams(params);');
  const log = analyticsSource.slice(analyticsSource.indexOf('const log = ('));
  expect(log.indexOf('posthogCapture(eventName, enrichedParams)')).toBeLessThan(log.indexOf('logFirebaseOnly(eventName, enrichedParams)'));
 });
});

describe('isStalePassiveGa4Event', () => {
 const lastEventAt = 1_000_000;

 it('drops a passive event sent after the session expired', () => {
  expect(isStalePassiveGa4Event('session_end', lastEventAt, lastEventAt + GA4_SESSION_IDLE_MS)).toBe(true);
  expect(isStalePassiveGa4Event('web_vitals', lastEventAt, lastEventAt + GA4_SESSION_IDLE_MS)).toBe(true);
  expect(isStalePassiveGa4Event('ad_page_diag', lastEventAt, lastEventAt + GA4_SESSION_IDLE_MS)).toBe(true);
 });

 it('keeps it while the session is alive and on the first event of the page', () => {
  expect(isStalePassiveGa4Event('session_end', lastEventAt, lastEventAt + GA4_SESSION_IDLE_MS - 1)).toBe(false);
  expect(isStalePassiveGa4Event('session_end', null, lastEventAt)).toBe(false);
 });

 it('never drops an event caused by the user', () => {
  expect(isStalePassiveGa4Event('page_view', lastEventAt, lastEventAt + 2 * GA4_SESSION_IDLE_MS)).toBe(false);
 });
});
