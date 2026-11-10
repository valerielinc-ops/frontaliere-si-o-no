import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { listStaticScriptFiles } from '@/build-plugins/staticScriptsPlugin';
import { META_PIXEL_LOADER_VERSIONED_FILENAME } from '@/build-plugins/constants';

import { claim, getDeployManifestHash, hashContent, reset } from '@/build-plugins/sharedWriteRegistry';
import {
  META_PIXEL_BASE_CODE,
  META_PIXEL_LOADER_CONTENT,
  META_PIXEL_LOADER_FILENAME,
  META_PIXEL_MANIFEST_FINGERPRINT,
  META_PIXEL_MARKER,
  injectMetaPixelBaseCode,
  metaPixelBaseCodePlugin,
} from '@/build-plugins/metaPixelBaseCodePlugin';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-pixel-base-code-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  reset();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('metaPixelBaseCodePlugin', () => {
  it('injects the consent-gated loader into the Vite-owned index without a noscript bypass', async () => {
    const root = makeTempRoot();
    const dist = path.join(root, 'dist');
    const pages = [
      path.join(dist, 'index.html'),
      path.join(dist, 'en', 'privacy', 'index.html'),
    ];
    for (const file of pages) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const initial = '<!doctype html><html><head><title>Page</title></head><body>content</body></html>';
      fs.writeFileSync(file, initial);
      claim(file, 'test-html-emitter', initial);
    }

    const plugin = metaPixelBaseCodePlugin(root) as unknown as {
      transformIndexHtml: { handler: (html: string) => string };
      closeBundle: { handler: () => void };
    };
    const transformed = plugin.transformIndexHtml.handler(fs.readFileSync(pages[0], 'utf8'));

    expect(transformed.indexOf(META_PIXEL_MARKER)).toBeGreaterThan(transformed.indexOf('<head>'));
    expect(transformed.indexOf(META_PIXEL_MARKER)).toBeLessThan(transformed.indexOf('</head>'));
    expect(transformed).toContain(META_PIXEL_BASE_CODE);
    expect(transformed).toContain(`<script defer src="/assets/${META_PIXEL_LOADER_FILENAME}"></script>`);
    expect(transformed).not.toContain('<noscript>');
    expect(transformed).not.toContain('facebook.com/tr?id=1090503593451766');

    plugin.closeBundle.handler();
    for (const file of pages) {
      expect(fs.readFileSync(file, 'utf8')).not.toContain(META_PIXEL_MARKER);
      const initialHash = hashContent('<!doctype html><html><head><title>Page</title></head><body>content</body></html>');
      expect(getDeployManifestHash(file, initialHash))
        .toBe(hashContent(`${initialHash}\0${META_PIXEL_MANIFEST_FINGERPRINT}`));
    }

    expect(META_PIXEL_LOADER_CONTENT).toContain("n('init', '1090503593451766')");
    expect(META_PIXEL_LOADER_CONTENT).toContain("n('track', 'PageView')");
    const assets = new Map(listStaticScriptFiles());
    expect(assets.get(META_PIXEL_LOADER_FILENAME)).toBe(META_PIXEL_LOADER_CONTENT);
    expect(assets.get(META_PIXEL_LOADER_VERSIONED_FILENAME)).toBe(META_PIXEL_LOADER_CONTENT);
  });

  it('fails rather than silently skipping an HTML page without a head close tag', () => {
    expect(() => injectMetaPixelBaseCode('<html><body>missing head</body></html>'))
      .toThrow(/no closing <\/head>/i);
  });

  it('does not load Meta on a credential-bearing document', () => {
    const dom = new JSDOM(
      `<!doctype html><head><script defer src="/assets/${META_PIXEL_LOADER_FILENAME}"></script></head><body></body>`,
      {
        url: 'https://frontaliereticino.ch/?ne=candidate%40example.test&ac=synthetic-code',
        runScripts: 'outside-only',
      },
    );

    try {
      dom.window.localStorage.setItem('frontaliere_ads_consent', 'granted');
      vm.runInContext(META_PIXEL_LOADER_CONTENT, dom.getInternalVMContext());

      expect(dom.window.document.querySelector('script[src*="connect.facebook.net"]')).toBeNull();
      expect((dom.window as unknown as { fbq?: unknown }).fbq).toBeUndefined();
      expect((dom.window as unknown as { __FT_META_PIXEL_DISABLED__?: boolean }).__FT_META_PIXEL_DISABLED__).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  it('does not load Meta when another document URL contains credentials', () => {
    const dom = new JSDOM(
      `<!doctype html><head><script defer src="/assets/${META_PIXEL_LOADER_FILENAME}"></script></head><body><iframe></iframe></body>`,
      {
        url: 'https://frontaliereticino.ch/',
        runScripts: 'outside-only',
      },
    );

    try {
      dom.window.document.querySelector('iframe')?.setAttribute(
        'src',
        `https://ads.example.test/frame?url=${encodeURIComponent('https://frontaliereticino.ch/?ne=candidate%40example.test&ac=synthetic-code')}`,
      );
      dom.window.localStorage.setItem('frontaliere_ads_consent', 'granted');
      vm.runInContext(META_PIXEL_LOADER_CONTENT, dom.getInternalVMContext());

      expect(dom.window.document.querySelector('script[src*="connect.facebook.net"]')).toBeNull();
      expect((dom.window as unknown as { fbq?: unknown }).fbq).toBeUndefined();
      expect((dom.window as unknown as { __FT_META_PIXEL_DISABLED__?: boolean }).__FT_META_PIXEL_DISABLED__).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  it('does not contact Meta before advertising consent, then tracks once after a grant', () => {
    const dom = new JSDOM(
      `<!doctype html><head><script defer src="/assets/${META_PIXEL_LOADER_FILENAME}"></script></head><body></body>`,
      {
        url: 'https://frontaliereticino.ch/automatizza-ricerca-lavoro-svizzera/?utm_source=meta',
        runScripts: 'outside-only',
      },
    );

    try {
      vm.runInContext(META_PIXEL_LOADER_CONTENT, dom.getInternalVMContext());
      expect(dom.window.document.querySelector('script[src*="connect.facebook.net"]')).toBeNull();
      expect((dom.window as unknown as { fbq?: unknown }).fbq).toBeUndefined();

      dom.window.localStorage.setItem('frontaliere_ads_consent', 'granted');
      dom.window.dispatchEvent(new dom.window.CustomEvent('frontaliere:ads-consent'));

      const pixel = (dom.window as unknown as { fbq?: ((...args: string[]) => void) & { queue?: IArguments[] } }).fbq;
      const queuedCalls = pixel?.queue?.map((call) => Array.from(call));
      expect(queuedCalls).toContainEqual(['init', '1090503593451766']);
      expect(queuedCalls).toContainEqual(['consent', 'grant']);
      expect(queuedCalls).toContainEqual(['track', 'PageView']);
      expect(dom.window.document.querySelector('script[src="https://connect.facebook.net/en_US/fbevents.js"]'))
        .not.toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it('sends one initial PageView for a clean campaign URL after stored consent', () => {
    const dom = new JSDOM(
      `<!doctype html><head><script defer src="/assets/${META_PIXEL_LOADER_FILENAME}"></script></head><body></body>`,
      {
        url: 'https://frontaliereticino.ch/automatizza-ricerca-lavoro-svizzera/?utm_source=meta&utm_campaign=test',
        runScripts: 'outside-only',
      },
    );

    try {
      dom.window.localStorage.setItem('frontaliere_ads_consent', 'granted');
      vm.runInContext(META_PIXEL_LOADER_CONTENT, dom.getInternalVMContext());

      const pixel = (dom.window as unknown as { fbq?: ((...args: string[]) => void) & { queue?: IArguments[] } }).fbq;
      const queuedCalls = pixel?.queue?.map((call) => Array.from(call));
      expect(queuedCalls).toContainEqual(['init', '1090503593451766']);
      expect(queuedCalls).toContainEqual(['consent', 'grant']);
      expect(queuedCalls).toContainEqual(['track', 'PageView']);
      expect(dom.window.document.querySelector('script[src="https://connect.facebook.net/en_US/fbevents.js"]'))
        .not.toBeNull();
    } finally {
      dom.window.close();
    }
  });
});
