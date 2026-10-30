/** Regenerate the transported public assets (no cross-repository runtime import):
 * npx tsx scripts/ci/export-third-party-shell-assets.ts > third-party-shell-assets.json
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import {
 ADSENSE_LOADER_CONTENT, ADSENSE_LOADER_VERSIONED_FILENAME,
 PARTNERIZE_TAG_CONTENT, PARTNERIZE_TAG_VERSIONED_FILENAME, THIRD_PARTY_DOCUMENT_INITIAL_GUARD,
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
  initialDocumentGuard: {
   sha256: digest(THIRD_PARTY_DOCUMENT_INITIAL_GUARD), content: THIRD_PARTY_DOCUMENT_INITIAL_GUARD,
  },
  assets: [[ADSENSE_LOADER_VERSIONED_FILENAME, ADSENSE_LOADER_CONTENT], [PARTNERIZE_TAG_VERSIONED_FILENAME, PARTNERIZE_TAG_CONTENT]]
   .map(([name, content]) => ({ name, sha256: digest(content), content })),
 };
}

if (isInvokedDirectly(import.meta.url)) {
 console.log(JSON.stringify(thirdPartyShellAssetSnapshot(), null, 2));
}
