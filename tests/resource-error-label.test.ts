import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GA4_PARAM_MAX_CHARS, buildResourceErrorLabel } from '../services/resourceErrorLabel';

describe('buildResourceErrorLabel', () => {
 it('keeps host and path of a failed asset', () => {
  expect(buildResourceErrorLabel('https://cdn.frontaliereticino.ch/assets/i18n.js'))
   .toBe('cdn.frontaliereticino.ch/assets/i18n.js');
 });

 it('drops query and hash, which can carry tokens', () => {
  const label = buildResourceErrorLabel('https://ads.example.com/tag.js?token=secret#frag');
  expect(label).toBe('ads.example.com/tag.js');
 });

 it('drops them from a URL that does not parse too', () => {
  expect(buildResourceErrorLabel('/assets/a.js?token=secret')).toBe('/assets/a.js');
 });

 it('keeps host and file name when the path overflows the GA4 limit', () => {
  const file = 'chunk-final.js';
  const label = buildResourceErrorLabel(`https://cdn.example.com/${'deep/'.repeat(40)}${file}`);
  expect(label.length).toBeLessThanOrEqual(GA4_PARAM_MAX_CHARS);
  expect(label.startsWith('cdn.example.com/…')).toBe(true);
  expect(label.endsWith(file)).toBe(true);
 });

 it('never exceeds the limit, even with an oversized host', () => {
  const host = `${'a'.repeat(120)}.example.com`;
  expect(buildResourceErrorLabel(`https://${host}/x.js`).length).toBeLessThanOrEqual(GA4_PARAM_MAX_CHARS);
 });

 it('does not leak inline payloads and names an empty URL', () => {
  expect(buildResourceErrorLabel('data:text/javascript;base64,AAAA')).toBe('data:(inline)');
  expect(buildResourceErrorLabel('')).toBe('(empty)');
 });
});

describe('resource_load_error reporting contract', () => {
 const analytics = readFileSync('services/analytics.ts', 'utf8');
 const report = readFileSync('scripts/analytics-report.mjs', 'utf8');

 it('emits the resource on the registered dimensions', () => {
  const emit = analytics.slice(analytics.indexOf("log('resource_load_error'"));
  expect(emit.slice(0, 400)).toMatch(/error_type: `resource_\$\{info\.resourceType\}`/);
  expect(emit.slice(0, 400)).toMatch(/error_message: buildResourceErrorLabel\(info\.resourceUrl\)/);
 });

 it('does not query the unregistered resource dimensions', () => {
  expect(report).not.toMatch(/customEvent:(resource_url|resource_type|triggered_reload)\b/);
 });
});
