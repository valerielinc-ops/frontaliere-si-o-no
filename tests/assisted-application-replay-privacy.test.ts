import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPLAY_PRIVATE_ATTRS, REPLAY_PRIVATE_CLASS } from '../services/replayPrivacy';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
// A tag that carries both markers: the class first in its className, the attributes spread next to it.
const masked = (tag: string) => new RegExp(`<${tag} className=\\{\`\\$\\{REPLAY_PRIVATE_CLASS\\} [^\`]*\`\\} \\{\\.\\.\\.REPLAY_PRIVATE_ATTRS\\}`, 'g');

describe('session replay and the assisted application', () => {
  it('uses the opt-outs PostHog and Clarity document', () => {
    expect(REPLAY_PRIVATE_CLASS).toBe('ph-no-capture');
    expect(REPLAY_PRIVATE_ATTRS).toEqual({ 'data-clarity-mask': 'true' });
  });

  // The review page shows the letter, the CV lines, the personal data and the photo; the upload
  // page the order and the CV file; the owner queue every candidate's data. posthog-js records
  // rendered text nodes and Clarity has no masking configured: each page root opts out.
  it.each([
    ['components/community/AssistedApplicationReview.tsx', 'main', 2],
    ['components/community/AssistedApplicationUpload.tsx', 'main', 1],
  ])('%s masks every page root', (path, tag, roots) => {
    const source = read(path);
    expect(source.match(masked(tag)) || []).toHaveLength(roots);
    expect(source.match(new RegExp(`<${tag}\\b`, 'g')) || []).toHaveLength(roots);
  });

  it('masks the owner queue, the automation panel included', () => {
    const source = read('components/pages/AssistedApplicationAdmin.tsx');
    const root = source.indexOf('aria-labelledby="assisted-application-admin-title"');
    expect(root).toBeGreaterThan(-1);
    const tag = source.slice(source.lastIndexOf('<section', root), root);
    expect(tag.match(masked('section')) || []).toHaveLength(1);
    // The panel is rendered inside that section, so it needs no marker of its own.
    expect(source.indexOf('<AssistedApplicationAutomationPanel')).toBeGreaterThan(root);
  });

  it('keeps the markers in one module', () => {
    for (const path of [
      'components/community/AssistedApplicationReview.tsx',
      'components/community/AssistedApplicationUpload.tsx',
      'components/pages/AssistedApplicationAdmin.tsx',
      'components/shared/AiChatbot.tsx',
    ]) {
      const source = read(path);
      expect(source).not.toMatch(/['"`]ph-no-capture|data-clarity-mask=/);
      expect(source).toContain("from '@/services/replayPrivacy'");
    }
  });
});
