import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

let hasPreparedOutDir = false;

export function prepareOutDirPlugin(rootDir: string): Plugin {
  return {
    name: 'prepare-out-dir-once',
    apply: 'build',
    buildStart() {
      if (hasPreparedOutDir) return;
      hasPreparedOutDir = true;
      const distDir = path.resolve(rootDir, 'dist');
      fs.rmSync(distDir, { recursive: true, force: true });
      fs.mkdirSync(distDir, { recursive: true });
    },
  };
}
