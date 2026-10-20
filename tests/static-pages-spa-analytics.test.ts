import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ADSENSE_SNIPPET,
  ANALYTICS_SNIPPET,
  GTAG_SNIPPET,
  PARTNERIZE_TAG_SNIPPET,
  POSTHOG_SNIPPET,
} from '../build-plugins/constants';
import { readBuildPluginSource } from './helpers/buildPluginSource';

const source = readBuildPluginSource(resolve(__dirname, '..', 'build-plugins/staticPagesPlugin.ts'));
const spaBranchStart = source.indexOf('if (hasSpaBundle) {');
const spaBranchEnd = source.indexOf('// Fallback: redirect to SPA', spaBranchStart);
const spaBranch = source.slice(spaBranchStart, spaBranchEnd);

describe('static-page analytics ownership', () => {
  it('keeps the standalone analytics contract for bundle-less pages', () => {
    expect(ANALYTICS_SNIPPET).toContain(GTAG_SNIPPET);
    expect(ANALYTICS_SNIPPET).toContain(POSTHOG_SNIPPET);
    expect(ANALYTICS_SNIPPET).toContain(ADSENSE_SNIPPET);
    expect(ANALYTICS_SNIPPET).toContain(PARTNERIZE_TAG_SNIPPET);
  });

  it('does not bootstrap standalone PostHog on pages that hydrate the SPA', () => {
    expect(spaBranchStart).toBeGreaterThanOrEqual(0);
    expect(spaBranchEnd).toBeGreaterThan(spaBranchStart);
    expect(spaBranch).toContain('${SPA_ANALYTICS_SNIPPET}');
    expect(spaBranch).not.toContain('${ANALYTICS_SNIPPET}');
    expect(source).toContain('const SPA_ANALYTICS_SNIPPET');
    expect(source).toContain('${GTAG_SNIPPET}');
    expect(source).toContain('${ADSENSE_SNIPPET}');
    expect(source).toContain('${PARTNERIZE_TAG_SNIPPET}');
    expect(spaBranch).not.toContain('${POSTHOG_SNIPPET}');
  });
});
