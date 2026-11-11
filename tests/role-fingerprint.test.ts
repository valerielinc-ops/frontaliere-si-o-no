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
});
