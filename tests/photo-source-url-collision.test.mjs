import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalPhotoSourceUrl,
  photoRecordCollision,
} from '../packages/articles/engine/shared/generatedImageEngine.mjs';

test('photo collision keys ignore URL case, query, fragment, encoding and trailing slash', () => {
  assert.equal(
    canonicalPhotoSourceUrl('HTTPS://WWW.PEXELS.COM/photo/caf%C3%A8/?utm_source=feed#credit'),
    'https://www.pexels.com/photo/caf%C3%A8',
  );

  assert.deepEqual(
    photoRecordCollision(
      {
        kind: 'photo',
        scope: 'article-hero',
        sourcePageUrl: 'https://www.pexels.com/photo/caf%C3%A8/',
      },
      [{
        scope: 'article-hero',
        assetId: 'legacy-credit.json',
        sourcePageUrl: 'https://www.pexels.com/photo/caf%c3%a8',
      }],
    ),
    {
      type: 'sourcePageUrl',
      value: 'https://www.pexels.com/photo/caf%C3%A8',
      assetId: 'legacy-credit.json',
    },
  );
});
