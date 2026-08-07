/**
 * Writes build-id.txt and commit-hash.txt into the output directory so the
 * running app can compare its compiled-in BUILD_ID against the deployed one.
 */

// Import statico, NON `await import()` dentro closeBundle (#5001): quell'await
// sospende il plugin e un altro plugin `enforce:'post'` puo' girare per intero
// prima che riprenda — gia' costato due bug silenziosi questa settimana.
import fs from 'fs';
import path from 'path';
import type { Plugin } from 'vite';
import { BUILD_ID, COMMIT_HASH } from './constants';

export function buildIdPlugin(rootDir: string): Plugin {
 return {
 name: 'build-id',
 apply: 'build',
 async closeBundle() {
 const outDir = path.resolve(rootDir, 'dist');
 fs.mkdirSync(outDir, { recursive: true });
 fs.writeFileSync(path.join(outDir, 'build-id.txt'), BUILD_ID, 'utf-8');
 fs.writeFileSync(path.join(outDir, 'commit-hash.txt'), COMMIT_HASH, 'utf-8');
 },
 };
}
