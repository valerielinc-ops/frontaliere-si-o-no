import { describe, expect, it } from 'vitest';
// @ts-expect-error — il supervisore è uno script ESM zero-dependency applicativo
import {
  auditWorkflowFiles,
  auditWorkflowText,
  cronError,
  normalizeTriggers,
  renderMarkdown,
  summarize,
} from '../scripts/ci/technical-operations-audit.mjs';

describe('technical operations audit', () => {
  it('normalizza le tre forme valide di on', () => {
    expect(normalizeTriggers('push')).toEqual({ push: null });
    expect(normalizeTriggers(['push', 'workflow_dispatch'])).toEqual({ push: null, workflow_dispatch: null });
    expect(normalizeTriggers({ schedule: [{ cron: '0 5 * * *' }] })).toEqual({ schedule: [{ cron: '0 5 * * *' }] });
  });

  it('rifiuta cron con forma o intervallo impossibile', () => {
    expect(cronError('0 5 * * *')).toBeNull();
    expect(cronError('0 5 * *')).toMatch(/5 campi/);
    expect(cronError('60 5 * * *')).toMatch(/fuori intervallo/);
    expect(cronError('0 5 ? * *')).toMatch(/non valido/);
  });

  it('mantiene valida la sintassi custom background/wait-all solo nel contratto previsto', () => {
    const source = [
      'name: valid',
      'on: [push]',
      'permissions:',
      '  contents: read',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: parallel',
      '        run: node scripts/example.mjs',
      '        background: true',
      '      - name: join',
      '        wait-all: true',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/valid.yml', source, {
      root: '/repo',
      exists: (candidate: string) => candidate === '/repo/scripts/example.mjs',
    });
    expect(findings.filter((item: any) => item.rule.startsWith('workflow.background'))).toEqual([]);
    expect(findings.filter((item: any) => item.rule.startsWith('workflow.wait-all'))).toEqual([]);
  });

  it('segnala riferimenti, step executor, concurrency e scrittura dati senza check', () => {
    const source = [
      'name: broken',
      'on:',
      '  workflow_dispatch:',
      '    inputs:',
      '      known:',
      '        type: string',
      '  schedule:',
      '    - cron: "0 5 * * *"',
      'permissions:',
      '  contents: read',
      'concurrency:',
      '  group: broken',
      '  queue: max',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    needs: missing-job',
      '    steps:',
      '      - name: no executor',
      '      - name: write',
      '        id: writer',
      '        run: git add data/result.json && git commit -m result',
      '      - name: reference',
      '        run: echo "${{ steps.missing.outputs.value }} ${{ inputs.unknown }}"',
      '        id: ref',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/broken.yml', source, { root: '/repo' });
    const rules = new Set(findings.map((item: any) => item.rule));
    expect([...rules]).toEqual(expect.arrayContaining([
      'workflow.concurrency-key',
      'workflow.needs-reference',
      'workflow.step-executor',
      'workflow.input-reference',
      'workflow.step-reference',
      'workflow.data-write-without-check',
    ]));
  });

  it('segnala un output referenziato che il run non produce', () => {
    const source = [
      'name: output',
      'on: [push]',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: producer',
      '        id: producer',
      '        run: echo "actual=yes" >> "$GITHUB_OUTPUT"',
      '      - name: consumer',
      '        run: echo "${{ steps.producer.outputs.expected }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/output.yml', source, { root: '/repo' });
    expect(findings.map((item: any) => item.rule)).toContain('workflow.output-not-produced');
  });

  it('scansiona l’inventario reale e non può passare con uno scan vuoto', () => {
    const report = auditWorkflowFiles(process.cwd());
    expect(report.filesScanned).toBeGreaterThanOrEqual(200);
    expect(report.workflowNames.length).toBeGreaterThanOrEqual(200);
    expect(report.findings.every((item: any) => item.file.endsWith('.yml') || item.file.endsWith('.yaml'))).toBe(true);
  });

  it('renderizza conteggi e severità nel report', () => {
    const report = {
      filesScanned: 1,
      commit: 'abc',
      generatedAt: '2026-09-12T00:00:00.000Z',
      findings: [{ file: 'a.yml', line: 2, rule: 'r', severity: 'error', message: 'broken' }],
    };
    expect(summarize(report)).toEqual({ error: 1, warning: 0, info: 0, total: 1 });
    expect(renderMarkdown(report)).toContain('Errori: **1**');
    expect(renderMarkdown(report)).toContain('a.yml:2');
  });
});
