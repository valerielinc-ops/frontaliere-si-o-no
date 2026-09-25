import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
 claim,
 declareSharedPath,
 reset,
 getCollisions,
 getPathHistory,
 configureDumpDir,
 pruneDumpToCollidingHashes,
 setModeForTest,
 clearDeclarationsForTest,
 WriteCollisionError,
} from '@/build-plugins/sharedWriteRegistry';

describe('sharedWriteRegistry', () => {
 beforeEach(() => {
 reset();
 clearDeclarationsForTest();
 setModeForTest('throw');
 });

 afterEach(() => {
 setModeForTest(null);
 });

 it('first claim of a path returns allow-write', () => {
 const out = claim('/dist/foo/index.html', 'pluginA', '<html>a</html>');
 expect(out).toBe('allow-write');
 });

 it('idempotent re-claim with identical content returns skip-write (no error)', () => {
 claim('/dist/foo/index.html', 'pluginA', '<html>a</html>');
 const out = claim('/dist/foo/index.html', 'pluginA', '<html>a</html>');
 expect(out).toBe('skip-write');
 expect(getCollisions()).toHaveLength(0);
 });

 it('idempotent re-claim across plugins with identical content also returns skip-write', () => {
 // If two plugins independently render the exact same bytes for the same
 // path, that's a non-issue — no race possible, no signal worth surfacing.
 claim('/dist/foo/index.html', 'pluginA', '<html>same</html>');
 const out = claim('/dist/foo/index.html', 'pluginB', '<html>same</html>');
 expect(out).toBe('skip-write');
 expect(getCollisions()).toHaveLength(0);
 });

 it('throws WriteCollisionError on cross-plugin same-path different-content in throw mode', () => {
 claim('/dist/foo/index.html', 'pluginA', '<html>a</html>');
 expect(() =>
 claim('/dist/foo/index.html', 'pluginB', '<html>b</html>'),
 ).toThrow(WriteCollisionError);
 });

 it('throws on intra-plugin same-path different-content in throw mode', () => {
 // Two call sites within the SAME plugin writing different content to the
 // same path is just as much a bug as cross-plugin — neither caller knows
 // who is canonical.
 claim('/dist/foo/index.html', 'pluginA', '<html>v1</html>');
 expect(() =>
 claim('/dist/foo/index.html', 'pluginA', '<html>v2</html>'),
 ).toThrow(WriteCollisionError);
 });

 it('error message names both plugins, both call sites, and content hashes', () => {
 claim('/dist/foo/index.html', 'pluginA', '<html>a</html>');
 try {
 claim('/dist/foo/index.html', 'pluginB', '<html>b</html>');
 expect.fail('should have thrown');
 } catch (err) {
 expect(err).toBeInstanceOf(WriteCollisionError);
 const msg = String((err as Error).message);
 expect(msg).toContain('/dist/foo/index.html');
 expect(msg).toContain('pluginA');
 expect(msg).toContain('pluginB');
 expect(msg).toContain('Already claimed by');
 expect(msg).toContain('Now attempted by');
 expect(msg).toContain('Content differs');
 expect(msg).toContain('declareSharedPath');
 }
 });

 it('records collision in report mode and lets the build continue', () => {
 setModeForTest('report');
 claim('/dist/foo/index.html', 'pluginA', '<html>a</html>');
 const out = claim('/dist/foo/index.html', 'pluginB', '<html>b</html>');
 expect(out).toBe('allow-write');
 const collisions = getCollisions();
 expect(collisions).toHaveLength(1);
 expect(collisions[0].path).toBe('/dist/foo/index.html');
 expect(collisions[0].first.plugin).toBe('pluginA');
 expect(collisions[0].attempted.plugin).toBe('pluginB');
 });

 it('declareSharedPath: winner can write, loser is silently skipped', () => {
 declareSharedPath({
 pattern: '/dist/foo/index.html',
 winner: 'pluginA',
 reason: 'pluginA owns the canonical content; pluginB writes a placeholder fallback',
 });
 // Winner first
 expect(claim('/dist/foo/index.html', 'pluginA', '<html>canonical</html>')).toBe('allow-write');
 // Loser tries to write different content — skipped, no collision recorded.
 expect(claim('/dist/foo/index.html', 'pluginB', '<html>fallback</html>')).toBe('skip-write');
 expect(getCollisions()).toHaveLength(0);
 });

 it('declareSharedPath: loser-first then winner replaces the claim', () => {
 declareSharedPath({
 pattern: '/dist/foo/index.html',
 winner: 'pluginA',
 reason: '...',
 });
 // Loser first (e.g. lower-priority plugin runs earlier in plugin order)
 expect(claim('/dist/foo/index.html', 'pluginB', '<html>fallback</html>')).toBe('allow-write');
 // Winner then arrives with different content — overwrites.
 expect(claim('/dist/foo/index.html', 'pluginA', '<html>canonical</html>')).toBe('allow-write');
 expect(getCollisions()).toHaveLength(0);
 });

 it('declareSharedPath: regex pattern matches paths in the family', () => {
 declareSharedPath({
 pattern: /^\/dist\/articoli-frontaliere\/[^/]+\/index\.html$/,
 winner: 'articleEmitter',
 reason: 'article HTML is owned by articleEmitter; staticPagesPlugin writes a fallback',
 });
 claim('/dist/articoli-frontaliere/foo/index.html', 'articleEmitter', '<html>article</html>');
 expect(
 claim('/dist/articoli-frontaliere/foo/index.html', 'staticPagesPlugin', '<html>fallback</html>'),
 ).toBe('skip-write');
 expect(getCollisions()).toHaveLength(0);
 });

 it('reset clears claims and collisions but keeps shared-path declarations', () => {
 declareSharedPath({
 pattern: '/dist/foo/index.html',
 winner: 'pluginA',
 reason: '...',
 });
 setModeForTest('report');
 claim('/dist/foo/index.html', 'pluginA', '<html>a</html>');
 claim('/dist/foo/index.html', 'pluginB', '<html>b</html>'); // skipped (decl)

 claim('/dist/bar/index.html', 'pluginA', '<html>a</html>');
 claim('/dist/bar/index.html', 'pluginB', '<html>b</html>'); // collision recorded
 expect(getCollisions()).toHaveLength(1);

 reset();
 expect(getCollisions()).toHaveLength(0);
 // Declaration survived — pluginB still skipped after reset.
 claim('/dist/foo/index.html', 'pluginA', '<html>a</html>');
 expect(claim('/dist/foo/index.html', 'pluginB', '<html>b</html>')).toBe('skip-write');
 });

 it('different paths never collide', () => {
 claim('/dist/foo/index.html', 'pluginA', '<html>a</html>');
 expect(claim('/dist/bar/index.html', 'pluginA', '<html>b</html>')).toBe('allow-write');
 expect(claim('/dist/baz/index.html', 'pluginB', '<html>c</html>')).toBe('allow-write');
 expect(getCollisions()).toHaveLength(0);
 });

 describe('pathHistory: full version capture for end-of-build analysis', () => {
 it('records every distinct content version for a colliding path', () => {
 setModeForTest('report');
 claim('/dist/foo/index.html', 'pluginA', '<html>v1</html>');
 claim('/dist/foo/index.html', 'pluginB', '<html>v2</html>');
 claim('/dist/foo/index.html', 'pluginC', '<html>v3</html>');
 const history = getPathHistory();
 const versions = history.get('/dist/foo/index.html');
 expect(versions).toBeDefined();
 expect(versions).toHaveLength(3);
 expect(versions![0].plugin).toBe('pluginA');
 expect(versions![1].plugin).toBe('pluginB');
 expect(versions![2].plugin).toBe('pluginC');
 // Each version carries size + a non-negative timestamp.
 for (const v of versions!) {
 expect(v.size).toBeGreaterThan(0);
 expect(v.timestamp).toBeGreaterThanOrEqual(0);
 }
 });

 it('idempotent re-claim does NOT append a duplicate version', () => {
 setModeForTest('report');
 claim('/dist/foo/index.html', 'pluginA', '<html>v1</html>');
 claim('/dist/foo/index.html', 'pluginA', '<html>v1</html>'); // same hash
 const versions = getPathHistory().get('/dist/foo/index.html');
 expect(versions).toHaveLength(1);
 });

 it('returning to an EARLIER hash is still idempotent (no new version, no collision)', () => {
 // Plugin emits v1 → v2 → v1 again. The third claim should be skipped
 // because v1's hash is already in the version array. This prevents
 // oscillation loops from inflating the collision count.
 setModeForTest('report');
 claim('/dist/foo/index.html', 'pluginA', '<html>v1</html>');
 claim('/dist/foo/index.html', 'pluginA', '<html>v2</html>');
 const out = claim('/dist/foo/index.html', 'pluginA', '<html>v1</html>');
 expect(out).toBe('skip-write');
 const versions = getPathHistory().get('/dist/foo/index.html');
 expect(versions).toHaveLength(2);
 });

 it('getCollisions derives adjacent-pair records from the version chain', () => {
 setModeForTest('report');
 claim('/dist/foo/index.html', 'pluginA', '<html>v1</html>');
 claim('/dist/foo/index.html', 'pluginB', '<html>v2</html>');
 claim('/dist/foo/index.html', 'pluginC', '<html>v3</html>');
 const records = getCollisions();
 // 3 versions → 2 adjacent collision pairs.
 expect(records).toHaveLength(2);
 expect(records[0].first.plugin).toBe('pluginA');
 expect(records[0].attempted.plugin).toBe('pluginB');
 expect(records[1].first.plugin).toBe('pluginB');
 expect(records[1].attempted.plugin).toBe('pluginC');
 });
 });

 describe('content dump (dump dir + prune)', () => {
 let tmp: string;
 beforeEach(() => {
 tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'write-collisions-test-'));
 configureDumpDir(tmp);
 setModeForTest('report');
 });
 afterEach(() => {
 configureDumpDir(null);
 fs.rmSync(tmp, { recursive: true, force: true });
 });

 it('writes one file per unique content hash to the dump dir', () => {
 claim('/dist/a/index.html', 'pluginA', '<html>v1</html>');
 claim('/dist/b/index.html', 'pluginB', '<html>v1</html>'); // dedup-by-hash → no extra file
 claim('/dist/c/index.html', 'pluginC', '<html>v2</html>');
 const files = fs.readdirSync(tmp).filter((f) => f.endsWith('.html'));
 expect(files).toHaveLength(2);
 });

 it('pruneDumpToCollidingHashes keeps only hashes referenced by paths with versions ≥ 2', () => {
 // Path A: 1 version (no collision) → its hash will be pruned
 claim('/dist/a/index.html', 'pluginA', '<html>solo</html>');
 // Path B: 2 versions (collision) → both hashes retained
 claim('/dist/b/index.html', 'pluginA', '<html>collide-v1</html>');
 claim('/dist/b/index.html', 'pluginB', '<html>collide-v2</html>');

 const before = fs.readdirSync(tmp).filter((f) => f.endsWith('.html'));
 expect(before).toHaveLength(3);

 const { kept, removed } = pruneDumpToCollidingHashes();
 expect(kept).toBe(2);
 expect(removed).toBe(1);

 const after = fs.readdirSync(tmp).filter((f) => f.endsWith('.html'));
 expect(after).toHaveLength(2);
 });

 it('does nothing when dump dir is null (default)', () => {
 configureDumpDir(null);
 claim('/dist/a/index.html', 'pluginA', '<html>v1</html>');
 // No file would be created anyway since dir is null. Verify prune is a no-op too.
 const result = pruneDumpToCollidingHashes();
 expect(result).toEqual({ kept: 0, removed: 0 });
 });
 });
});
