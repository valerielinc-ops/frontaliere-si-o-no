// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { htmlHasIndexableRobots } from '../build-plugins/shared/incrementalHtmlReuse.mjs';

describe('indexable robots in generated and minified HTML', () => {
  it.each([
    '<meta name="robots" content="index, follow">',
    "<meta content='index,follow' name='robots'>",
    '<meta name=robots content=index,follow>',
    '<meta name=robots content=index,follow/>',
    '<meta name=robots content=index,follow><meta content=index name=robots>',
    '<META CONTENT="index, follow, max-image-preview:large" NAME=ROBOTS>',
    '<meta data-note="noindex" name=robots content=index,follow>',
  ])('recognizes an indexable directive: %s', (html) => {
    expect(htmlHasIndexableRobots(html)).toBe(true);
  });
  it.each([
    '<meta name=robots content=noindex,follow>',
    '<meta name=robots content=noindex/>',
    '<meta name=robots content=index,follow><meta name=robots content=noindex>',
    '<meta name=robots content=noindex><meta name=robots content=index,follow>',
    '<meta name=robots><meta name=robots content=index,follow>',
    '<meta content="NOINDEX, follow" name="robots">',
    '<meta data-name=robots content=index,follow>',
    '<meta name=robots-extra content=index,follow>',
    '<meta name=robots>',
    '<meta name=description content="name=robots content=index">',
    '<html><head></head></html>',
  ])('does not promote noindex or unknown metadata: %s', (html) => {
    expect(htmlHasIndexableRobots(html)).toBe(false);
  });
});
