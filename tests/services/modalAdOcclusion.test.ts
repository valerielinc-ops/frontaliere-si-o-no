// @vitest-environment jsdom
/**
 * suppressGoogleAdOverlays: a site modal hides Google's overlays while open and
 * must give back every one it hid. NewsletterPopup restored only the
 * `.google-auto-placed` containers, so the anchor stayed hidden for the rest
 * of the visit (2026-09-30).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { suppressGoogleAdOverlays } from '@/services/modalAdOcclusion';

/** Google's anchor: a fixed <ins> around the aswift iframe. */
function anchor(id = 'aswift_1', inlineDisplay?: string): HTMLElement {
  const ins = document.createElement('ins');
  ins.className = 'adsbygoogle adsbygoogle-noablate';
  ins.setAttribute('data-anchor-status', 'displayed');
  ins.style.position = 'fixed';
  if (inlineDisplay) ins.style.display = inlineDisplay;
  const host = document.createElement('div');
  const iframe = document.createElement('iframe');
  iframe.id = id;
  host.appendChild(iframe);
  ins.appendChild(host);
  document.body.appendChild(ins);
  return ins;
}

/** A manual in-flow slot: no fixed/absolute ancestor. */
function inFlowSlot(): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = '<ins class="adsbygoogle" data-ad-slot="1" data-ad-status="filled"><div><iframe id="aswift_9"></iframe></div></ins>';
  document.body.appendChild(wrapper);
  return wrapper;
}

function autoPlaced(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'google-auto-placed';
  document.body.appendChild(el);
  return el;
}

const flushObserver = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('suppressGoogleAdOverlays', () => {
  it('hides the anchor wrapper and Auto ads while open, and restores both on close', () => {
    const anchorIns = anchor();
    const auto = autoPlaced();
    const restore = suppressGoogleAdOverlays(document);

    expect(anchorIns.style.getPropertyValue('display')).toBe('none');
    expect(anchorIns.style.getPropertyPriority('display')).toBe('important');
    expect(auto.style.getPropertyValue('display')).toBe('none');

    restore();
    // The anchor comes back: it used to stay `display: none` until a reload.
    expect(anchorIns.style.getPropertyValue('display')).toBe('');
    expect(auto.style.getPropertyValue('display')).toBe('');
  });

  it('gives back the inline display an element had before', () => {
    const anchorIns = anchor('aswift_2', 'block');
    const restore = suppressGoogleAdOverlays(document);
    expect(anchorIns.style.getPropertyValue('display')).toBe('none');
    restore();
    expect(anchorIns.style.getPropertyValue('display')).toBe('block');
    expect(anchorIns.style.getPropertyPriority('display')).toBe('');
  });

  it('leaves in-flow slots to the body.modal-open CSS', () => {
    const wrapper = inFlowSlot();
    const restore = suppressGoogleAdOverlays(document);
    wrapper.querySelectorAll<HTMLElement>('*').forEach((el) => expect(el.style.getPropertyValue('display')).toBe(''));
    expect(wrapper.style.getPropertyValue('display')).toBe('');
    restore();
  });

  it('hides overlays Google adds while the modal is open, and restores them too', async () => {
    const restore = suppressGoogleAdOverlays(document);
    const late = anchor('aswift_3');
    await flushObserver();
    expect(late.style.getPropertyValue('display')).toBe('none');
    restore();
    expect(late.style.getPropertyValue('display')).toBe('');
  });

  it('stops watching after the restore and is safe to call twice', async () => {
    const restore = suppressGoogleAdOverlays(document);
    restore();
    restore();
    const after = anchor('aswift_4');
    await flushObserver();
    expect(after.style.getPropertyValue('display')).toBe('');
  });
});

describe('NewsletterPopup overlay restore contract', () => {
  const source = readFileSync(resolve(process.cwd(), 'components/community/NewsletterPopup.tsx'), 'utf8');

  it('delegates hide and restore to suppressGoogleAdOverlays', () => {
    expect(source).toMatch(/const restoreGoogleOverlays = suppressGoogleAdOverlays\(document\);\s*return \(\) => \{\s*restoreGoogleOverlays\(\);/);
    // No local half-restore that only brings back `.google-auto-placed`.
    expect(source).not.toMatch(/querySelectorAll\('\.google-auto-placed'\)\.forEach\(\(el\) => \{\s*\(el as HTMLElement\)\.style\.removeProperty\('display'\)/);
    expect(source).not.toContain("iframe[id^=\"aswift_\"]");
  });
});
