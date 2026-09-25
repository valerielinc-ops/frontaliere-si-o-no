import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Regression gate for #5715 (follow-up of #5702/#5675): the reviewer flagged
 * that a manual grep for `info@frontaliereticino` on `/privacy/` and
 * `/privacy-policy/` doesn't prove no OTHER static legal page in
 * staticPagesPlugin.ts names a data-controller/rights-exercise contact with
 * a different, un-audited pattern. Turning that one-off grep into a gate:
 * any editorialBlocks string that identifies the GDPR/FADP data controller
 * ("titolare del trattamento" / "data controller for") MUST route the email
 * through the canonical `${DATA_CONTROLLER_EMAIL}` interpolation — never a
 * hardcoded `something@frontaliereticino.ch` literal, which is exactly how
 * `/privacy/` and `/privacy-policy/` drifted before #5702.
 */

const ROOT = path.resolve(__dirname, '..');
const pluginSource = readFileSync(path.resolve(ROOT, 'build-plugins', 'staticPagesPlugin.ts'), 'utf-8');

describe('staticPagesPlugin data-controller contact', () => {
  it('imports the canonical DATA_CONTROLLER_NAME/EMAIL, not a local literal', () => {
    expect(pluginSource).toMatch(
      /import \{ DATA_CONTROLLER_NAME, DATA_CONTROLLER_EMAIL \} from '.*dataControllerIdentity\.js'/,
    );
  });

  it('every block naming the data controller uses ${DATA_CONTROLLER_EMAIL}, never a hardcoded address', () => {
    // Matches the two known blocks (`/privacy/`, `/privacy-policy/`) by the
    // phrase that identifies the controller, IT and EN — and any future
    // block reusing the same phrasing, so a new legal page can't silently
    // reintroduce a stale literal.
    const controllerBlockRx = /`[^`]*(?:titolare del trattamento|data controller for)[^`]*`/gs;
    const blocks = pluginSource.match(controllerBlockRx) ?? [];
    expect(blocks.length).toBeGreaterThanOrEqual(2);

    const hardcodedEmailRx = /[a-zA-Z0-9._%+-]+@frontaliereticino\.ch/;
    for (const block of blocks) {
      expect(block, `block does not interpolate DATA_CONTROLLER_EMAIL:\n${block}`).toContain(
        '${DATA_CONTROLLER_EMAIL}',
      );
      const withoutCanonicalInterpolation = block.replace(/\$\{DATA_CONTROLLER_(?:EMAIL|NAME)\}/g, '');
      expect(
        withoutCanonicalInterpolation,
        `block names the data controller but also carries a hardcoded email literal:\n${block}`,
      ).not.toMatch(hardcodedEmailRx);
    }
  });
});
