import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DIRECT_EMPLOYER_FLAG,
  PERMANENT_EMPLOYER_COLLECTION,
  PERMANENT_EMPLOYER_MAX_CANDIDATE_MARKS,
  listPermanentEmployerSignals,
  listPermanentEmployers,
  markPermanentEmployer,
  moderatePermanentEmployerSignal,
  readDirectEmployerChannelEnabled,
} from '../functions/src/permanentEmployerCore.js';
import { projectPermanentEmployerFeed } from '../scripts/lib/permanentEmployerProjection.mjs';
import { RC_TO_ENV } from '../scripts/load-rc-env.mjs';
import { buildPermanentEmployerFeed } from '../build-plugins/adminDataPlugin';
import { fetchAndActivate, getConfigValue } from '../services/firebase';
import { readDirectEmployerChannelEnabled as readClientDirectEmployerChannelEnabled } from '../services/directEmployerChannelFlag';
import {
  filterDirectEmployerSitemapXml,
  isDirectEmployerBuildEnabled,
  isDirectEmployerSeoPath,
} from '../services/directEmployerFeature';
import { loadPermanentEmployers } from '../services/directEmployerChannel';
import { normalizeEmployerOrigin } from '../services/employerChannelOrigin.mjs';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function permanentEmployerDb(initial: Record<string, unknown> = {}) {
  const state = { ...initial };
  const ref = {
    id: 'signal-1',
    get: async () => ({ exists: Object.keys(state).length > 0, data: () => state }),
    update: async (patch: Record<string, unknown>) => Object.assign(state, patch),
  };
  const snapshot = {
    id: ref.id,
    get exists() { return Object.keys(state).length > 0; },
    data: () => state,
    ref,
  };
  const docs = [snapshot];
  const collection = {
    doc: () => ref,
    where: () => ({
      orderBy: () => ({
        limit: () => ({
          get: async () => ({ docs }),
        }),
      }),
      limit: () => ({
        get: async () => ({ docs }),
      }),
    }),
  };
  return {
    collection: () => collection,
    runTransaction: async (callback: (transaction: { get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> }>; set: (_ref: unknown, patch: Record<string, unknown>) => void }) => Promise<void>) => callback({
      get: async () => ({ exists: Object.keys(state).length > 0, data: () => state }),
      set: (_ref, patch) => Object.assign(state, patch),
    }),
    state,
  };
}

describe('direct employer SEO flag', () => {
  it('fails closed and filters both public feature routes until explicitly enabled', () => {
    const xml = [
      '<url><loc>https://frontaliereticino.ch/pubblica-offerta-gratuita/</loc></url>',
      '<url><loc>https://frontaliereticino.ch/aziende-candidature-spontanee/</loc></url>',
      '<url><loc>https://frontaliereticino.ch/chi-siamo/</loc></url>',
    ].join('');
    expect(isDirectEmployerBuildEnabled({})).toBe(false);
    expect(isDirectEmployerSeoPath('/pubblica-offerta-gratuita/')).toBe(true);
    expect(filterDirectEmployerSitemapXml(xml, false)).not.toContain('pubblica-offerta-gratuita');
    expect(filterDirectEmployerSitemapXml(xml, false)).not.toContain('aziende-candidature-spontanee');
    expect(filterDirectEmployerSitemapXml(xml, false)).toContain('/chi-siamo/');
    expect(isDirectEmployerBuildEnabled({ DIRECT_EMPLOYER_CHANNEL_ENABLED: 'true' })).toBe(true);
    expect(filterDirectEmployerSitemapXml(xml, true)).toContain('pubblica-offerta-gratuita');
    expect(JSON.parse(buildPermanentEmployerFeed(process.cwd(), false)).employers).toEqual([]);
  });

  it('bridges the owner flag into the static deploy environment', () => {
    expect(RC_TO_ENV.DIRECT_EMPLOYER_CHANNEL_ENABLED).toEqual([DIRECT_EMPLOYER_FLAG]);
  });

  it('keeps an enabled cached flag when activation reports no newer values', async () => {
    vi.mocked(fetchAndActivate).mockResolvedValueOnce(false);
    vi.mocked(getConfigValue).mockResolvedValueOnce('true');

    await expect(readClientDirectEmployerChannelEnabled()).resolves.toBe(true);
  });

  it('emits the prospector feed when the owner flag is enabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'frontaliere-permanent-feed-'));
    const candidatesPath = join(root, 'data/prospector/candidates.json');
    try {
      mkdirSync(`${root}/data/prospector`, { recursive: true });
      writeFileSync(candidatesPath, JSON.stringify({ candidates: {
        'prospector.example': {
          name: 'Prospector Example SA',
          domain: 'prospector.example',
          permanentApplicationOnly: true,
          city: 'Lugano',
        },
      } }));
      const feed = JSON.parse(buildPermanentEmployerFeed(root, true)) as { employers: unknown[] };
      expect(feed.employers).toHaveLength(1);
      expect(feed.employers[0]).toMatchObject({ companyName: 'Prospector Example SA', locationLabel: 'Lugano' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the enabled prospector feed visible when the runtime list is unavailable', async () => {
    vi.mocked(fetchAndActivate).mockResolvedValueOnce(true);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('getPermanentEmployers')) return jsonResponse({ enabled: true, employers: [] }, 503);
      if (url.includes('permanent-employers.json')) {
        return jsonResponse({ employers: [{ id: 'prospector-1', companyName: 'Prospector Example SA', website: 'https://prospector.example/' }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
    try {
      vi.mocked(getConfigValue).mockResolvedValueOnce('true');
      await expect(loadPermanentEmployers()).resolves.toEqual({
        enabled: true,
        employers: [{ id: 'prospector-1', companyName: 'Prospector Example SA', website: 'https://prospector.example/' }],
      });
      expect(fetchAndActivate).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads the flag fail-closed when Remote Config is unavailable', async () => {
    expect(await readDirectEmployerChannelEnabled(async () => 'true')).toBe(true);
    expect(await readDirectEmployerChannelEnabled(async () => { throw new Error('rc unavailable'); })).toBe(false);
  });
});

describe('prospector permanent-employer projection', () => {
  it('publishes only explicit permanent signals and strips operational fields', () => {
    const feed = projectPermanentEmployerFeed({
      updatedAt: daysAgo(1).toISOString(),
      candidates: {
        'salumeria.example': {
          name: 'Salumeria del Borgo SA',
          domain: 'salumeria.example',
          careersUrl: 'https://salumeria.example/candidature/',
          city: 'Mendrisio',
          permanentApplicationOnly: true,
          email: 'must-not-leak@example.test',
        },
        'ordinary.example': {
          name: 'Ordinary Employer SA',
          domain: 'ordinary.example',
          careersUrl: 'https://ordinary.example/jobs/',
          permanentApplications: [],
        },
        'insecure.example': {
          name: 'Insecure Employer SA',
          domain: '',
          careersUrl: 'http://insecure.example/',
          permanentApplications: [{ label: 'Candidatura spontanea' }],
        },
      },
    });

    expect(feed.employers).toHaveLength(1);
    expect(feed.employers[0]).toMatchObject({
      companyName: 'Salumeria del Borgo SA',
      website: 'https://salumeria.example/candidature/',
      locationLabel: 'Mendrisio',
    });
    expect(feed.employers[0]).not.toHaveProperty('email');
    expect(JSON.stringify(feed)).not.toContain('must-not-leak');
  });
});

describe('permanent-employer signals', () => {
  it('caps repeated marks and preserves an already approved signal', async () => {
    const db = permanentEmployerDb({ status: 'approved', candidateMarks: PERMANENT_EMPLOYER_MAX_CANDIDATE_MARKS });
    const result = await markPermanentEmployer({
      data: { companyName: 'Salumeria del Borgo SA', website: 'https://salumeria.example.ch' },
      db,
      now: new Date(),
    });
    expect(result).toEqual({ ok: true, status: 'approved' });
    expect(db.state.candidateMarks).toBe(PERMANENT_EMPLOYER_MAX_CANDIDATE_MARKS);
  });

  it('lists approved employers through the no-argument production call shape', async () => {
    const db = permanentEmployerDb({ status: 'approved', companyName: 'Prospector Employer SA', website: 'https://prospector.example.ch' });
    const employers = await listPermanentEmployers({ db });
    expect(employers).toEqual([{ id: 'signal-1', companyName: 'Prospector Employer SA', website: 'https://prospector.example.ch/', locationLabel: '' }]);
  });

  it('keeps moderation pages scoped to the permanent-employer collection', async () => {
    const db = permanentEmployerDb({ status: 'pending_moderation', companyName: 'Candidate Signal SA', website: 'https://candidate-signal.example.ch' });
    const page = await listPermanentEmployerSignals({ db });
    expect(page.items[0]).toMatchObject({ id: 'signal-1', companyName: 'Candidate Signal SA' });
    expect(PERMANENT_EMPLOYER_COLLECTION).toBe('permanent_employer_signals');
    const moderated = await moderatePermanentEmployerSignal({ id: 'signal-1', action: 'approve', db });
    expect(moderated).toEqual({ ok: true, status: 'approved' });
  });
});

describe('employer origin attribution', () => {
  it('keeps only bounded technical QR/source labels', () => {
    expect(normalizeEmployerOrigin(' Comune Ticino / QR #1 ')).toBe('ComuneTicinoQR1');
    expect(normalizeEmployerOrigin('')).toBe('');
    expect(normalizeEmployerOrigin('a'.repeat(80))).toHaveLength(48);
  });
});
