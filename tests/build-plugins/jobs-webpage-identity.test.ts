import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = fs.readFileSync(
  path.resolve(process.cwd(), 'build-plugins/jobsSeoPagesPlugin.ts'),
  'utf8',
);

describe('jobs SEO WebPage identity', () => {
  it('names the hand-rolled active job WebPage node', () => {
    expect(SOURCE).toContain(
      "'@type':'WebPage',name:localizedTitle,url:canonicalUrl,inLanguage:locale",
    );
  });

  it('names the employer hub WebPage node', () => {
    expect(SOURCE).toMatch(
      /const webPageLd = inlineScriptJson\(\{[\s\S]*?'@type': 'WebPage',[\s\S]*?name: title,[\s\S]*?url: canonicalUrl,/,
    );
  });
});
