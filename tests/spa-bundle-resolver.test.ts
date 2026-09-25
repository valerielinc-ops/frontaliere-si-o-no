import { describe, it, expect } from 'vitest';
import { resolveSpaBundle } from '../build-plugins/spaBundleResolver';
import { SPA_ENTRY_JS_FILENAME, SPA_ENTRY_CSS_FILENAME } from '../build-plugins/shared/spaEntryFilenames';

describe('resolveSpaBundle', () => {
  it('returns the stable entry filenames without touching disk', () => {
    const info = resolveSpaBundle('/nonexistent/dist/dir');
    expect(info.entryJs).toBe(SPA_ENTRY_JS_FILENAME);
    expect(info.entryCss).toBe(SPA_ENTRY_CSS_FILENAME);
    expect(info.hasSpaBundle).toBe(true);
  });

  it('returns the same value regardless of distDir', () => {
    const first = resolveSpaBundle('/some/dist');
    const second = resolveSpaBundle('/other/dist');
    expect(second.entryJs).toBe(first.entryJs);
    expect(second.entryCss).toBe(first.entryCss);
  });
});
