/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeHtmlForReuse,
  refreshHtmlBuildId,
  stripHtmlBuildId,
} from '../../build-plugins/shared/incrementalHtmlReuse.mjs';

const envBefore = process.env.STATIC_BUILD_ID_META;

afterEach(() => {
  if (envBefore === undefined) delete process.env.STATIC_BUILD_ID_META;
  else process.env.STATIC_BUILD_ID_META = envBefore;
  vi.resetModules();
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
  window.sessionStorage.clear();
});

async function loadTemplate(flag: string | undefined) {
  if (flag === undefined) delete process.env.STATIC_BUILD_ID_META;
  else process.env.STATIC_BUILD_ID_META = flag;
  vi.resetModules();
  const constants = await import('../../build-plugins/constants');
  const template = await import('../../build-plugins/htmlTemplate');
  return { constants, headPrefix: template.HEAD_PREFIX };
}

describe('STATIC_BUILD_ID_META', () => {
  it('keeps the per-build marker on static pages when unset', async () => {
    const { constants, headPrefix } = await loadTemplate(undefined);
    expect(constants.STATIC_PAGE_BUILD_ID).toBe(constants.BUILD_ID);
    expect(headPrefix).toContain(`<meta name="ft-build-id" content="${constants.BUILD_ID}">`);
  });

  it('drops the marker from static pages only when set to off', async () => {
    const { constants, headPrefix } = await loadTemplate('off');
    expect(constants.STATIC_PAGE_BUILD_ID).toBeNull();
    expect(headPrefix).not.toContain('ft-build-id');
    // The Vite shell keeps it through buildIdPlugin.transformIndexHtml.
    expect(constants.BUILD_ID_META_TAG).toContain('name="ft-build-id"');
  });

  it('makes the static head byte-identical across two builds of the same sha', async () => {
    const first = await loadTemplate('off');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await loadTemplate('off');
    expect(second.constants.BUILD_ID).not.toBe(first.constants.BUILD_ID);
    expect(second.headPrefix).toBe(first.headPrefix);
  });

  it('strips the marker from cached pages so reuse matches a fresh render', async () => {
    const tagged = await loadTemplate(undefined);
    const off = await loadTemplate('off');
    expect(stripHtmlBuildId(tagged.headPrefix)).toBe(off.headPrefix);
    expect(normalizeHtmlForReuse(tagged.headPrefix)).toBe(normalizeHtmlForReuse(off.headPrefix));
  });
});

describe('ft-build-id marker patterns', () => {
  it('matches quoted, unquoted and reversed spellings', () => {
    for (const tag of [
      '<meta name="ft-build-id" content="1789793330100">',
      '<meta name=ft-build-id content=1789793330100>',
      "<meta content='1' name='ft-build-id'>",
    ]) {
      expect(stripHtmlBuildId(`<head>${tag}<link rel=x></head>`)).toBe('<head><link rel=x></head>');
    }
  });

  it('leaves other meta tags and the legacy refresh path alone', () => {
    const html = '<meta name="ft-build-id-other" content="1"><meta name="robots" content="index">';
    expect(stripHtmlBuildId(html)).toBe(html);
    expect(refreshHtmlBuildId('<meta name="ft-build-id" content="old">', '123')).toBe('<meta name="ft-build-id" content="123">');
  });
});

describe('readBuildIdForTelemetry', () => {
  it('prefers the document marker', async () => {
    document.head.innerHTML = '<meta name="ft-build-id" content="1789306155656">';
    const { readBuildIdForTelemetry } = await import('../../services/buildInfo');
    expect(readBuildIdForTelemetry()).toBe('1789306155656');
  });

  it('falls back to /build-id.txt on a static page without the marker', async () => {
    const fetchMock = vi.fn(async () => new Response('1789819319547\n', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { readBuildIdForTelemetry } = await import('../../services/buildInfo');
    expect(readBuildIdForTelemetry()).toBe('');
    expect(readBuildIdForTelemetry()).toBe('');
    await vi.waitFor(() => expect(window.sessionStorage.getItem('ft-build-id')).toBe('1789819319547'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readBuildIdForTelemetry()).toBe('1789819319547');
  });

  it('ignores a non-numeric body (for example an HTML 404 page)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { status: 200 })));
    const { fetchBuildId, readBuildIdForTelemetry } = await import('../../services/buildInfo');
    await fetchBuildId();
    expect(readBuildIdForTelemetry()).toBe('');
  });
});
