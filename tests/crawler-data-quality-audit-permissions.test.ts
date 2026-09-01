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
    const exactEditSlots = [...source.matchAll(
      /Edit\(\/\/tmp\/crawler-data-quality-issue-(\d)\.md\)/g,
    )].map((match) => Number(match[1]));

    expect(exactEditSlots).toEqual([1, 2, 3, 4, 5]);
    expect(source).not.toContain('Edit(//tmp/crawler-data-quality-issue-*.md)');
    expect(source).not.toMatch(/allowedTools[^\n]*[,']Write(?:[,'])/);
    expect(source).toContain('for n in 1 2 3 4 5; do');
    expect(source).toContain("printf '%s\\n' '<!-- CRAWLER_DATA_QUALITY_BODY -->'");
    expect(source).toContain('usa lo strumento **Edit** sul successivo slot pre-creato');
    expect(source).toContain("Non usare Write: gli slot esistono gia'.");
    expect(source).toContain(
      'gh issue create --title "[data-quality] <categoria>: <sintesi breve>" --label crawler-data-quality --body-file /tmp/crawler-data-quality-issue-N.md',
    );
    expect(source).toContain(
      'gh issue comment <numero> --body-file /tmp/crawler-data-quality-issue-N.md',
    );
    expect(source).toContain('**MAI** passare il body inline con `--body`');
    expect(source).not.toMatch(/gh issue create[^\n]* --body "</);
  });

  it('keeps the audit read-only outside issue operations and the scoped /tmp body', () => {
    const source = workflowSource();

    expect(source).toMatch(/permissions:\n  contents: read\n  issues: write/);
    expect(source).toContain(
      'Le uniche modifiche su file ammesse sono la sostituzione del marker nei cinque slot',
    );
    expect(source).not.toContain('Edit(//home/runner/');
    expect(source).not.toContain(',Edit,Write');
  });

  it('ratchets the observed max-turn failure and explicit terminal behavior', () => {
    const source = workflowSource();

    expect(source).toContain('six denied Write calls and four denied');
    expect(source).toContain('consumed turn 81/80');
    expect(source).toContain(
      'Solo dopo aver completato create o dedup-comment per TUTTI i pattern',
    );
  });
});
