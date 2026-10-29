import { afterEach, describe, expect, it, vi } from 'vitest';
import { conciergeProposalContext, conciergeProposalJobHref, conciergeServiceHref } from '../services/applicationConciergeNavigation';

afterEach(() => vi.unstubAllGlobals());
describe('concierge internal navigation', () => {
  it('keeps the proposal context distinct from the service-page switch', () => {
    expect(conciergeProposalContext('?concierge_service=service-1&concierge_proposal=proposal-1')).toEqual({ serviceId: 'service-1', proposalId: 'proposal-1' });
    expect(conciergeProposalContext('?concierge_service=service-1')).toBeNull();
    expect(conciergeProposalContext('?concierge_service=..%2Fforeign&concierge_proposal=proposal-1')).toBeNull();
    const href = conciergeServiceHref('service-1', 'it', 'child-1');
    expect(href).toBe('/automatizza-ricerca-lavoro-svizzera/?application_concierge_service_id=service-1&application_concierge_application_id=child-1');
    expect(href).not.toContain('token');
  });
  it('opens the published internal locale detail under the correct canton', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ slugByLocale: { it: 'responsabile-it' }, addressRegion: 'ZH', addressLocality: 'Zürich' }) })));
    const href = await conciergeProposalJobHref({ jobId: 'job-1', proposalId: 'proposal-1' } as any, 'service-1', 'it');
    expect(href).toBe('/cerca-lavoro-zurigo/responsabile-it/?concierge_service=service-1&concierge_proposal=proposal-1');
    expect(href).not.toContain('application_concierge_service_id');
  });
  it('does not guess a slug or redirect to an employer when the internal detail is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    await expect(conciergeProposalJobHref({ jobId: 'job-1', proposalId: 'proposal-1' } as any, 'service-1', 'it')).rejects.toThrow('job_not_found');
  });
});
