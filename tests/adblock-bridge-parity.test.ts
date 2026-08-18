/**
 * The AD_BLOCK_DATA_READY bridge has to exist in BOTH places that ship
 * JavaScript to a page, and index.html is the one that matters least.
 *
 * index.html covers the SPA entry. The ~200k generated SEO and job pages never
 * clone it — they load ads from the shared dist/assets/adsense-loader.js built
 * from ADSENSE_LOADER_CONTENT. AdBlockGate mounts on every route, so a bridge
 * present only in index.html would leave the gate on its weak local probe
 * exactly where it fires and where the ad revenue is. That was a review finding
 * on the PR that introduced the bridge, not a hypothetical.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADSENSE_LOADER_CONTENT, FC_ADBLOCK_BRIDGE_JS, FC_ADBLOCK_SIGNAL_EVENT } from '@/build-plugins/constants';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(resolve(REPO_ROOT, 'index.html'), 'utf8');
const detection = readFileSync(resolve(REPO_ROOT, 'services/adBlockDetection.ts'), 'utf8');

describe('AD_BLOCK_DATA_READY bridge parity', () => {
  it('ships in the shared loader every static page loads', () => {
    expect(ADSENSE_LOADER_CONTENT).toContain('__ftFcAdBlockBridge');
    expect(ADSENSE_LOADER_CONTENT).toContain('AD_BLOCK_DATA_READY');
    expect(ADSENSE_LOADER_CONTENT).toContain(FC_ADBLOCK_BRIDGE_JS);
  });

  it('ships in index.html too, for the SPA entry', () => {
    expect(indexHtml).toContain('__ftFcAdBlockBridge');
    expect(indexHtml).toContain('AD_BLOCK_DATA_READY');
  });

  it('both halves publish the flag the client waits on', () => {
    // services/adBlockDetection.ts refuses to wait unless this flag is set, so
    // a bridge that stopped setting it would silently downgrade every visitor
    // to the local probe with nothing failing.
    expect(detection).toContain('__ftFcAdBlockBridge');
    expect(detection).toContain('__ftAdBlock');
  });

  it('all three agree on the event name', () => {
    expect(FC_ADBLOCK_SIGNAL_EVENT).toBe('frontaliere:adblock-data');
    expect(indexHtml).toContain(FC_ADBLOCK_SIGNAL_EVENT);
    expect(detection).toContain(FC_ADBLOCK_SIGNAL_EVENT);
    expect(ADSENSE_LOADER_CONTENT).toContain(FC_ADBLOCK_SIGNAL_EVENT);
  });

  it('the bridge stays idempotent, so two copies on one page cannot double-fire', () => {
    // index.html's copy and the shared loader can both run on the SPA entry.
    expect(FC_ADBLOCK_BRIDGE_JS).toContain('if(window.__ftFcAdBlockBridge)return');
  });
});
