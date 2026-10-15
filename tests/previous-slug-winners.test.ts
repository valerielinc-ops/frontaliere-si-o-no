import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
 chooseWinner,
 jaccardSimilarity,
 loadWinners,
 makeKey,
 pruneStaleWinners,
 resolveWinner,
 saveWinners,
 type CandidateInput,
 type WinnersFile,
} from '@/services/previousSlugWinners';

const NOW = '2026-04-30T12:00:00.000Z';

describe('previousSlugWinners', () => {
 describe('jaccardSimilarity', () => {
 it('returns 1 for identical slugs', () => {
 expect(jaccardSimilarity('foo-bar-baz', 'foo-bar-baz')).toBe(1);
 });

 it('returns 0 for fully disjoint slugs', () => {
 expect(jaccardSimilarity('alpha-beta', 'gamma-delta')).toBe(0);
 });

 it('returns 0 for two empty inputs (no division-by-zero)', () => {
 expect(jaccardSimilarity('', '')).toBe(0);
 });

 it('correctly computes |intersection| / |union|', () => {
 // tokens(a) = {a, b, c}; tokens(b) = {b, c, d}
 // intersection = {b, c} (2); union = {a, b, c, d} (4) → 0.5
 expect(jaccardSimilarity('a-b-c', 'b-c-d')).toBe(0.5);
 });

 it('lowercases and dedupes within each slug', () => {
 // tokens(a) = {foo, bar} after dedup; tokens(b) = {foo, bar}
 expect(jaccardSimilarity('FOO-bar-foo', 'foo-bar')).toBe(1);
 });
 });

 describe('chooseWinner — token-Jaccard heuristic', () => {
 it('returns null for empty candidates list', () => {
 expect(chooseWinner('any-slug', [], NOW)).toBeNull();
 });

 it('picks the candidate with highest Jaccard against the old slug', () => {
 const candidates: CandidateInput[] = [
 { jobIdentifier: 'job-a', canonicalSlug: 'foo-bar' }, // 1 token shared (foo)
 { jobIdentifier: 'job-b', canonicalSlug: 'foo-baz-qux' }, // 1 shared, but bigger union → smaller
 { jobIdentifier: 'job-c', canonicalSlug: 'foo-bar-baz' }, // 2 shared (foo, bar) → highest
 ];
 const winner = chooseWinner('foo-bar', candidates, NOW);
 expect(winner).not.toBeNull();
 expect(winner!.winnerJobIdentifier).toBe('job-a'); // foo-bar EXACTLY matches → 1.0
 expect(winner!.score).toBe(1);
 });

 it('breaks ties by lexicographic order of jobIdentifier', () => {
 // Both candidates have identical Jaccard (1.0) — same canonical slug.
 const candidates: CandidateInput[] = [
 { jobIdentifier: 'job-zzz', canonicalSlug: 'foo' },
 { jobIdentifier: 'job-aaa', canonicalSlug: 'foo' },
 { jobIdentifier: 'job-mmm', canonicalSlug: 'foo' },
 ];
 const winner = chooseWinner('foo', candidates, NOW);
 expect(winner!.winnerJobIdentifier).toBe('job-aaa');
 });

 it('zero-similarity is still a valid score (caller may filter)', () => {
 const candidates: CandidateInput[] = [
 { jobIdentifier: 'job-a', canonicalSlug: 'totally-unrelated' },
 ];
 const winner = chooseWinner('xxx', candidates, NOW);
 expect(winner!.score).toBe(0);
 expect(winner!.winnerJobIdentifier).toBe('job-a');
 });

 it('chooses the convit case correctly: same role beats same city', () => {
 // Reproduces the production scenario from 2026-04-30 audit run 25152767223:
 // 8 active Convit jobs all claim the same prevSlug. The role-matching job
 // (Job 8 — same role keywords) should beat the city-matching job (Job 1 —
 // same city tail).
 const oldSlug =
 'social-security-advisor-m-f-d-untrained-entry-ote-up-to-chf-7-500-convit-holding-gmbh-biasca';
 const candidates: CandidateInput[] = [
 // Same city (biasca) but different role
 {
 jobIdentifier: 'convit-1f9f769932df',
 canonicalSlug:
 'admission-3a-3b-financial-advice-flexible-hours-convit-holding-gmbh-biasca',
 },
 // Same role (social-security-advisor) but different city
 {
 jobIdentifier: 'convit-cd35c2a7593a',
 canonicalSlug:
 'social-security-advisor-junior-3a-3b-hybrid-convit-holding-gmbh-quartino-riazzino',
 },
 // Other Convit jobs share fewer tokens
 {
 jobIdentifier: 'convit-d3c2c737392d',
 canonicalSlug:
 'private-wealth-planning-consultant-hybrid-convit-holding-gmbh-quartino',
 },
 ];
 const winner = chooseWinner(oldSlug, candidates, NOW);
 expect(winner!.winnerJobIdentifier).toBe('convit-cd35c2a7593a');
 });
 });

 describe('resolveWinner — registry behaviour', () => {
 it('returns null for empty candidates', () => {
 const winners: WinnersFile = {};
 expect(resolveWinner(winners, 'TI', 'en', 'old', [], NOW)).toBeNull();
 });

 it('single candidate is a trivial winner — does NOT mutate the registry', () => {
 const winners: WinnersFile = {};
 const out = resolveWinner(winners, 'TI', 'en', 'old', [
 { jobIdentifier: 'job-a', canonicalSlug: 'old' },
 ], NOW);
 expect(out!.winnerJobIdentifier).toBe('job-a');
 expect(Object.keys(winners)).toHaveLength(0);
 });

 it('multi-candidate first-time decision writes a registry entry', () => {
 const winners: WinnersFile = {};
 resolveWinner(winners, 'TI', 'en', 'foo', [
 { jobIdentifier: 'job-a', canonicalSlug: 'foo-bar' },
 { jobIdentifier: 'job-b', canonicalSlug: 'foo' },
 ], NOW);
 const key = makeKey('TI', 'en', 'foo');
 expect(winners[key]).toBeDefined();
 expect(winners[key].winnerJobIdentifier).toBe('job-b');
 expect(winners[key].candidatesCount).toBe(2);
 });

 it('reuses prior decision when the winner is still in the candidates list and TOUCHES lastSeenAt', () => {
 const winners: WinnersFile = {
 [makeKey('TI', 'en', 'shared')]: {
 winnerJobIdentifier: 'job-aaa',
 winnerCanonical: 'shared-old',
 decidedAt: '2026-01-01T00:00:00.000Z',
 lastSeenAt: '2026-01-01T00:00:00.000Z',
 score: 1,
 candidatesCount: 2,
 },
 };
 const out = resolveWinner(winners, 'TI', 'en', 'shared', [
 { jobIdentifier: 'job-aaa', canonicalSlug: 'shared-old' },
 { jobIdentifier: 'job-bbb', canonicalSlug: 'completely-different-slug' },
 ], NOW);
 expect(out!.winnerJobIdentifier).toBe('job-aaa');
 // Original decidedAt preserved (decision NOT recomputed).
 expect(out!.decidedAt).toBe('2026-01-01T00:00:00.000Z');
 // lastSeenAt is bumped to NOW so the prune routine sees this entry as alive.
 expect(out!.lastSeenAt).toBe(NOW);
 expect(winners[makeKey('TI', 'en', 'shared')].lastSeenAt).toBe(NOW);
 });

 it('reuse: skips touch if lastSeenAt is already === now AND canton stamped (idempotent)', () => {
 const winners: WinnersFile = {
 [makeKey('TI', 'en', 'shared')]: {
 winnerJobIdentifier: 'job-aaa',
 winnerCanonical: 'shared-old',
 decidedAt: '2026-01-01T00:00:00.000Z',
 lastSeenAt: NOW,
 score: 1,
 candidatesCount: 2,
 canton: 'TI',
 },
 };
 const before = winners[makeKey('TI', 'en', 'shared')];
 const out = resolveWinner(winners, 'TI', 'en', 'shared', [
 { jobIdentifier: 'job-aaa', canonicalSlug: 'shared-old' },
 { jobIdentifier: 'job-bbb', canonicalSlug: 'completely-different-slug' },
 ], NOW);
 expect(out).toBe(before); // exact reference equality — no clone made
 });

 it('re-elects AND OVERWRITES the registry when prior winner is gone, even with single replacement', () => {
 // Branch 3 of the new lifecycle: when the previously-recorded winner
 // is no longer in candidates, we adopt whoever IS in candidates so the
 // file always reflects the current canonical (not a stale reference).
 const winners: WinnersFile = {
 [makeKey('TI', 'en', 'shared')]: {
 winnerJobIdentifier: 'job-removed',
 winnerCanonical: 'shared-old',
 decidedAt: '2026-01-01T00:00:00.000Z',
 lastSeenAt: '2026-01-01T00:00:00.000Z',
 score: 1,
 candidatesCount: 2,
 },
 };
 const out = resolveWinner(winners, 'TI', 'en', 'shared', [
 { jobIdentifier: 'job-still-here', canonicalSlug: 'shared-similar' },
 ], NOW);
 expect(out!.winnerJobIdentifier).toBe('job-still-here');
 expect(out!.decidedAt).toBe(NOW); // freshly decided
 expect(out!.lastSeenAt).toBe(NOW);
 // Registry IS updated even though only one candidate remained — keeps
 // the file consistent with the live state.
 expect(winners[makeKey('TI', 'en', 'shared')].winnerJobIdentifier).toBe('job-still-here');
 });

 it('re-elects when prior winner removed AND multiple new candidates exist', () => {
 const winners: WinnersFile = {
 [makeKey('TI', 'en', 'shared')]: {
 winnerJobIdentifier: 'job-removed',
 winnerCanonical: 'gone-slug',
 decidedAt: '2026-01-01T00:00:00.000Z',
 lastSeenAt: '2026-01-01T00:00:00.000Z',
 score: 1,
 candidatesCount: 3,
 },
 };
 const out = resolveWinner(winners, 'TI', 'en', 'shared', [
 { jobIdentifier: 'job-aaa', canonicalSlug: 'shared-similar' },
 { jobIdentifier: 'job-bbb', canonicalSlug: 'totally-other' },
 ], NOW);
 expect(out!.winnerJobIdentifier).toBe('job-aaa');
 expect(out!.decidedAt).toBe(NOW);
 expect(out!.lastSeenAt).toBe(NOW);
 // Registry updated.
 expect(winners[makeKey('TI', 'en', 'shared')].winnerJobIdentifier).toBe('job-aaa');
 });
 });

 describe('pruneStaleWinners — TTL garbage collection', () => {
 const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
 const NOW_PRUNE = '2026-04-30T12:00:00.000Z';
 const oneDayBefore = new Date(Date.parse(NOW_PRUNE) - 1 * 24 * 60 * 60 * 1000).toISOString();
 const fortyDaysBefore = new Date(Date.parse(NOW_PRUNE) - 40 * 24 * 60 * 60 * 1000).toISOString();
 const fiftyDaysBefore = new Date(Date.parse(NOW_PRUNE) - 50 * 24 * 60 * 60 * 1000).toISOString();

 it('keeps entries whose lastSeenAt is within the TTL window', () => {
 const winners: WinnersFile = {
 [makeKey('TI', 'en', 'fresh')]: {
 winnerJobIdentifier: 'job', winnerCanonical: 'x', decidedAt: oneDayBefore,
 lastSeenAt: oneDayBefore, score: 0.5, candidatesCount: 2,
 },
 };
 const pruned = pruneStaleWinners(winners, TTL_MS, NOW_PRUNE);
 expect(pruned).toBe(0);
 expect(Object.keys(winners)).toHaveLength(1);
 });

 it('removes entries whose lastSeenAt is older than TTL', () => {
 const winners: WinnersFile = {
 [makeKey('TI', 'en', 'stale')]: {
 winnerJobIdentifier: 'job', winnerCanonical: 'x', decidedAt: fortyDaysBefore,
 lastSeenAt: fortyDaysBefore, score: 0.5, candidatesCount: 2,
 },
 [makeKey('TI', 'en', 'older')]: {
 winnerJobIdentifier: 'job', winnerCanonical: 'x', decidedAt: fiftyDaysBefore,
 lastSeenAt: fiftyDaysBefore, score: 0.5, candidatesCount: 2,
 },
 };
 const pruned = pruneStaleWinners(winners, TTL_MS, NOW_PRUNE);
 expect(pruned).toBe(2);
 expect(Object.keys(winners)).toHaveLength(0);
 });

 it('mixed entries: keeps fresh, removes stale', () => {
 const winners: WinnersFile = {
 [makeKey('TI', 'en', 'fresh')]: {
 winnerJobIdentifier: 'a', winnerCanonical: 'x', decidedAt: oneDayBefore,
 lastSeenAt: oneDayBefore, score: 0, candidatesCount: 1,
 },
 [makeKey('TI', 'en', 'stale')]: {
 winnerJobIdentifier: 'b', winnerCanonical: 'y', decidedAt: fortyDaysBefore,
 lastSeenAt: fortyDaysBefore, score: 0, candidatesCount: 1,
 },
 };
 const pruned = pruneStaleWinners(winners, TTL_MS, NOW_PRUNE);
 expect(pruned).toBe(1);
 expect(Object.keys(winners)).toEqual([makeKey('TI', 'en', 'fresh')]);
 });

 it('backward compat: entry without lastSeenAt falls back to decidedAt', () => {
 // Simulate an entry written before lastSeenAt was added — only decidedAt.
 const winners: WinnersFile = {
 [makeKey('TI', 'en', 'old')]: {
 winnerJobIdentifier: 'job', winnerCanonical: 'x', decidedAt: oneDayBefore,
 lastSeenAt: '', // empty — must fall back
 score: 0, candidatesCount: 1,
 },
 };
 const pruned = pruneStaleWinners(winners, TTL_MS, NOW_PRUNE);
 // decidedAt is recent → entry kept.
 expect(pruned).toBe(0);
 });

 it('returns 0 and is a no-op for empty registry', () => {
 const winners: WinnersFile = {};
 expect(pruneStaleWinners(winners, TTL_MS, NOW_PRUNE)).toBe(0);
 });

 it('returns 0 when `now` is unparseable (defensive — never purge on bad input)', () => {
 const winners: WinnersFile = {
 [makeKey('TI', 'en', 'fresh')]: {
 winnerJobIdentifier: 'job', winnerCanonical: 'x', decidedAt: oneDayBefore,
 lastSeenAt: oneDayBefore, score: 0, candidatesCount: 1,
 },
 };
 expect(pruneStaleWinners(winners, TTL_MS, 'not-a-date')).toBe(0);
 expect(Object.keys(winners)).toHaveLength(1);
 });
 });

 describe('persistence (load + save)', () => {
 let tmp: string;
 beforeEach(() => {
 tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prev-slug-test-'));
 });
 afterEach(() => {
 fs.rmSync(tmp, { recursive: true, force: true });
 });

 it('loadWinners returns {} for missing file', () => {
 expect(loadWinners(path.join(tmp, 'nope.json'))).toEqual({});
 });

 it('loadWinners returns {} for malformed JSON (does not throw)', () => {
 const file = path.join(tmp, 'bad.json');
 fs.writeFileSync(file, '{ not valid json', 'utf-8');
 expect(loadWinners(file)).toEqual({});
 });

 it('saveWinners + loadWinners is a roundtrip', () => {
 const file = path.join(tmp, 'round.json');
 const data: WinnersFile = {
 [makeKey('TI', 'en', 'foo')]: {
 winnerJobIdentifier: 'job-a',
 winnerCanonical: 'foo-bar',
 decidedAt: NOW,
 lastSeenAt: NOW,
 score: 0.75,
 candidatesCount: 3,
 },
 };
 saveWinners(file, data);
 expect(loadWinners(file)).toEqual(data);
 });

 it('saveWinners sorts keys for stable diffs', () => {
 const file = path.join(tmp, 'sorted.json');
 saveWinners(file, {
 [makeKey('TI', 'en', 'zzz')]: {
 winnerJobIdentifier: 'job', winnerCanonical: 'zzz', decidedAt: NOW, lastSeenAt: NOW, score: 0, candidatesCount: 1,
 },
 [makeKey('TI', 'en', 'aaa')]: {
 winnerJobIdentifier: 'job', winnerCanonical: 'aaa', decidedAt: NOW, lastSeenAt: NOW, score: 0, candidatesCount: 1,
 },
 });
 const raw = fs.readFileSync(file, 'utf-8');
 const aaaPos = raw.indexOf('TI::en::aaa');
 const zzzPos = raw.indexOf('TI::en::zzz');
 expect(aaaPos).toBeGreaterThan(0);
 expect(zzzPos).toBeGreaterThan(aaaPos);
 });

 it('saveWinners creates the directory if missing', () => {
 const file = path.join(tmp, 'sub', 'dir', 'winners.json');
 saveWinners(file, {});
 expect(fs.existsSync(file)).toBe(true);
 });
 });
});
