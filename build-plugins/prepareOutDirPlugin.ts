import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { Plugin } from 'vite';

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
    execSync(`find ${JSON.stringify(dir)} -delete`);
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
      const distDir = path.resolve(rootDir, 'dist');
      removeDir(distDir);
      fs.mkdirSync(distDir, { recursive: true });
    },
  };
}
