import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WORKFLOW = readFileSync('.github/workflows/prospector-loop.yml', 'utf8');

describe('prospector-loop PROMOTE stability lever', () => {
  it('keeps --min-days available only to manual dispatches', () => {
    expect(WORKFLOW).toContain("PROMOTE_MIN_DAYS: ${{ github.event_name == 'workflow_dispatch' && github.event.inputs.promote_min_days || '' }}");
    expect(WORKFLOW).toContain('PROMOTE_ARGS=(--max="$PROMOTE_MAX" --open-pr)');
    expect(WORKFLOW).toContain('if [ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ]; then');
    expect(WORKFLOW).toContain('PROMOTE_ARGS+=(--min-days="$PROMOTE_MIN_DAYS")');
    expect(WORKFLOW).toContain('node scripts/prospect-promote.mjs "${PROMOTE_ARGS[@]}"');
    expect(WORKFLOW).not.toContain('node scripts/prospect-promote.mjs --max="$PROMOTE_MAX" --min-days="$PROMOTE_MIN_DAYS" --open-pr');
  });
});
