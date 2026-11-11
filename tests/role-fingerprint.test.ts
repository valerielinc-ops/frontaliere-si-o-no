import { describe, expect, it } from 'vitest';
import {
  normalizeRoleText,
  stripTrailingClause,
  computeRoleFingerprint,
  collapseMultiCityRoles
} from '../scripts/lib/role-fingerprint.mjs';

describe('normalizeRoleText', () => {
  it('rimuove tag HTML preservando gli spazi e decodifica le entità', () => {
    const raw = '<p>Senior &amp; Lead <strong>Developer</strong></p>';
    expect(normalizeRoleText(raw)).toBe('senior & lead developer');
  });

  it('collassa spazi multipli, newline e trimma', () => {
    const raw = '   Fullstack   \n\t Engineer   ';
    expect(normalizeRoleText(raw)).toBe('fullstack engineer');
  });
});

describe('stripTrailingClause', () => {
  it('rimuove la sede dopo virgola, trattino o pipe', () => {
    expect(stripTrailingClause('Senior Java Developer, Lugano')).toBe('Senior Java Developer');
    expect(stripTrailingClause('DevOps Engineer - Zürich')).toBe('DevOps Engineer');
    expect(stripTrailingClause('Frontend Architect | Bellinzona')).toBe('Frontend Architect');
  });

  it('applica il two-word guard per non ridurre titoli a singola parola', () => {
    expect(stripTrailingClause('Accountant - Chiasso')).toBe('Accountant - Chiasso');
    expect(stripTrailingClause('Infermiera, Mendrisio')).toBe('Infermiera, Mendrisio');
  });
});

describe('computeRoleFingerprint', () => {
  it('genera lo stesso fingerprint per lo stesso annuncio in città diverse', () => {
    const desc = '<p>Cerchiamo un ingegnere software per la nostra sede svizzera con esperienza TypeScript.</p>';
    const fpLugano = computeRoleFingerprint('adecco', 'Senior Software Engineer, Lugano', desc);
    const fpZurigo = computeRoleFingerprint('adecco', 'Senior Software Engineer - Zürich', desc);

    expect(fpLugano).toBe(fpZurigo);
    expect(fpLugano).toMatch(/^[a-f0-9]{64}$/);
  });

  it('genera fingerprint diversi se la descrizione o l azienda cambiano', () => {
    const fp1 = computeRoleFingerprint('rolex', 'Senior Software Engineer', 'Descrizione A');
    const fp2 = computeRoleFingerprint('ubs', 'Senior Software Engineer', 'Descrizione A');
    const fp3 = computeRoleFingerprint('rolex', 'Senior Software Engineer', 'Descrizione B');

    expect(fp1).not.toBe(fp2);
    expect(fp1).not.toBe(fp3);
  });
});

describe('collapseMultiCityRoles', () => {
  it('collassa annunci identici in sedi diverse aggregando copies', () => {
    const jobs = [
      {
        id: 'job_1',
        companySlug: 'michael-page',
        title: 'Cloud Architect, Lugano',
        description: '<p>Requisiti: AWS, Terraform</p>',
        location: 'Lugano',
        canton: 'TI',
        slug: 'cloud-architect-lugano'
      },
      {
        id: 'job_2',
        companySlug: 'michael-page',
        title: 'Cloud Architect - Basel',
        description: '<p>Requisiti: AWS, Terraform</p>',
        location: 'Basel',
        canton: 'BS',
        slug: 'cloud-architect-basel'
      },
      {
        id: 'job_3',
        companySlug: 'ubs',
        title: 'Security Officer',
        description: '<p>Cybersecurity role</p>',
        location: 'Zürich',
        canton: 'ZH',
        slug: 'security-officer-zurich'
      }
    ];

    const collapsed = collapseMultiCityRoles(jobs);
    expect(collapsed).toHaveLength(2);

    const mpJob = collapsed.find(j => j.companySlug === 'michael-page');
    expect(mpJob).toBeDefined();
    expect(mpJob?.id).toBe('job_1');
    expect(mpJob?.copies).toHaveLength(1);
    expect(mpJob?.copies[0]).toEqual({
      id: 'job_2',
      location: 'Basel',
      canton: 'BS',
      applicationUrl: undefined,
      slug: 'cloud-architect-basel'
    });

    const ubsJob = collapsed.find(j => j.companySlug === 'ubs');
    expect(ubsJob?.copies).toHaveLength(0);
  });

  it('uses a real company name when an adapter has no companySlug', () => {
    const collapsed = collapseMultiCityRoles([
      { id: 'a-lugano', company: 'Employer A', companySlug: '', title: 'Senior Engineer', description: 'Same role', location: 'Lugano' },
      { id: 'a-zurich', company: 'Employer A', companySlug: '', title: 'Senior Engineer', description: 'Same role', location: 'Zürich' },
      { id: 'b-basel', company: 'Employer B', companySlug: '', title: 'Senior Engineer', description: 'Same role', location: 'Basel' },
    ]);

    expect(collapsed).toHaveLength(2);
    expect(collapsed.find(job => job.company === 'Employer A')?.copies).toHaveLength(1);
    expect(collapsed.find(job => job.company === 'Employer B')?.copies).toHaveLength(0);
  });

  it('keeps missing or placeholder employer names out of cross-employer collapse', () => {
    const collapsed = collapseMultiCityRoles([
      { id: 'unknown-a', company: 'Datore di Lavoro Svizzero', title: 'Senior Engineer', description: 'Same role' },
      { id: 'unknown-b', company: 'Azienda Svizzera', title: 'Senior Engineer', description: 'Same role' },
      { id: 'unknown-c', company: '', title: 'Senior Engineer', description: 'Same role' },
      { id: 'unknown-d', company: 'Confidential', title: 'Senior Engineer', description: 'Same role' },
      { id: 'unknown-e', company: 'N/A', title: 'Senior Engineer', description: 'Same role' },
      { id: 'unknown-f', company: 'Private Company', title: 'Senior Engineer', description: 'Same role' },
      { id: 'unknown-g', company: 'Not specified', title: 'Senior Engineer', description: 'Same role' },
      { id: 'unknown-h', company: 'Not available', title: 'Senior Engineer', description: 'Same role' },
      { id: 'unknown-i', company: 'Not provided', title: 'Senior Engineer', description: 'Same role' },
      { id: 'unknown-j', company: 'Not stated', title: 'Senior Engineer', description: 'Same role' },
      { id: 'unknown-k', company: 'Anonymous', title: 'Senior Engineer', description: 'Same role' },
      { id: 'unknown-l', company: 'Company not disclosed', title: 'Senior Engineer', description: 'Same role' },
      { id: 'unknown-m', company: 'No employer name', title: 'Senior Engineer', description: 'Same role' },
      { id: 'unknown-n', company: 'No name', title: 'Senior Engineer', description: 'Same role' },
    ]);

    expect(collapsed).toHaveLength(14);
    expect(collapsed.every(job => job.copies.length === 0)).toBe(true);
  });
});
