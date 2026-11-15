import fs from 'node:fs';
import path from 'node:path';
import {
  publishVersionedCdnAssets,
  VERSIONED_CDN_POST_BUILD_MANIFEST,
} from '../build-plugins/versionedCdnAssetsPlugin.ts';

const rootDir = process.cwd();
const manifestPath = path.join(rootDir, 'dist', VERSIONED_CDN_POST_BUILD_MANIFEST);

if (!fs.existsSync(manifestPath)) {
  console.log('[versioned-cdn-assets] skipped (no post-build manifest)');
  process.exit(0);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
await publishVersionedCdnAssets(rootDir, manifest);
fs.rmSync(manifestPath, { force: true });
