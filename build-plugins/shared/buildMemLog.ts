/**
 * Build-OOM diagnostic instrumentation (#1290) — ONE definition.
 *
 * Logs process memory + WriteCollector backlog at an emit milestone so the CI
 * build log reveals which phase accretes the live heap. No effect on emitted
 * output.
 *
 * Lived as a private function inside `jobsSeoPagesPlugin.ts` until
 * `employerProfilePagesPlugin` needed the same measurement to show the corpus
 * release it now performs (#5330 follow-up). Two byte-identical copies of a
 * log FORMAT is exactly the drift AGENTS.md #6 forbids — and here the format is
 * load-bearing beyond aesthetics: the whole point of these lines is that two
 * runs can be diffed field-by-field at the same milestone, which stops working
 * the moment one copy is retuned and the other is not.
 *
 * The emitted line is byte-identical to the original so existing log greps
 * (`grep '\[mem\]'` over a downloaded run log) keep matching.
 */

import { forceGc } from './forceGc';

/**
 * @param label Milestone name, conventionally `<plugin>: <phase>` — e.g.
 *   `jobsSeoPages: after city-hubs`. The plugin prefix is what makes two
 *   plugins' lines separable when grepping one build log.
 * @param collector Optional `WriteCollector`; when passed, its pending-write
 *   and in-flight-flush counts are appended (read reflectively so this module
 *   does not import `batchWrite` just to name a type).
 */
export function logBuildMem(label: string, collector?: unknown): void {
  const mb = (n: number) => Math.round(n / 1048576);
  // Force a full GC first (build:ci runs with --expose-gc) so the reported heap
  // is the LIVE set, not garbage V8 keeps lazily under its 12 GB ceiling. DUAL
  // PURPOSE: if this reclaims the per-phase growth, the gc() calls themselves
  // bound the peak and prevent the OOM (cheap fix); if heap stays high post-gc
  // it's genuine retention needing a code fix — and `gcFreed` tells us which. (#1290)
  //
  // Via forceGc() since #5899: the `rss=` field below is only meaningful if the
  // collection actually returns pages, and bare gc() does not. The reported
  // heapUsed/gcFreed are unchanged by the switch — a major GC frees the same
  // objects either way; what moves is rss.
  const beforeHeap = process.memoryUsage().heapUsed;
  forceGc();
  const m = process.memoryUsage();
  const freed = mb(beforeHeap - m.heapUsed);
  const c = collector as { writes?: Map<unknown, unknown>; _pendingFlushes?: Set<unknown> } | undefined;
  const extra = c
    ? ` pendingWrites=${c.writes?.size ?? '?'} inflightFlushes=${c._pendingFlushes?.size ?? '?'}`
    : '';
  console.log(
    `\x1b[35m[mem]\x1b[0m ${label} heapUsed=${mb(m.heapUsed)}MB (gcFreed=${freed}MB) external=${mb(m.external)}MB arrayBuffers=${mb(m.arrayBuffers)}MB rss=${mb(m.rss)}MB${extra}`,
  );
}
