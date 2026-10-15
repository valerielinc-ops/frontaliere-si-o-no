import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetRuntimeCantonTopicHubs,
  loadCantonTopicHub,
} from '../services/runtimeCantonTopicHubs';
import {
  __resetRuntimeArticleSections,
  isLiveCantonArticleSectionCached,
  loadLiveCantonArticleSections,
} from '../services/runtimeArticleSections';

const COMMIT = 'a'.repeat(40);
const HASH = 'b'.repeat(64);

function documentPayload(commit = COMMIT) {
  return {
    schemaVersion: 1,
    id: 'canton-zh:carburanti',
    section: 'canton-zh',
    canton: 'ZH',
    topic: 'carburanti',
    updatedAt: '2026-10-07T09:49:20.921Z',
    contentHash: HASH,
    locales: {
      it: {
        canton: 'ZH',
        topic: 'carburanti',
        locale: 'it',
        intro: 'Introduzione evergreen del tema carburanti nel cantone.\n\nSecondo paragrafo con contesto utile.',
        keyFacts: [{ label: 'Prezzo medio', value: '1,80 CHF/l' }],
        dataBlocks: [{ id: 'prezzi', title: 'Prezzi correnti', items: [{ label: 'Zurigo', value: '1,80 CHF/l', url: '/carburanti/' }] }],
        curatedArticles: [],
        links: [{ label: 'Confronta i prezzi', url: '/confronti/prezzi-carburanti/' }],
        updatedAt: '2026-10-07T09:49:20.921Z',
      },
    },
    commit,
  };
}

function installFetch(payloadCommit = COMMIT) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/edge/sections/registry.json')) {
      return new Response(JSON.stringify({
        schema: 1,
        commit: COMMIT,
        sections: { 'canton-zh': { status: 'live' } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      schema: 1,
      commit: payloadCommit,
      sections: { 'canton-zh': { carburanti: documentPayload(payloadCommit) } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

afterEach(() => {
  __resetRuntimeArticleSections();
  __resetRuntimeCantonTopicHubs();
  vi.unstubAllGlobals();
});

describe('runtime canton thematic hubs', () => {
  it('accepts a live registry and returns the requested locale payload', async () => {
    installFetch();
    const result = await loadCantonTopicHub('canton-zh', 'carburanti', 'it');
    expect(result).toMatchObject({
      canton: 'ZH',
      topic: 'carburanti',
      locale: 'it',
      keyFacts: [{ label: 'Prezzo medio', value: '1,80 CHF/l' }],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('recovers when the first edge registry JSON request is aborted', async () => {
    let registryAttempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/edge/sections/registry.json')) {
        registryAttempts += 1;
        if (registryAttempts === 1) throw new Error('net::ERR_ABORTED');
        return new Response(JSON.stringify({
          schema: 1,
          commit: COMMIT,
          sections: { 'canton-zh': { status: 'live' } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        schema: 1,
        commit: COMMIT,
        sections: { 'canton-zh': { carburanti: documentPayload() } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await expect(loadCantonTopicHub('canton-zh', 'carburanti', 'it')).resolves.toMatchObject({
      canton: 'ZH',
      topic: 'carburanti',
      locale: 'it',
    });
    expect(registryAttempts).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('adopts a newer payload after the fresh registry confirms the release', async () => {
    const nextCommit = 'd'.repeat(40);
    let registryReads = 0;
    let payloadReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/edge/sections/registry.json')) {
        registryReads += 1;
        const commit = registryReads === 1 ? COMMIT : nextCommit;
        return new Response(JSON.stringify({
          schema: 1,
          commit,
          sections: { 'canton-zh': { status: 'live' } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      payloadReads += 1;
      return new Response(JSON.stringify({
        schema: 1,
        commit: nextCommit,
        sections: { 'canton-zh': { carburanti: documentPayload(nextCommit) } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await expect(loadLiveCantonArticleSections()).resolves.toHaveLength(1);
    expect(isLiveCantonArticleSectionCached('canton-zh')).toBe(true);
    await expect(loadCantonTopicHub('canton-zh', 'carburanti', 'it')).resolves.toMatchObject({
      canton: 'ZH',
      topic: 'carburanti',
      locale: 'it',
    });
    expect(registryReads).toBe(2);
    // The first registry models the old release identity retained by the
    // already-served HTML/SPA handoff. The payload is newer even though the
    // request still carries the old query; one fresh registry read confirms
    // it, so the React hub can mount without a second stale fetch cycle.
    expect(payloadReads).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(isLiveCantonArticleSectionCached('canton-zh')).toBe(true);
  });

  it('rejects a Pages payload whose release commit differs from the edge registry', async () => {
    installFetch('c'.repeat(40));
    await expect(loadCantonTopicHub('canton-zh', 'carburanti', 'it')).resolves.toBeNull();
  });

  it('stops after bounded incoherent retries and cools down remounts', async () => {
    installFetch('c'.repeat(40));

    await expect(loadCantonTopicHub('canton-zh', 'carburanti', 'it')).resolves.toBeNull();
    const firstAttemptRequests = vi.mocked(fetch).mock.calls.length;
    expect(firstAttemptRequests).toBe(9);

    // A remount during the release backoff must keep the static HTML visible
    // without starting another registry/payload loop.
    await expect(loadCantonTopicHub('canton-zh', 'carburanti', 'it')).resolves.toBeNull();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(firstAttemptRequests);
  });
});
