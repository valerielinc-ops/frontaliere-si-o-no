import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  REQUIRED_FULL_CHECKOUT_ARTIFACTS,
  missingFullCheckoutArtifacts,
} from '../scripts/ci/lib/typecheck-sparse.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('sparse typecheck checkout sentinels (#13616 FU-015)', () => {
  it('reports every missing full-checkout sentinel in stable order', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typecheck-sentinels-'));
    roots.push(root);

    expect(missingFullCheckoutArtifacts(root)).toEqual([...REQUIRED_FULL_CHECKOUT_ARTIFACTS]);
  });

  it('recognizes a complete sentinel set and reports only a removed artifact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typecheck-sentinels-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.mkdirSync(path.join(root, 'public'), { recursive: true });
    for (const relative of REQUIRED_FULL_CHECKOUT_ARTIFACTS) {
      fs.writeFileSync(path.join(root, relative), 'sentinel\n');
    }

    expect(missingFullCheckoutArtifacts(root)).toEqual([]);
    fs.rmSync(path.join(root, 'public', '.nojekyll'));
    expect(missingFullCheckoutArtifacts(root)).toEqual(['public/.nojekyll']);
  });
});
