import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = path.resolve(
  process.cwd(),
  '.github/workflows/crawler-data-quality-audit.yml',
);

function workflowSource(): string {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8');
}

describe('weekly crawler data-quality audit issue transport (#6787)', () => {
  it('precomputes multiline bodies and leaves Claude only planned gh actions', () => {
    const source = workflowSource();

    expect(source).toContain('Build bounded data-quality action packet');
    expect(source).toContain('scripts/ci/crawler-data-quality-candidates.mjs');
    expect(source).toContain('--open-issues /tmp/crawler-data-quality-open-issues.json');
    expect(source).toContain('${{ steps.evidence.outputs.packet }}');
    expect(source).toContain("--allowedTools 'Bash(gh:*)'");
    expect(source).not.toMatch(
      /allowedTools[^\n]*(?:Bash\((?:git|node):\*\)|Read|Grep|Glob|Edit|Write)/,
    );
    expect(source).toContain(
      'gh issue create --title <title> --label crawler-data-quality --body-file <bodyFile>',
    );
    expect(source).toContain('gh issue comment <issueNumber> --body-file <bodyFile>');
    expect(source).not.toMatch(/gh issue create[^\n]* --body "/);
  });

  it('keeps the Claude phase read-only outside preplanned issue operations', () => {
    const source = workflowSource();

    expect(source).toMatch(/permissions:\n  contents: read\n  issues: write/);
    expect(source).toContain('non modificare il checkout e non tentare fix');
    expect(source).not.toContain('Edit(//home/runner/');
    expect(source).not.toContain(',Edit,Write');
  });

  it('ratchets the observed max-turn failure and bounded terminal behavior', () => {
    const source = workflowSource();

    expect(source).toContain('61 Bash, 19 Read');
    expect(source).toContain('6 Grep, then turn 81/80');
    expect(source).toContain('Esegui le azioni in ordine, esattamente una volta ciascuna');
    expect(source).toContain("Se `actions` è vuoto, termina senza tool call.");
    expect(source).toContain('Se un comando fallisce, non cambiare forma né usare body inline');
  });
});
