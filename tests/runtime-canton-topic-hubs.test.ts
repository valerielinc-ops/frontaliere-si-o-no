import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetRuntimeCantonTopicHubs,
  loadCantonTopicHub,
} from '../services/runtimeCantonTopicHubs';
import {
  __resetRuntimeArticleSections,
  isLiveCantonArticleSectionCached,
  loadCantonSectionRegistry,
  loadLiveCantonArticleSections,
} from '../services/runtimeArticleSections';

const COMMIT = 'a'.repeat(40);
const OLD_COMMIT = 'c'.repeat(40);
const NEW_COMMIT = 'd'.repeat(40);
const HASH = 'b'.repeat(64);

function releaseDocument(commit: string) {
  return {
    commit,
    base: `edge/sections/_releases/${commit}/`,
    files: { 'canton-hubs.json': { sha256: HASH, bytes: 1 } },
  };
}

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
        latestCantonArticles: [],
        links: [{ label: 'Confronta i prezzi', url: '/confronti/prezzi-carburanti/' }],
        updatedAt: '2026-10-07T09:49:20.921Z',
      },
    },
    commit,
  };
}

function registryDocument(commit = COMMIT) {
  return {
    schema: 1,
    commit,
    release: releaseDocument(commit),
    sections: { 'canton-zh': { status: 'live' } },
  };
}

function hubDocument(commit = COMMIT) {
  return {
    schema: 1,
    commit,
    sections: { 'canton-zh': { carburanti: documentPayload(commit) } },
  };
}

function installFetch({ payloadCommit = COMMIT, payload }: { payloadCommit?: string; payload?: unknown } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/edge/sections/registry.json')) {
      return new Response(JSON.stringify(registryDocument()), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/edge/sections/_releases/')) {
      return new Response(JSON.stringify(payload ?? hubDocument(payloadCommit)), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(null, { status: 404 });
  }));
}

afterEach(() => {
  __resetRuntimeArticleSections();
  __resetRuntimeCantonTopicHubs();
  vi.unstubAllGlobals();
});

describe('runtime canton thematic hubs', () => {
  it('fails closed when release byte metadata is not a number', async () => {
    const registry = registryDocument();
    Object.assign(registry.release.files['canton-hubs.json'], { bytes: '1' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(registry), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    await expect(loadCantonSectionRegistry()).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

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
        return new Response(JSON.stringify(registryDocument()), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(hubDocument()), { status: 200, headers: { 'content-type': 'application/json' } });
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
    let registryReads = 0;
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/edge/sections/registry.json')) {
        registryReads += 1;
        return new Response(JSON.stringify(registryDocument(registryReads === 1 ? OLD_COMMIT : NEW_COMMIT)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes(`/_releases/${OLD_COMMIT}/canton-hubs.json`)) return new Response(null, { status: 404 });
      if (url.includes(`/_releases/${NEW_COMMIT}/canton-hubs.json`)) {
        return new Response(JSON.stringify(hubDocument(NEW_COMMIT)), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    }));

    // The first registry read represents the old release identity retained by
    // the static HTML/SPA handoff. The old immutable object is unavailable;
    // the bounded refresh must move to the new registry and its object.
    await expect(loadLiveCantonArticleSections()).resolves.toHaveLength(1);
    await expect(loadCantonTopicHub('canton-zh', 'carburanti', 'it')).resolves.toMatchObject({
      canton: 'ZH',
      topic: 'carburanti',
      locale: 'it',
    });
    expect(registryReads).toBe(2);
    expect(urls).toEqual([
      'https://cdn.frontaliereticino.ch/edge/sections/registry.json',
      `https://cdn.frontaliereticino.ch/edge/sections/_releases/${OLD_COMMIT}/canton-hubs.json`,
      'https://cdn.frontaliereticino.ch/edge/sections/registry.json',
      `https://cdn.frontaliereticino.ch/edge/sections/_releases/${NEW_COMMIT}/canton-hubs.json`,
    ]);
    expect(urls.some((url) => url.includes('nanakokyobashi-rgb.github.io') || url.includes('?commit='))).toBe(false);
    expect(isLiveCantonArticleSectionCached('canton-zh')).toBe(true);
  });

  it('adopts a newer body only after a fresh registry confirms the release', async () => {
    let registryReads = 0;
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/edge/sections/registry.json')) {
        registryReads += 1;
        return new Response(JSON.stringify(registryDocument(registryReads === 1 ? OLD_COMMIT : NEW_COMMIT)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(hubDocument(NEW_COMMIT)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    await expect(loadLiveCantonArticleSections()).resolves.toHaveLength(1);
    await expect(loadCantonTopicHub('canton-zh', 'carburanti', 'it')).resolves.toMatchObject({
      canton: 'ZH',
      topic: 'carburanti',
      locale: 'it',
    });
    expect(registryReads).toBe(2);
    expect(urls).toEqual([
      'https://cdn.frontaliereticino.ch/edge/sections/registry.json',
      `https://cdn.frontaliereticino.ch/edge/sections/_releases/${OLD_COMMIT}/canton-hubs.json`,
      'https://cdn.frontaliereticino.ch/edge/sections/registry.json',
    ]);
  });

  it('rejects an incoherent versioned payload without an unbounded fetch loop', async () => {
    installFetch({ payloadCommit: OLD_COMMIT });
    await expect(loadCantonTopicHub('canton-zh', 'carburanti', 'it')).resolves.toBeNull();
    const firstAttemptRequests = vi.mocked(fetch).mock.calls.length;
    expect(firstAttemptRequests).toBe(9);

    // A remount during the release backoff keeps the static HTML visible and
    // cannot start another registry/payload loop.
    await expect(loadCantonTopicHub('canton-zh', 'carburanti', 'it')).resolves.toBeNull();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(firstAttemptRequests);
  });

  it('fails closed when an optional data date has a non-string JSON type', async () => {
    const malformed = documentPayload();
    Object.assign(malformed.locales.it.dataBlocks[0].items[0], { date: 42 });
    installFetch({ payload: {
      ...hubDocument(),
      sections: { 'canton-zh': { carburanti: malformed } },
    } });

    await expect(loadCantonTopicHub('canton-zh', 'carburanti', 'it')).resolves.toBeNull();
  });
});
