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
  it('allows multiline issue bodies only through dedicated temporary files', () => {
    const source = workflowSource();

    expect(source).toContain('Edit(//tmp/crawler-data-quality-issue-*.md)');
    expect(source).not.toMatch(/allowedTools[^\n]*[,']Write(?:[,'])/);
    expect(source).toContain(
      'gh issue create --title "[data-quality] <categoria>: <sintesi breve>" --label crawler-data-quality --body-file /tmp/crawler-data-quality-issue-N.md',
    );
    expect(source).toContain('**MAI** passare il body inline con `--body`');
    expect(source).not.toMatch(/gh issue create[^\n]* --body "</);
  });

  it('keeps the audit read-only outside issue operations and the scoped /tmp body', () => {
    const source = workflowSource();

    expect(source).toMatch(/permissions:\n  contents: read\n  issues: write/);
    expect(source).toContain(
      "L'unica scrittura su file ammessa e' `/tmp/crawler-data-quality-issue-N.md`",
    );
    expect(source).not.toContain('Edit(//home/runner/');
    expect(source).not.toContain(',Edit,Write');
  });

  it('ratchets the observed max-turn failure and explicit terminal behavior', () => {
    const source = workflowSource();

    expect(source).toContain('six denied Write calls and four denied');
    expect(source).toContain('consumed turn 81/80');
    expect(source).toContain('termina subito con un riepilogo conciso');
  });
});
