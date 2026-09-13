import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { detectAggregate } from '../scripts/ci/detect-aggregate.mjs';
import { isAggregate } from '../scripts/ci/check-issue-already-resolved.mjs';

const workflow = readFileSync('.github/workflows/issue-fix.yml', 'utf8');
const workflowCode = workflow
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

const cases = [
  {
    name: 'tre item in bullet con lead in grassetto',
    title: 'follow-up(#450): tre item residui',
    body: [
      'Item residui:',
      '',
      '- **Primo controllo da fare.** Testo.',
      '- **Secondo controllo da fare.** Altro testo.',
      '- **Terzo controllo da fare.** Altro testo ancora.',
    ].join('\n'),
    aggregate: true,
  },
  {
    name: 'un item con quattro path elencati',
    title: 'fix: il selettore del ticker non normalizza il locale',
    body: [
      'Il difetto tocca quattro file:',
      '',
      '- `scripts/build-api.mjs`',
      '- `host/shared/localeEmitFilter.ts`',
      '- `engine/ticker.ts`',
      '- `generator/tests/ticker.test.mjs`',
    ].join('\n'),
    aggregate: false,
  },
];

describe('issue-fix aggregate detector site port (#986)', () => {
  it('delega il verdetto alla regola condivisa', () => {
    for (const fixture of cases) {
      expect(detectAggregate(fixture).aggregate, fixture.name).toBe(fixture.aggregate);
      expect(detectAggregate(fixture).aggregate, fixture.name).toBe(isAggregate(fixture.title, fixture.body));
    }
  });

  it('usa la direzione reversibile quando la issue non è leggibile', () => {
    expect(detectAggregate({ readable: false })).toEqual({ aggregate: true, fallback: true });
  });

  it('mantiene il conteggio di vecchie righe shell fuori dal workflow', () => {
    expect(workflowCode).toContain('node scripts/ci/detect-aggregate.mjs');
    expect(workflowCode).not.toMatch(/agg_count/);
    expect(workflowCode).not.toMatch(/is_agg=/);
    expect(workflowCode).not.toMatch(/grep -cE/);
  });
});
