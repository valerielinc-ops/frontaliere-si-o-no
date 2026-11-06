import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = readFileSync(resolve(ROOT, '.github/workflows/blog-cover-ledger.yml'), 'utf8');

describe('blog cover ledger workflow', () => {
  it('protects Markdown code spans in the dynamically expanded PR body', () => {
    const bodyStart = WORKFLOW.indexOf('cat > "$body" <<EOF');
    const bodyEnd = WORKFLOW.indexOf('\n          EOF', bodyStart);

    expect(bodyStart).toBeGreaterThanOrEqual(0);
    expect(bodyEnd).toBeGreaterThan(bodyStart);

    const generatedBody = WORKFLOW.slice(bodyStart, bodyEnd);
    const rawBackticks = generatedBody
      .split('\n')
      .filter((line) => line.includes('`') && !line.includes('\\`'));

    expect(generatedBody).toContain('## Implementato');
    expect(generatedBody).toContain('## Non implementato (ancora)');
    expect(generatedBody).toContain('${remaining}');
    expect(rawBackticks).toEqual([]);
  });
});
