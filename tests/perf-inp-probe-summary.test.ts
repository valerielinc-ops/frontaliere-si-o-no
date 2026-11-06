import { describe, expect, it } from 'vitest';
import { parseRuns, pickInteractionEntry, scenariosWithoutMeasurement, summarizeInteraction } from '../scripts/perf/lib/inp-probe-summary.mjs';

const entry = (over: Record<string, number>) => ({ interactionId: 7, start: 100, duration: 96, inputDelay: 4, processing: 0, presentation: 92, ...over });

describe('inp probe summary', () => {
 it('takes every phase from the single max-duration entry', () => {
 const probe = {
 events: [entry({ duration: 40, processing: 30 }), entry({ duration: 96, processing: 20, inputDelay: 6, presentation: 70 })],
 loaf: [],
 };
 const out = summarizeInteraction(probe, 0);
 expect(out).toMatchObject({ inp: 96, processing: 20, inputDelay: 6, presentation: 70 });
 });

 it('breaks a duration tie with the entry that ran the handlers', () => {
 const picked = pickInteractionEntry([entry({ processing: 1 }), entry({ processing: 51 })], 0);
 expect(picked?.processing).toBe(51);
 });

 it('counts only LoAF frames overlapping the interaction window', () => {
 const probe = {
 events: [entry({ start: 100, duration: 100 })],
 loaf: [
 { start: 100, duration: 50, blocking: 10, scripts: [{ duration: 40, forcedLayout: 5 }] },
 { start: 3000, duration: 50, blocking: 30, scripts: [{ duration: 45, forcedLayout: 25 }] },
 ],
 };
 const out = summarizeInteraction(probe, 0);
 expect(out.loafBlocking).toBe(10);
 expect(out.forcedLayout).toBe(5);
 });

 it('ignores entries before the tap', () => {
 expect(summarizeInteraction({ events: [entry({ start: 10 })], loaf: [] }, 50).inp).toBeNull();
 });

 it('rejects a run count that is not a positive integer', () => {
 expect(parseRuns('3')).toBe(3);
 expect(() => parseRuns('0')).toThrow();
 expect(() => parseRuns('abc')).toThrow();
 });
 it('fails a scenario whose runs never produced a finite INP', () => {
 const results = [
 { scenario: 'jobboard', ok: true, tap: { inp: null } },
 { scenario: 'jobboard', ok: false },
 { scenario: 'calculator', ok: true, tap: { inp: 48 } },
 ];
 expect(scenariosWithoutMeasurement(results, ['jobboard', 'calculator'])).toEqual(['jobboard']);
 expect(scenariosWithoutMeasurement(results.slice(2), ['calculator'])).toEqual([]);
 });

 it('reports LoAF as unknown, not zero, when the browser cannot observe it', () => {
 const out = summarizeInteraction({ events: [entry({})], loaf: [], loafSupported: false }, 0);
 expect(out.inp).toBe(96);
 expect(out.loafBlocking).toBeNull();
 expect(out.forcedLayout).toBeNull();
 });
});
