import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAggregate, parseIssuePayload } from '../scripts/ci/detect-aggregate.mjs';
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

  it('tratta un payload gh vuoto come lettura degradata, non come issue singola', () => {
    const parsed = parseIssuePayload({ title: '', body: '' });
    expect(parsed.readable).toBe(false);
    expect(detectAggregate(parsed)).toEqual({ aggregate: true, fallback: true });
  });

  it('non lascia in-flight la issue se anche la scrittura su GITHUB_OUTPUT fa throw', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'detect-aggregate-'));
    try {
      const fakeGh = join(sandbox, 'gh');
      writeFileSync(fakeGh, '#!/bin/sh\nprintf \'%s\' \'{"title":"fix: one item","body":"Suggested action: one change"}\'\n');
      chmodSync(fakeGh, 0o755);
      const outputDirectory = join(sandbox, 'github-output');
      mkdirSync(outputDirectory);

      const result = spawnSync(
        process.execPath,
        ['scripts/ci/detect-aggregate.mjs'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${sandbox}:${process.env.PATH || ''}`,
            REPO: 'owner/repo',
            ISSUE_NUMBER: '1176',
            GITHUB_OUTPUT: outputDirectory,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('is_aggregate=true');
      expect(result.stderr).toContain('errore non gestito');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('mantiene il conteggio di vecchie righe shell fuori dal workflow', () => {
    expect(workflowCode).toContain('node scripts/ci/detect-aggregate.mjs');
    expect(workflowCode).not.toMatch(/agg_count/);
    expect(workflowCode).not.toMatch(/is_agg=/);
    expect(workflowCode).not.toMatch(/grep -cE/);
  });
});
