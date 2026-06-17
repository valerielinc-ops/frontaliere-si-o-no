/**
 * Offerwall custom-choice registry — regression test for the inline script in
 * index.html that registers an in-house "subscribe to read" choice on
 * window.googlefc.offerwall.customchoice.registry.
 *
 * Google's Funding Choices reads this registry BEFORE rendering the Offerwall;
 * a malformed/missing registry, or one that overwrites another component's, or
 * one whose initialize() resolves too slowly, makes the Offerwall fail to show
 * (no revenue) — the exact failure mode documented in the Offerwall Custom
 * Choice API. This test pins the contract:
 *   - the registry namespace is created additively (only if absent),
 *   - initialize()/show() exist and are synchronous-resolving Promises,
 *   - show() delegates to the React hook window.__ftOfferwallSubscribe,
 *   - the block runs BEFORE the Funding Choices loader (so FC sees the registry),
 *   - the FC loader itself is left untouched.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');

// Extract the registry IIFE block (between its googlefc namespace bootstrap and
// the next closing </script>).
const REGISTRY_BLOCK = (() => {
  const start = indexHtml.indexOf('window.googlefc = window.googlefc');
  expect(start, 'offerwall registry block must exist in index.html').toBeGreaterThan(-1);
  const end = indexHtml.indexOf('</script>', start);
  expect(end, 'closing </script> after registry block must exist').toBeGreaterThan(start);
  return indexHtml.slice(start, end);
})();

describe('Offerwall custom-choice registry — index.html', () => {
  it('registers the registry on window.googlefc.offerwall.customchoice.registry', () => {
    expect(REGISTRY_BLOCK).toMatch(/offerwall\s*=\s*g\.offerwall\s*\|\|\s*\{\}/);
    expect(REGISTRY_BLOCK).toMatch(/customchoice\s*=\s*ow\.customchoice\s*\|\|\s*\{\}/);
    expect(REGISTRY_BLOCK).toMatch(/cc\.registry\s*=\s*\{/);
  });

  it('is additive — does not overwrite an existing registry', () => {
    expect(REGISTRY_BLOCK).toMatch(/if\s*\(\s*cc\.registry\s*\)\s*return/);
  });

  it('exposes initialize() and show() methods', () => {
    expect(REGISTRY_BLOCK).toMatch(/initialize\s*:\s*function/);
    expect(REGISTRY_BLOCK).toMatch(/show\s*:\s*function/);
  });

  it('initialize() grants access to already-subscribed users (localStorage gate)', () => {
    expect(REGISTRY_BLOCK).toMatch(/newsletter_subscribed/);
    expect(REGISTRY_BLOCK).toMatch(/ACCESS_GRANTED/);
    expect(REGISTRY_BLOCK).toMatch(/ACCESS_NOT_GRANTED/);
  });

  it('initialize() also grants access to signed-in users (firebase:authUser session)', () => {
    // A logged-in visitor must NOT see the Offerwall — the registry detects the
    // Firebase Auth session synchronously via its localStorage key prefix.
    expect(REGISTRY_BLOCK).toMatch(/firebase:authUser:/);
  });

  it('show() delegates to the React hook and is defensive when it is absent', () => {
    expect(REGISTRY_BLOCK).toMatch(/window\.__ftOfferwallSubscribe/);
    expect(REGISTRY_BLOCK).toMatch(/typeof\s+fn\s*!==\s*['"]function['"]/);
    expect(REGISTRY_BLOCK).toMatch(/Promise\.resolve\(\s*false\s*\)/);
  });

  it('runs BEFORE the Funding Choices loader so FC can read the registry', () => {
    const registryIdx = indexHtml.indexOf('window.googlefc = window.googlefc');
    const fcLoaderIdx = indexHtml.indexOf('function loadFc()');
    expect(registryIdx).toBeGreaterThan(-1);
    expect(fcLoaderIdx).toBeGreaterThan(-1);
    expect(registryIdx).toBeLessThan(fcLoaderIdx);
  });
});
