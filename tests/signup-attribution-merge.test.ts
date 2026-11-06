/**
 * Last-touch attribution merge (client writer + LinkedIn Cloud Function) and
 * the explicit CTA of the inline job-gate email unlock.
 *
 * First-touch `source` / `source_channel` are owned elsewhere and must never
 * be produced by these helpers: an attribution write can relabel the last
 * touch, never the origin of the row.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { mergeSourceAttribution } from '@/services/newsletterSubscribers';
import {
  buildSignupAttributionFields,
  sanitizeSignupAttribution,
  sanitizeSignupPath,
} from '../functions/src/lib/signupAttribution.js';

const existingRow = {
  source: 'newsletter_form',
  source_channel: 'newsletter_form',
  source_page: '/calcolatore/',
  source_cta: 'post_calc_newsletter_cta',
  source_component: 'SubscriptionCTA',
  source_route_family: 'calculator',
};

describe('mergeSourceAttribution (client writer)', () => {
  const resolved = { sourcePage: '/', sourceRouteFamily: 'home' };

  it('fill mode (session restore, generic login) never erases the box of an existing row', () => {
    const merged = mergeSourceAttribution(
      { sourcePage: '/', sourceComponent: 'authService', sourceRouteFamily: 'authentication', attributionMode: 'fill' },
      existingRow,
      resolved,
    );
    expect(merged).toEqual({
      source_page: '/calcolatore/',
      source_cta: 'post_calc_newsletter_cta',
      source_component: 'SubscriptionCTA',
      source_route_family: 'calculator',
    });
  });

  it('fill mode still labels a brand-new row', () => {
    const merged = mergeSourceAttribution(
      { sourcePage: '/fisco/', sourceComponent: 'authService', sourceRouteFamily: null, attributionMode: 'fill' },
      undefined,
      { sourcePage: '/fisco/', sourceRouteFamily: 'tax' },
    );
    expect(merged).toEqual({
      source_page: '/fisco/',
      source_cta: null,
      source_component: 'authService',
      source_route_family: 'tax',
    });
  });

  it('overwrite mode (a box started the login) replaces the last touch, family follows the page', () => {
    const merged = mergeSourceAttribution(
      { sourcePage: '/lavoro/', sourceCta: 'lead_magnet_social', sourceComponent: 'LeadMagnetCTA', sourceRouteFamily: null },
      existingRow,
      { sourcePage: '/lavoro/', sourceRouteFamily: 'job-board' },
    );
    expect(merged).toEqual({
      source_page: '/lavoro/',
      source_cta: 'lead_magnet_social',
      source_component: 'LeadMagnetCTA',
      source_route_family: 'job-board',
    });
  });

  it('never emits first-touch fields', () => {
    const merged = mergeSourceAttribution({ sourceCta: 'x' }, existingRow, resolved);
    expect(Object.keys(merged).sort()).toEqual(['source_component', 'source_cta', 'source_page', 'source_route_family']);
  });
});

describe('LinkedIn Cloud Function attribution (functions/src/lib/signupAttribution.js)', () => {
  it('accepts only same-origin pathnames and drops the query', () => {
    expect(sanitizeSignupPath('/lavoro/offerta/?email=a%40b.ch')).toBe('/lavoro/offerta/');
    for (const bad of ['//evil.example/', '/\\evil.example', 'https://evil.example/', 'javascript:x', '', null, 7]) {
      expect(sanitizeSignupPath(bad)).toBeNull();
    }
  });

  it('rejects ids outside the strict charset and non-object payloads', () => {
    expect(sanitizeSignupAttribution({ cta: 'a b', component: '<x>' })).toBeNull();
    expect(sanitizeSignupAttribution(['x'])).toBeNull();
    expect(sanitizeSignupAttribution('x')).toBeNull();
  });

  it('a new LinkedIn row gets the origin page instead of the callback page', () => {
    expect(buildSignupAttributionFields({ page: '/calcolatore/' }, null)).toEqual({ source_page: '/calcolatore/' });
  });

  it('a generic LinkedIn login fills but does not overwrite an existing box attribution', () => {
    expect(buildSignupAttributionFields({ page: '/' }, existingRow)).toEqual({});
    expect(buildSignupAttributionFields({ page: '/fisco/' }, { source_page: '' })).toEqual({ source_page: '/fisco/' });
  });

  it('a LinkedIn login started by a box overwrites the last touch', () => {
    expect(
      buildSignupAttributionFields(
        { page: '/lavoro/', cta: 'lead_magnet_social', component: 'LeadMagnetCTA', routeFamily: 'job-board' },
        existingRow,
      ),
    ).toEqual({
      source_page: '/lavoro/',
      source_cta: 'lead_magnet_social',
      source_component: 'LeadMagnetCTA',
      source_route_family: 'job-board',
    });
  });

  it('never writes first-touch source/source_channel, whatever the payload says', () => {
    const fields = buildSignupAttributionFields(
      { page: '/x/', cta: 'c', component: 'k', source: 'evil', source_channel: 'evil' },
      null,
    );
    expect(fields).not.toHaveProperty('source');
    expect(fields).not.toHaveProperty('source_channel');
  });

  it('the callback wires the sanitized attribution into the subscriber write', () => {
    const root = resolve(__dirname, '..');
    const callback = readFileSync(resolve(root, 'functions/src/linkedinAuthCallback.js'), 'utf8');
    const index = readFileSync(resolve(root, 'functions/index.js'), 'utf8');
    expect(callback).toContain('buildSignupAttributionFields(attribution, existing)');
    expect(callback).toMatch(/export async function handleLinkedInCallback\(\{ code, redirectUri, attribution = null \}\)/);
    expect(index).toContain('handleLinkedInCallback({ code, redirectUri, attribution })');
  });
});

describe('JobBoard inline email unlock CTA', () => {
  const source = readFileSync(resolve(__dirname, '..', 'components/community/JobBoard.tsx'), 'utf8');

  it('passes job_board_email_unlock explicitly for the inline email gate', () => {
    expect(source).toMatch(
      /autoNewsletterSubscribe\(email, `job_gate:\$\{job\.company\}:[^`]*`, 'email', 'job_board_email_unlock', job\)/,
    );
  });

  it('never derives the CTA from the source name', () => {
    const fn = source.slice(
      source.indexOf('const autoNewsletterSubscribe = async ('),
      source.indexOf('} catch { /* non-critical */ return false; }', source.indexOf('const autoNewsletterSubscribe = async (')),
    );
    expect(fn).not.toMatch(/normalizedSource\.includes\('email'\)/);
    expect(fn).toContain("sourceCta || (registrationMethod === 'email' ? 'job_board_email_unlock' : 'job_board_social_unlock')");
  });

  it('writes the job fields of the offer whose title it stamps into `source`', () => {
    // The confirmation email prints the title from `source` next to the
    // company from `job_company`. They used to come from two different jobs in
    // the list modal (`pendingJob` vs `selectedJob || sortedJobs[0]`): 5
    // single-signup documents of March–April 2026 carry both offers
    // (measured 2026-09-25).
    const fn = source.slice(
      source.indexOf('const autoNewsletterSubscribe = async ('),
      source.indexOf('} catch { /* non-critical */ return false; }', source.indexOf('const autoNewsletterSubscribe = async (')),
    );
    expect(fn).toContain('const focusedJob = job;');
    expect(fn.replace(/\/\/.*$/gm, '')).not.toMatch(/sortedJobs|selectedJob/);

    // Every caller passes, as the job, the same variable its `source` suffix
    // reads the company and title from.
    const calls = [...source.matchAll(/autoNewsletterSubscribe\(([^;]*?), (\w+)\)(?:\.then|;)/g)];
    expect(calls.length).toBe(4);
    for (const [call, , jobVar] of calls) {
      const at = source.indexOf(call);
      const window = source.slice(Math.max(0, at - 600), at + call.length);
      expect(window, call).toContain(`\${${jobVar}.company}:\${sanitizeJobTitle(${jobVar}.title)`);
    }
  });
});
