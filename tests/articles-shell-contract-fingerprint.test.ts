// Cross-repo guard for the article host chrome (issue #4974 item 3).
//
// nanakokyobashi-rgb/frontaliere-articles carries a TRANSPORTED copy of the
// scalar half of this contract under its `host/` tree, so it can render an
// article without this repository. Those values render into every article
// <head>: if the two repos disagree, a fast-published page differs from the
// full build that later overwrites it — churn that only ever surfaces in
// production.
//
// Both repos assert the same fingerprint, so either side drifting fails on its
// own side. When changing any value below intentionally, re-record the digest
// in BOTH repos in the same change.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { contract } from '../build-plugins/articlesSiteShellBootstrap';

const expected = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tests/articles-shell-contract-fingerprint.json'), 'utf-8'),
);

describe('articles SiteShellContract — cross-repo fingerprint', () => {
  it('matches the digest the articles repo also asserts', () => {
    const scalars: Record<string, unknown> = {};
    for (const k of Object.keys(contract).sort()) {
      const v = (contract as unknown as Record<string, unknown>)[k];
      if (typeof v !== 'function') scalars[k] = v;
    }
    expect(Object.keys(scalars).length).toBe(expected.scalarFields);
    // RegExp has no own enumerable properties, so plain JSON.stringify serializes
    // every RegExp (e.g. contextualLinkRules[].keywordPattern) to `{}` — a source/flags
    // edit wouldn't move the digest at all. The replacer forces RegExp through
    // String(v) so regex-only drift is actually covered (issue #6396).
    const sha = createHash('sha256')
      .update(JSON.stringify(scalars, (_key, value) => (value instanceof RegExp ? String(value) : value), 2))
      .digest('hex');
    expect(sha, 'host chrome drifted — re-record in BOTH repos').toBe(expected.sha256);
  });
});
