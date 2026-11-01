// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { markScrollRegionsFocusable } from '@/services/scrollRegions';

function scroller(inner: string): HTMLElement {
 document.body.innerHTML = `<main><section><h2>Tariffe</h2><div class="overflow-x-auto">${inner}</div></section></main>`;
 const el = document.querySelector<HTMLElement>('.overflow-x-auto')!;
 el.style.overflowX = 'auto';
 Object.defineProperty(el, 'scrollWidth', { value: 600, configurable: true });
 Object.defineProperty(el, 'clientWidth', { value: 300, configurable: true });
 return el;
}

describe('markScrollRegionsFocusable', () => {
 it('rende focalizzabile un\'area che scorre senza contenuti interattivi', () => {
  const el = scroller('<table><tr><td>1</td></tr></table>');
  markScrollRegionsFocusable();
  expect(el.tabIndex).toBe(0);
  expect(el.getAttribute('role')).toBe('region');
  expect(el.getAttribute('aria-label')).toBe('Tariffe');
 });

 it('lascia stare un\'area che contiene già un link', () => {
  const el = scroller('<table><tr><td><a href="/x/">x</a></td></tr></table>');
  markScrollRegionsFocusable();
  expect(el.hasAttribute('tabindex')).toBe(false);
 });

 it('ignora un contenitore che non scorre davvero', () => {
  const el = scroller('<table><tr><td>1</td></tr></table>');
  Object.defineProperty(el, 'scrollWidth', { value: 300, configurable: true });
  markScrollRegionsFocusable();
  expect(el.hasAttribute('tabindex')).toBe(false);
 });
});
