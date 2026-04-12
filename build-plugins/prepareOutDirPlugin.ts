import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { Plugin } from 'vite';
import { initManifest, saveManifest } from './contentHash';

let hasPreparedOutDir = false;

function removeDir(dir: string): void {
  if (!fs.existsSync(dir)) return;
  // On POSIX (macOS/Linux) use shell rm -rf which correctly handles
  // macOS extended attributes and Spotlight-locked files that cause
  // fs.rmSync to fail with ENOTEMPTY on large directory trees.
  if (process.platform !== 'win32') {
    // Use `find -delete` instead of `rm -rf`: it traverses the tree bottom-up
    // and deletes each entry individually, avoiding the ENOTEMPTY errors that
    // macOS `rm -rf` produces when Spotlight/Finder hold .DS_Store xattr locks.
    // maxBuffer: 50MB to handle 40K+ file trees without ENOBUFS (FRO-280)
    execSync(`find ${JSON.stringify(dir)} -delete`, { maxBuffer: 50 * 1024 * 1024, stdio: 'pipe' });
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function prepareOutDirPlugin(rootDir: string): Plugin {
  return {
    name: 'prepare-out-dir-once',
    apply: 'build',
    buildStart() {
      if (hasPreparedOutDir) return;
      hasPreparedOutDir = true;
      // Load content hash manifest BEFORE wiping dist/ (manifest is stored in .build-cache/)
      const manifest = initManifest(rootDir);
      const distDir = path.resolve(rootDir, 'dist');
      const hasManifest = manifest.previousSize > 0;
      if (hasManifest) {
        // Incremental build: only wipe Vite's assets/ (JS/CSS bundles change each build)
        // but preserve generated HTML so content-hash skips actually work.
        const assetsDir = path.resolve(distDir, 'assets');
        removeDir(assetsDir);
        fs.mkdirSync(assetsDir, { recursive: true });
        console.log(`[prepare-out-dir] Incremental build: wiped assets/ only (${manifest.previousSize} manifest entries)`);
      } else {
        // First build (no manifest): full wipe
        removeDir(distDir);
        fs.mkdirSync(distDir, { recursive: true });
      }
    },
    closeBundle: {
      sequential: true,
      order: 'post' as const,
      handler() {
        // Save manifest after ALL plugins have finished writing files
        saveManifest();
      },
    },
  };
}
