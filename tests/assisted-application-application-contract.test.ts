import { describe, expect, it } from 'vitest';
import {
  applicationContractFromPreflight,
  applicationContractFromSubmission,
  compactApplicationContract,
  mergeApplicationContracts,
  safeApplicationLocation,
} from '../scripts/assisted-application/lib/portal/application-contract.mjs';
import { portalApplicationContractView } from '../functions/src/lib/portalApplicationContract.js';

describe('assisted application portal contract', () => {
  it('keeps locations metadata-only and strips query, fragment and path tokens', () => {
    expect(safeApplicationLocation('https://jobs.example.test/apply?email=secret#token')).toEqual({
      origin: 'https://jobs.example.test',
      path: '/apply',
    });
    expect(safeApplicationLocation('https://jobs.example.test/session/eyJsecret-token-value-12345/form')).toEqual({
      origin: 'https://jobs.example.test',
      path: '/session/:redacted/form',
    });
    expect(safeApplicationLocation('https://user:password@jobs.example.test/apply')).toBeNull();
  });

  it('summarizes the preflight form and background API without request bodies', () => {
    const contract = applicationContractFromPreflight({
      channelType: 'employer_site',
      applyUrl: 'https://jobs.example.test/apply?candidate=secret',
      sourceUrl: 'https://jobs.example.test/jobs/12345678',
      currentUrl: 'https://ats.example.test/form/123',
      snapshot: {
        fields: [
          { required: true, kind: 'text' },
          { required: true, kind: 'file', inputType: 'file' },
          { required: false, kind: 'text' },
        ],
      },
      postingMatch: 'match',
      status: 'ready',
      questions: [{ required: true }, { required: false }],
      documents: [{ required: true }],
      diagnostics: {
        requests: [
          { host: 'ats.example.test', path: '/api/form?candidate=secret', method: 'POST', resourceType: 'fetch', body: 'must-not-survive' },
          { host: 'ats.example.test', path: '/api/form?candidate=secret', method: 'POST', resourceType: 'fetch', body: 'must-not-survive' },
        ],
        responses: [{ host: 'ats.example.test', path: '/api/form?candidate=secret', method: 'POST', resourceType: 'fetch', status: 200 }],
      },
    });

    expect(contract).toMatchObject({
      phase: 'preflight',
      status: 'ready',
      postingMatch: 'match',
      form: { fieldCount: 3, requiredFieldCount: 2, requiredFileCount: 1 },
      missing: { questionCount: 2, requiredQuestionCount: 1, documentCount: 1, requiredDocumentCount: 1 },
      background: { status: 'observed', readOnly: true, requestCount: 1, mutatingRequestCount: 1 },
      submit: { capability: 'xhr_fetch', status: 'not_started' },
    });
    expect(JSON.stringify(contract)).not.toContain('candidate=secret');
    expect(JSON.stringify(contract)).not.toContain('must-not-survive');
  });

  it('keeps unknown when no background contract was observed', () => {
    const contract = applicationContractFromPreflight({ channelType: 'employer_site', applyUrl: 'https://jobs.example.test/apply', snapshot: { fields: [] } });
    expect(contract.background).toMatchObject({ status: 'unknown', readOnly: true, requestCount: 0 });
    expect(contract.submit).toMatchObject({ capability: 'unknown', status: 'not_started' });
  });

  it('merges the submit observation without losing preflight missing requirements', () => {
    const preflight = applicationContractFromPreflight({
      channelType: 'greenhouse',
      applyUrl: 'https://jobs.example.test/apply',
      snapshot: { fields: [{ required: true }] },
      questions: [{ required: true }],
      documents: [{ required: true }],
      diagnostics: { requests: [], responses: [] },
      status: 'ready',
    });
    const submission = applicationContractFromSubmission({
      channelType: 'greenhouse',
      applyUrl: 'https://jobs.example.test/apply',
      currentUrl: 'https://jobs.example.test/thanks?private=1',
      diagnostics: {
        requests: [{ host: 'jobs.example.test', path: '/submit?private=1', method: 'POST', resourceType: 'document' }],
        responses: [{ host: 'jobs.example.test', path: '/submit?private=1', method: 'POST', resourceType: 'document', status: 200 }],
      },
      outcome: 'confirmed',
    });
    const merged = mergeApplicationContracts(preflight, submission);
    expect(merged).toMatchObject({
      phase: 'submission',
      status: 'submitted',
      missing: { requiredQuestionCount: 1, requiredDocumentCount: 1 },
      submit: { capability: 'native_form', status: 'confirmed', outcome: 'confirmed' },
    });
    expect(JSON.stringify(merged)).not.toContain('private=1');
  });

  it('bounds and revalidates endpoint metadata before persistence', () => {
    const compact = compactApplicationContract({
      phase: 'submission',
      applyUrl: 'https://jobs.example.test/session/12345678?token=secret',
      background: {
        status: 'observed',
        requests: [
          { method: 'POST', resourceType: 'fetch', endpoint: { origin: 'https://jobs.example.test', path: '/api?secret=1' }, status: 200 },
          { method: 'POST', resourceType: 'fetch', endpoint: { origin: 'http://not-allowed.test', path: '/api' }, status: 200 },
        ],
      },
      submit: { capability: 'xhr_fetch', status: 'unknown' },
    });
    expect(compact?.applyUrl).toEqual({ origin: 'https://jobs.example.test', path: '/session/:id' });
    expect(compact?.background?.requests).toHaveLength(1);
    expect(compact?.background?.requests[0]).toMatchObject({ endpoint: { path: '/api' } });
    expect(JSON.stringify(compact)).not.toContain('secret=1');
    expect(JSON.stringify(compact)).not.toContain('not-allowed.test');
  });

  it('does not expose endpoint inventory on the candidate review projection', () => {
    const contract = applicationContractFromPreflight({
      channelType: 'greenhouse',
      applyUrl: 'https://jobs.example.test/apply',
      snapshot: { fields: [{ required: true }] },
      diagnostics: {
        requests: [{ host: 'jobs.example.test', path: '/api/form', method: 'GET', resourceType: 'fetch' }],
        responses: [{ host: 'jobs.example.test', path: '/api/form', method: 'GET', resourceType: 'fetch', status: 200 }],
      },
      status: 'ready',
    });
    const candidate = portalApplicationContractView(contract, { includeEndpoints: false });
    const owner = portalApplicationContractView(contract, { includeEndpoints: true });
    expect(candidate?.background).not.toHaveProperty('requests');
    expect(owner?.background?.requests).toHaveLength(1);
  });
});
