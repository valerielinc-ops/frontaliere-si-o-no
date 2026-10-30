/** Regenerate the transported public assets (no cross-repository runtime import):
 * npx tsx scripts/ci/export-third-party-shell-assets.ts > third-party-shell-assets.json
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import {
 ADSENSE_LOADER_CONTENT, ADSENSE_LOADER_VERSIONED_FILENAME,
 PARTNERIZE_TAG_CONTENT, PARTNERIZE_TAG_VERSIONED_FILENAME,
} from '../../build-plugins/constants';

export function thirdPartyShellAssetSnapshot() {
 const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
 return {
  version: 1,
  source: {
   producer: 'build-plugins/constants.ts',
   sanitizerSha256: digest(readFileSync(new NodeURL('../../services/analyticsUrlPrivacy.js', import.meta.url))),
   guardSha256: digest(readFileSync(new NodeURL('../../services/thirdPartyDocumentPrivacy.js', import.meta.url))),
  },
  assets: [[ADSENSE_LOADER_VERSIONED_FILENAME, ADSENSE_LOADER_CONTENT], [PARTNERIZE_TAG_VERSIONED_FILENAME, PARTNERIZE_TAG_CONTENT]]
   .map(([name, content]) => ({ name, sha256: digest(content), content })),
 };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
 console.log(JSON.stringify(thirdPartyShellAssetSnapshot(), null, 2));
}
