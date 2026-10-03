import { describe, expect, it } from 'vitest';
import { buildArchiveJobRecommendations } from '../../build-plugins/shared/archiveJobRecommendations';

describe('archived job alternatives', () => {
  it('keeps current employer and fallback recommendations in the original canton', () => {
    const jobs = [
      { slug: 'luzern', company: 'Employer', canton: 'LU' },
      { slug: 'frauenfeld', company: 'Employer', canton: 'TG' },
      { slug: 'locarno', company: 'Employer', canton: 'TI' },
      { slug: 'lugano', company: 'Other', canton: 'TI' },
      { slug: 'closed', company: 'Employer', canton: 'TI', expired: true },
    ];
    const pools = buildArchiveJobRecommendations(jobs);
    expect(pools.companyJobs.get('TI:employer')?.map(j => j.slug)).toEqual(['locarno']);
    expect(pools.recent(0, 'archive', 'TI').map(j => j.slug)).toEqual(['locarno', 'lugano']);
    expect(pools.recent(0, 'locarno', 'TI').map(j => j.slug)).toEqual(['lugano']);
    expect(pools.recent(0, 'archive', 'VS')).toEqual([]);
  });

  it('keeps bounded pools and fills recommendations without repeating a seven-item cycle', () => {
    const pools = buildArchiveJobRecommendations(Array.from({ length: 70 }, (_, i) => ({
      slug: `job-${i}`, company: 'Employer', canton: 'TI',
    })));
    expect(pools.cantonJobs.get('TI')).toHaveLength(50);
    expect(pools.companyJobs.get('TI:employer')).toHaveLength(5);
    const selected = pools.recent(-7, 'job-8', 'TI');
    expect(selected).toHaveLength(5);
    expect(new Set(selected)).toHaveProperty('size', 5);
  });
});
