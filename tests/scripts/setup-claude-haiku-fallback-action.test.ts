import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const actionPath = path.resolve(process.cwd(), '.github/actions/setup-claude-haiku-fallback/action.yml');

describe('Claude Haiku fallback setup action', () => {
  it('keeps Codex installation best-effort without disabling Claude/cascade', () => {
    const action = fs.readFileSync(actionPath, 'utf8');
    expect(action).toContain('if npm install -g --no-fund --no-audit @openai/codex@0.153.4; then');
    expect(action).toContain('::warning::Codex CLI install failed; Claude and the normal fallback cascade remain available');
    expect(action).toContain('echo "ENABLE_HAIKU_ARTICLE_FALLBACK=1" >> "$GITHUB_ENV"');
  });
});
