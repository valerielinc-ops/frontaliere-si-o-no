import { describe, expect, it, vi } from 'vitest';

const registryFixture = vi.hoisted(() => ({
  platforms: {
    'unknown-owner.example': {
      domain: 'unknown-owner.example',
      status: 'confirmed',
      tenantShape: 'mixed',
      hostEmployers: { 'acme.unknown-owner.example': ['owner.ch'] },
      hostEmployerUnknown: { 'acme.unknown-owner.example': true },
    },
    'mismatch-owner.example': {
      domain: 'mismatch-owner.example',
      status: 'confirmed',
      tenantShape: 'subdomain',
      hostEmployers: { 'acme.mismatch-owner.example': ['owner.ch'] },
    },
    'generic-owner.example': {
      domain: 'generic-owner.example',
      status: 'confirmed',
      tenantShape: 'subdomain',
      hostEmployers: { 'jobs.generic-owner.example': ['owner.ch'] },
    },
  } as Record<string, any>,
}));

vi.mock('../scripts/lib/prospector/platform-registry.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scripts/lib/prospector/platform-registry.mjs')>(),
  loadRegistry: () => structuredClone(registryFixture),
}));

const { upsertCandidate } = await import('../scripts/lib/prospector/candidate-store.mjs');

function storeWith() {
  return { version: 1, updatedAt: null, candidates: {}, rejectedTombstones: {} };
}

describe('composed tenant-key host ownership', () => {
  it('rejects a host with an unknown owner even when one verified owner is recorded', () => {
    const store = storeWith();

    const result = upsertCandidate(store, {
      key: 'acme@unknown-owner.example',
      name: 'Acme Holdings',
      city: 'Lugano',
      tenantHost: 'acme.unknown-owner.example',
      platform: 'unknown-owner.example',
    }, 'tenant:unknown-owner.example');

    expect(result).toEqual({ key: 'acme-holdings@lugano', created: true });
    expect(store.candidates).not.toHaveProperty('acme@unknown-owner.example');
  });

  it('lets a verified employer domain override a mismatched tenant-host owner', () => {
    const store = storeWith();

    const result = upsertCandidate(store, {
      key: 'acme@mismatch-owner.example',
      name: 'Acme Holdings',
      domain: 'other-employer.ch',
      tenantHost: 'acme.mismatch-owner.example',
      platform: 'mismatch-owner.example',
    }, 'tenant:mismatch-owner.example');

    expect(result).toEqual({ key: 'other-employer.ch', created: true });
    expect(store.candidates).not.toHaveProperty('acme@mismatch-owner.example');
  });

  it('does not trust generic tenant labels even with a singleton verified owner', () => {
    const store = storeWith();

    const result = upsertCandidate(store, {
      key: 'jobs@generic-owner.example',
      name: 'Acme Holdings',
      city: 'Lugano',
      tenantHost: 'jobs.generic-owner.example',
      platform: 'generic-owner.example',
    }, 'tenant:generic-owner.example');

    expect(result).toEqual({ key: 'acme-holdings@lugano', created: true });
    expect(store.candidates).not.toHaveProperty('jobs@generic-owner.example');
  });
});
