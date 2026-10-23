import { describe, expect, it } from 'vitest';

import { scanRedirectSource } from '../packages/articles/engine/shared/articleRouteOwnership.mjs';

describe('FU-2026-10-22-002 — lexical legacy redirect scanning', () => {
  it('ignores comment/string/template lookalikes and keeps literals after consecutive comments', () => {
    const source = `
      const redirectSource = {
        // '/commented-out': '/wrong-target',
        /*
         * '/multiline-comment': '/wrong-target',
         */
        '/live-route': /* first comment */ /* second comment */ '/canonical',
        constText: '"/string-lookalike": "/wrong-target"',
        templateText: \`"/template-lookalike": "/wrong-target"\`,
      };
    `;

    expect(scanRedirectSource(source)).toEqual({
      entries: {
        '/live-route/': '/canonical/',
      },
      literalCount: 1,
      dynamicCount: 0,
      unsupported: [],
    });
  });
});
