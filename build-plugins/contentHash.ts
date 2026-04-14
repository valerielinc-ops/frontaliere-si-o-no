/**
 * Content-hash manifest for incremental builds.
 *
 * Stores SHA256 hashes of generated HTML files. On subsequent builds,
 * files whose content hasn't changed are skipped, reducing I/O from
 * 55k+ writes to only the files that actually changed.
 *
 * Manifest is stored in .build-cache/ (outside dist/, which is wiped each build).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const CACHE_DIR = '.build-cache';
const MANIFEST_FILE = 'build-manifest.json';

interface ManifestData {
 version: number;
 files: Record<string, string>; // relativePath → SHA256 hash
}

/** Compute SHA256 of a string (fast — ~0.5s for 55k files of 30KB each). */
function sha256(content: string): string {
 return createHash('sha256').update(content, 'utf-8').digest('hex');
}

export class ContentHashManifest {
 private previous: Record<string, string>;
 private current: Record<string, string> = {};
 private distDir: string;
 private cacheDir: string;
 private _skipped = 0;
 private _written = 0;

 constructor(rootDir: string) {
 this.distDir = path.resolve(rootDir, 'dist');
 this.cacheDir = path.resolve(rootDir, CACHE_DIR);
 this.previous = this.load();
 }

 private load(): Record<string, string> {
 try {
 const manifestPath = path.join(this.cacheDir, MANIFEST_FILE);
 const raw = fs.readFileSync(manifestPath, 'utf-8');
 const data: ManifestData = JSON.parse(raw);
 if (data.version === 1 && data.files) {
 return data.files;
 }
 } catch {
 // Missing or corrupted manifest — start fresh (full build)
 }
 return {};
 }

 /**
 * Check if a file needs to be written.
 * Returns false if the content hash matches the previous build (skip the write).
 */
 shouldWrite(relativePath: string, content: string): boolean {
 const hash = sha256(content);
 this.current[relativePath] = hash;
 if (this.previous[relativePath] === hash) {
 this._skipped++;
 return false;
 }
 this._written++;
 return true;
 }

 /** Save the manifest for the next build. */
 save(): void {
 fs.mkdirSync(this.cacheDir, { recursive: true });
 const data: ManifestData = { version: 1, files: this.current };
 fs.writeFileSync(
 path.join(this.cacheDir, MANIFEST_FILE),
 JSON.stringify(data),
 'utf-8',
 );
 }

 get skipped() { return this._skipped; }
 get written() { return this._written; }
 get previousSize() { return Object.keys(this.previous).length; }
}

/**
 * Singleton manifest shared across all plugins in the same build process.
 * Call initManifest() once at build start, then getManifest() in each plugin.
 */
let _instance: ContentHashManifest | null = null;

export function initManifest(rootDir: string): ContentHashManifest {
 if (!_instance) {
 _instance = new ContentHashManifest(rootDir);
 }
 return _instance;
}

export function getManifest(): ContentHashManifest | null {
 return _instance;
}

export function saveManifest(): void {
 _instance?.save();
 _instance = null; // Reset for next build
}
