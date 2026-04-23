import { describe, expect, it } from 'vitest';
import {
 safeIsoDate,
 buildJobTitleCore,
 truncateTitleCore,
 composeJobPageTitle,
 composeJobPageH1,
} from '../build-plugins/jobsSeoPagesPlugin';

describe('safeIsoDate', () => {
 it('returns ISO-8601 string for a valid date string', () => {
 expect(safeIsoDate('2025-01-15T10:00:00Z')).toBe('2025-01-15T10:00:00.000Z');
 });

 it('returns ISO-8601 string for a valid epoch number', () => {
 const result = safeIsoDate(1737000000000);
 expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
 });

 it('returns null for null', () => {
 expect(safeIsoDate(null)).toBeNull();
 });

 it('returns null for undefined', () => {
 expect(safeIsoDate(undefined)).toBeNull();
 });

 it('returns null for an unparseable string', () => {
 expect(safeIsoDate('not-a-date')).toBeNull();
 });

 it('returns null for an empty string', () => {
 expect(safeIsoDate('')).toBeNull();
 });

 it('never returns the literal string "Invalid Date"', () => {
 const samples: unknown[] = [
 'Invalid Date',
 'NaN',
 {},
 [],
 Number.NaN,
 'Mon, bogus format',
 '0000-00-00',
 ];
 for (const s of samples) {
 const out = safeIsoDate(s);
 expect(out === null || /^\d{4}-\d{2}-\d{2}T/.test(out)).toBe(true);
 expect(out).not.toBe('Invalid Date');
 }
 });
});

describe('buildJobTitleCore', () => {
 it('includes the city with Italian connector "a"', () => {
 expect(buildJobTitleCore('Sviluppatore', 'Acme', 'Lugano', 'it'))
 .toBe('Sviluppatore — Acme a Lugano');
 });

 it('uses English "in" connector', () => {
 expect(buildJobTitleCore('Developer', 'Acme', 'Lugano', 'en'))
 .toBe('Developer — Acme in Lugano');
 });

 it('uses German "in" connector', () => {
 expect(buildJobTitleCore('Entwickler', 'Acme', 'Lugano', 'de'))
 .toBe('Entwickler — Acme in Lugano');
 });

 it('uses French "à" connector', () => {
 expect(buildJobTitleCore('Développeur', 'Acme', 'Lugano', 'fr'))
 .toBe('Développeur — Acme à Lugano');
 });

 it('falls back to connector when city missing', () => {
 expect(buildJobTitleCore('Developer', 'Acme', '', 'it'))
 .toBe('Developer — Acme');
 });

 it('falls back when company is missing but city is present', () => {
 expect(buildJobTitleCore('Developer', '', 'Lugano', 'it'))
 .toBe('Developer a Lugano');
 });

 it('returns only the title when both company and city missing', () => {
 expect(buildJobTitleCore('Developer', '', '', 'it')).toBe('Developer');
 });

 it('differentiates multi-sede jobs by city', () => {
 const a = buildJobTitleCore('Stage', 'Lidl', 'Lugano', 'it');
 const b = buildJobTitleCore('Stage', 'Lidl', 'Bellinzona', 'it');
 expect(a).not.toBe(b);
 });
});

describe('truncateTitleCore', () => {
 it('leaves short cores untouched', () => {
 expect(truncateTitleCore('Short core', 40)).toBe('Short core');
 });

 it('adds an ellipsis when truncating', () => {
 const truncated = truncateTitleCore('a'.repeat(50), 20);
 expect(truncated.length).toBeLessThanOrEqual(20);
 expect(truncated.endsWith('…')).toBe(true);
 });
});

describe('composeJobPageTitle', () => {
 const SUFFIX = ' | Frontaliere Ticino';
 const MAX = 60;

 it('always appends the fixed brand suffix', () => {
 const out = composeJobPageTitle('Dev', 'Acme', 'Lugano', 'it');
 expect(out.endsWith(SUFFIX)).toBe(true);
 });

 it('keeps total length within the 60-char cap', () => {
 const jobTitle = 'Very Long Senior Software Engineer Position';
 const company = 'International Consulting Group AG';
 const out = composeJobPageTitle(jobTitle, company, 'Lugano', 'it');
 expect(out.length).toBeLessThanOrEqual(MAX);
 });

 it('includes the city when it fits', () => {
 const out = composeJobPageTitle('Dev', 'Acme', 'Lugano', 'it');
 expect(out).toContain('Lugano');
 });

 it('produces DIFFERENT titles for the same role in different cities', () => {
 const a = composeJobPageTitle('Stage', 'Lidl', 'Lugano', 'it');
 const b = composeJobPageTitle('Stage', 'Lidl', 'Bellinzona', 'it');
 expect(a).not.toBe(b);
 });

 it('does not repeat the brand suffix twice', () => {
 const out = composeJobPageTitle('Dev', 'Acme', 'Lugano', 'it');
 const matches = out.match(/Frontaliere Ticino/g);
 expect(matches?.length).toBe(1);
 });

 it('handles empty company gracefully', () => {
 const out = composeJobPageTitle('Dev', '', 'Lugano', 'it');
 expect(out.endsWith(SUFFIX)).toBe(true);
 expect(out).toContain('Lugano');
 });
});

describe('composeJobPageH1', () => {
 it('combines title and company without brand suffix', () => {
 const h1 = composeJobPageH1('Developer', 'Acme');
 expect(h1).toBe('Developer — Acme');
 expect(h1).not.toContain('Frontaliere Ticino');
 expect(h1).not.toContain('Lugano');
 });

 it('omits the connector when company is empty', () => {
 expect(composeJobPageH1('Developer', '')).toBe('Developer');
 });

 it('differs from the page title (no city, no brand)', () => {
 const title = composeJobPageTitle('Developer', 'Acme', 'Lugano', 'it');
 const h1 = composeJobPageH1('Developer', 'Acme');
 expect(h1).not.toBe(title);
 // Specifically, H1 must not contain the brand suffix
 expect(h1.includes('| Frontaliere Ticino')).toBe(false);
 });
});
