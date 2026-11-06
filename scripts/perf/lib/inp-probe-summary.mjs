/**
 * Pure summary of one probed tap, shared by scripts/perf/inp-interaction-probe.mjs
 * and its test.
 *
 * - The interaction is the Event Timing entry with the largest duration after
 *   `since`. A tap emits pointerdown/pointerup/click under one interactionId
 *   with the same rounded duration; on a tie the entry with the most
 *   processing wins (the click, where the handlers run), so all three phases
 *   come from that single entry.
 * - LoAF frames count only when they overlap that entry's own window
 *   [start, start + duration]: frames after the paint (ads, analytics, idle
 *   work during the post-tap wait) are not part of the interaction.
 */
export function pickInteractionEntry(events, since) {
 let best = null;
 for (const e of events) {
 if (e.start < since) continue;
 if (!best || e.duration > best.duration || (e.duration === best.duration && e.processing > best.processing)) best = e;
 }
 return best;
}

export function summarizeInteraction(probe, since) {
 const entry = pickInteractionEntry(probe.events, since);
 if (!entry) {
 return { inp: null, inputDelay: null, processing: null, presentation: null, loafBlocking: 0, forcedLayout: 0, topScripts: [] };
 }
 // LoAF unsupported is not the same as "no long frame": report null.
 if (probe.loafSupported === false) {
 return {
 inp: Math.round(entry.duration),
 inputDelay: Math.round(entry.inputDelay),
 processing: Math.round(entry.processing),
 presentation: Math.round(entry.presentation),
 loafBlocking: null,
 forcedLayout: null,
 topScripts: [],
 };
 }
 const end = entry.start + entry.duration;
 const frames = probe.loaf.filter((f) => f.start < end && f.start + f.duration > entry.start);
 const scripts = frames.flatMap((f) => f.scripts || []);
 const topScripts = [...scripts].sort((a, b) => b.duration - a.duration).slice(0, 5)
 .map((s) => ({ ...s, duration: Math.round(s.duration), forcedLayout: Math.round(s.forcedLayout) }));
 return {
 inp: Math.round(entry.duration),
 inputDelay: Math.round(entry.inputDelay),
 processing: Math.round(entry.processing),
 presentation: Math.round(entry.presentation),
 loafBlocking: Math.round(frames.reduce((sum, f) => sum + (f.blocking || 0), 0)),
 forcedLayout: Math.round(scripts.reduce((sum, s) => sum + (s.forcedLayout || 0), 0)),
 topScripts,
 };
}

export function parseRuns(raw) {
 const runs = Number(raw);
 if (!Number.isInteger(runs) || runs < 1 || runs > 20) {
 throw new Error(`--runs must be an integer between 1 and 20, got ${JSON.stringify(raw)}`);
 }
 return runs;
}

/** A run counts only when the tap produced a finite INP. */
export function isValidRun(result) {
 return Boolean(result?.ok) && Number.isFinite(result?.tap?.inp);
}

/**
 * The probe succeeds only when EVERY scenario has at least one valid run: a
 * scenario that never measured must fail the workflow, not vanish from the
 * comparison. Returns the ids of the scenarios without a valid run.
 */
export function scenariosWithoutMeasurement(results, scenarioIds) {
 return scenarioIds.filter((id) => !results.some((r) => r.scenario === id && isValidRun(r)));
}
