import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — il supervisore è uno script ESM zero-dependency applicativo
import {
  auditWorkflowFiles,
  auditWorkflowText,
  auditIssueRouting,
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

  it('instrada solo gli errori provati verso il fixer bounded', () => {
    expect(auditIssueRouting({ error: 1, warning: 4 })).toEqual({
      labels: ['operations-audit', 'agent:fix-queued', 'agent:no-age-out'],
      add: 'agent:fix-queued',
      remove: 'operations-audit-review',
      route: 'bounded-fix-queue',
    });
    expect(auditIssueRouting({ error: 0, warning: 26 })).toEqual({
      labels: ['operations-audit', 'operations-audit-review', 'agent:no-age-out'],
      add: 'operations-audit-review',
      remove: 'agent:fix-queued',
      route: 'review-only',
    });
  });

  it('rifiuta chiavi step non supportate da GitHub Actions', () => {
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
    expect(findings.filter((item: any) => item.rule === 'workflow.unsupported-step-key')).toHaveLength(2);
  });

  it('non interpreta le espressioni dentro commenti come input runtime', () => {
    const source = [
      '# documentazione: ${{ inputs.not_declared }}',
      'name: comments',
      'on:',
      '  workflow_dispatch:',
      '    inputs:',
      '      known:',
      '        type: string',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: run',
      '        run: |',
      '          # esempio non valutato: ${{ inputs.not_declared }}',
      '          echo "${{ inputs.known }}" # esempio inline non valutato: ${{ inputs.not_declared }}',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/comments.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.input-reference')).toEqual([]);

    const literalHash = auditWorkflowText('.github/workflows/literal-hash.yml', [
      'name: literal-hash',
      'on: [push]',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: run',
      '        run: echo jobs#all ${{ inputs.not_declared }}',
    ].join('\n'), { root: '/repo' });
    expect(literalHash.filter((item: any) => item.rule === 'workflow.input-reference')).toHaveLength(1);
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
      '  queue: bogus',
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
      'workflow.concurrency-value',
      'workflow.needs-reference',
      'workflow.step-executor',
      'workflow.input-reference',
      'workflow.step-reference',
      'workflow.data-write-without-check',
    ]));
  });

  it('non classifica una ricetta stampata come scrittura dati reale', () => {
    const source = [
      'name: recipe',
      'on: [workflow_dispatch]',
      'jobs:',
      '  baseline:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: instructions',
      '        # A comment may mention a quoted command without executing it.',
      '        run: echo "Download the artifact, then git add data/result.json and git commit"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/recipe.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.data-write-without-check')).toEqual([]);
  });

  it('maschera una ricetta tra apici singoli prima di valutare una scrittura reale', () => {
    const source = [
      'name: quoted-recipe-before-write',
      'on: [workflow_dispatch]',
      'jobs:',
      '  persist:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: write',
      "        run: echo 'validate data/result.json before publishing' && git add data/result.json && git commit -m result",
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/quoted-recipe-before-write.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.data-write-without-check')).toHaveLength(1);
  });

  it('mantiene il finding per una scrittura reale con path quotato', () => {
    const source = [
      'name: quoted-write',
      'on: [workflow_dispatch]',
      'jobs:',
      '  persist:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: commit',
      '        run: git add "data/result.json" && git commit -m result',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/quoted-write.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.data-write-without-check')).toHaveLength(1);
  });

  it('rileva una redirezione verso un path dati quotato', () => {
    const source = [
      'name: redirected-write',
      'on: [workflow_dispatch]',
      'jobs:',
      '  persist:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: write',
      '        run: printf payload > "data/result.json"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/redirected-write.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.data-write-without-check')).toHaveLength(1);
  });

  it('rileva anche il path quotato in una scrittura mista', () => {
    const source = [
      'name: mixed-write',
      'on: [workflow_dispatch]',
      'jobs:',
      '  persist:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: write',
      '        run: git add data/first.json "data/second.json" && git commit -m result',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/mixed-write.yml', source, { root: '/repo' });
    const writes = findings.filter((item: any) => item.rule === 'workflow.data-write-without-check');
    expect(writes).toHaveLength(2);
    expect(writes.map((item: any) => item.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('data/first.json'),
      expect.stringContaining('data/second.json'),
    ]));
  });

  it('mantiene il contesto di git add dopo una line-continuation', () => {
    const source = [
      'name: continued-add',
      'on: [workflow_dispatch]',
      'jobs:',
      '  persist:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: commit',
      '        run: |',
      '          git add \\',
      '            "data/result.json" && git commit -m result',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/continued-add.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.data-write-without-check')).toHaveLength(1);
  });

  it('mantiene il contesto di git add dopo continuazioni consecutive', () => {
    const source = [
      'name: continued-add-twice',
      'on: [workflow_dispatch]',
      'jobs:',
      '  persist:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: commit',
      '        run: |',
      '          git add \\',
      '            \\',
      '            "data/result.json" && git commit -m result',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/continued-add-twice.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.data-write-without-check')).toHaveLength(1);
  });

  it('mantiene il contesto di redirezione dopo una line-continuation', () => {
    const source = [
      'name: continued-redirect',
      'on: [workflow_dispatch]',
      'jobs:',
      '  persist:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: write',
      '        run: |',
      '          printf payload > \\',
      '            "data/result.json"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/continued-redirect.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.data-write-without-check')).toHaveLength(1);
  });

  it('rileva una redirezione dopo continuazioni consecutive', () => {
    const source = [
      'name: continued-redirect-twice',
      'on: [workflow_dispatch]',
      'jobs:',
      '  persist:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: write',
      '        run: |',
      '          printf payload > \\',
      '            \\',
      '            "data/result.json"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/continued-redirect-twice.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.data-write-without-check')).toHaveLength(1);
  });

  it('accetta queue:max come estensione supportata da GitHub Actions', () => {
    const source = [
      'name: queue-extension',
      'on: [push]',
      'concurrency:',
      '  group: jobs-data-pipeline',
      '  cancel-in-progress: false',
      '  queue: max',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo ok',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/queue-extension.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.concurrency-key')).toEqual([]);
    expect(findings.filter((item: any) => item.rule === 'workflow.concurrency-value')).toEqual([]);
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

  it('segue gli output letterali di uno script first-party invocato staticamente', () => {
    const files = new Map([
      ['/repo/scripts/check-health.mjs', [
        "import { appendFileSync } from 'node:fs';",
        'appendFileSync(process.env.GITHUB_OUTPUT, `summary<<EOF\\nhealthy\\nEOF\\n`);',
      ].join('\n')],
    ]);
    const source = [
      'name: delegated-output',
      'on: [push]',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: producer',
      '        id: health',
      '        run: node scripts/check-health.mjs',
      '      - name: consumer',
      '        run: echo "${{ steps.health.outputs.summary }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/delegated-output.yml', source, {
      root: '/repo',
      exists: (candidate: string) => files.has(candidate),
      readFile: (candidate: string) => files.get(candidate) || '',
    });
    expect(findings.filter((item: any) => item.rule === 'workflow.output-not-produced')).toEqual([]);
  });

  it('riconosce le chiavi letterali passate a un helper shell', () => {
    const files = new Map([
      ['/repo/scripts/wait-health.sh', [
        'emit_output() { printf \'%s=%s\\n\' "$1" "$2" >> "$GITHUB_OUTPUT"; }',
        'emit_output health_result ready',
      ].join('\n')],
    ]);
    const source = [
      'name: delegated-shell-output',
      'on: [push]',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: producer',
      '        id: health',
      '        run: bash scripts/wait-health.sh',
      '      - name: consumer',
      '        run: echo "${{ steps.health.outputs.health_result }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/delegated-shell-output.yml', source, {
      root: '/repo',
      exists: (candidate: string) => files.has(candidate),
      readFile: (candidate: string) => files.get(candidate) || '',
    });
    expect(findings.filter((item: any) => item.rule === 'workflow.output-not-produced')).toEqual([]);
  });

  it('riconosce tutte le chiavi in template concatenati', () => {
    const files = new Map([
      ['/repo/scripts/check-health.mjs', [
        "import { appendFileSync } from 'node:fs';",
        'appendFileSync(process.env.GITHUB_OUTPUT, `first=ok\\nsecond=ok` + `third=ok`);',
      ].join('\n')],
    ]);
    const source = [
      'name: delegated-output-concatenated',
      'on: [push]',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: producer',
      '        id: health',
      '        run: node scripts/check-health.mjs',
      '      - name: consumer',
      '        run: echo "${{ steps.health.outputs.third }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/delegated-output-concatenated.yml', source, {
      root: '/repo',
      exists: (candidate: string) => files.has(candidate),
      readFile: (candidate: string) => files.get(candidate) || '',
    });
    expect(findings.filter((item: any) => item.rule === 'workflow.output-not-produced')).toEqual([]);
  });

  it('riconosce le chiavi di una mappa passata a Object.entries', () => {
    const files = new Map([
      ['/repo/scripts/claim.mjs', [
        'import { appendFileSync } from \'node:fs\';',
        'const values = {',
        '  claim_allowed: true,',
        '  claim_token: result.token || \'\',',
        '};',
        'const lines = Object.entries(values).map(([name, value]) => `${name}=${value}`);',
        'appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join(\'\\n\')}\\n`);',
      ].join('\n')],
    ]);
    const source = [
      'name: delegated-output-object',
      'on: [push]',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: producer',
      '        id: claim',
      '        run: node scripts/claim.mjs',
      '      - name: consumer',
      '        run: echo "${{ steps.claim.outputs.claim_token }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/delegated-output-object.yml', source, {
      root: '/repo',
      exists: (candidate: string) => files.has(candidate),
      readFile: (candidate: string) => files.get(candidate) || '',
    });
    expect(findings.filter((item: any) => item.rule === 'workflow.output-not-produced')).toEqual([]);
  });

  it('non tratta decoy letterali o mappe non passati al sink come output', () => {
    const files = new Map([
      ['/repo/scripts/decoys.mjs', [
        "import { appendFileSync } from 'node:fs';",
        "const decoy = 'decoy=yes\\n';",
        'const values = {',
        '  decoy_map: true,',
        '};',
        'const labels = Object.entries(values).map(([name, value]) => `${name}=${value}`);',
        "appendFileSync(process.env.GITHUB_OUTPUT, 'real=yes\\n');",
      ].join('\n')],
    ]);
    const source = [
      'name: delegated-output-decoys',
      'on: [push]',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: producer',
      '        id: generated',
      '        run: node scripts/decoys.mjs',
      '      - name: consumer',
      '        run: echo "${{ steps.generated.outputs.decoy }} ${{ steps.generated.outputs.decoy_map }} ${{ steps.generated.outputs.real }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/delegated-output-decoys.yml', source, {
      root: '/repo',
      exists: (candidate: string) => files.has(candidate),
      readFile: (candidate: string) => files.get(candidate) || '',
    });
    const outputFindings = findings.filter((item: any) => item.rule === 'workflow.output-not-produced');
    expect(outputFindings).toHaveLength(2);
    expect(outputFindings.map((item: any) => item.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('decoy'),
      expect.stringContaining('decoy_map'),
    ]));
    expect(outputFindings.map((item: any) => item.message)).not.toEqual(expect.arrayContaining([
      expect.stringContaining('real'),
    ]));
  });

  it('riconosce gli output prodotti da un heredoc shell diretto verso GITHUB_OUTPUT', () => {
    const source = [
      'name: heredoc-output',
      'on: [push]',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: producer',
      '        id: generated',
      '        run: |',
      '          node --input-type=module - "$CTX_DIR/issue.json" >> "$GITHUB_OUTPUT" <<\'NODE\'',
      "          console.log('ready=true');",
      '          NODE',
      '      - name: consumer',
      '        run: echo "${{ steps.generated.outputs.ready }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/heredoc-output.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.output-not-produced')).toEqual([]);
  });

  it('riconosce anche l’ordine heredoc seguito dalla redirezione verso GITHUB_OUTPUT', () => {
    const source = [
      'name: heredoc-output-reversed',
      'on: [push]',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: producer',
      '        id: generated',
      '        run: |',
      '          node --input-type=module - <<\'NODE\' >> "$GITHUB_OUTPUT"',
      "          console.log('ready=true');",
      '          NODE',
      '      - name: consumer',
      '        run: echo "${{ steps.generated.outputs.ready }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/heredoc-output-reversed.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.output-not-produced')).toEqual([]);
  });

  it('riconosce gli output digest sempre emessi dal preflight shadow reale', () => {
    const file = '.github/workflows/translate-pending-logic.yml';
    const source = fs.readFileSync(path.resolve(file), 'utf8');
    const findings = auditWorkflowText(file, source, { root: process.cwd() });
    expect(findings.filter((item: any) => item.rule === 'workflow.output-not-produced')).toEqual([]);
  });

  it('segue un helper importato da uno script first-party', () => {
    const files = new Map([
      ['/repo/scripts/pull.mjs', [
        "import { emitSkip } from './lib/output.mjs';",
        'emitSkip();',
      ].join('\n')],
      ['/repo/scripts/lib/output.mjs', [
        "import { appendFileSync } from 'node:fs';",
        'export function emitSkip() {',
        "  appendFileSync(process.env.GITHUB_OUTPUT, 'nested=yes\\n');",
        '}',
      ].join('\n')],
    ]);
    const source = [
      'name: delegated-output-import',
      'on: [push]',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: producer',
      '        id: health',
      '        run: node scripts/pull.mjs',
      '      - name: consumer',
      '        run: echo "${{ steps.health.outputs.nested }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/delegated-output-import.yml', source, {
      root: '/repo',
      exists: (candidate: string) => files.has(candidate),
      readFile: (candidate: string) => files.get(candidate) || '',
    });
    expect(findings.filter((item: any) => item.rule === 'workflow.output-not-produced')).toEqual([]);
  });

  it('mantiene separati gli scope tra job e verifica gli output needs dichiarati', () => {
    const source = [
      'name: scoped',
      'on: [push]',
      'jobs:',
      '  producer:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: write',
      '        id: only_here',
      '        run: echo "value=yes" >> "$GITHUB_OUTPUT"',
      '  consumer:',
      '    runs-on: ubuntu-latest',
      '    needs: producer',
      '    steps:',
      '      - name: read',
      '        run: echo "${{ steps.only_here.outputs.value }} ${{ needs.producer.outputs.missing }}"',
      '  unrelated:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: read',
      '        run: echo "${{ needs.producer.result }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/scoped.yml', source, { root: '/repo' });
    expect(findings.map((item: any) => item.rule)).toEqual(expect.arrayContaining([
      'workflow.step-reference',
      'workflow.needs-reference',
      'workflow.needs-output-reference',
    ]));
  });

  it('risolve gli output dichiarati da un reusable workflow locale', () => {
    const source = [
      'name: reusable-consumer',
      'on: [push]',
      'jobs:',
      '  validate:',
      '    uses: ./.github/workflows/post-deploy-validate-dist.yml',
      '  publish:',
      '    runs-on: ubuntu-latest',
      '    needs: validate',
      '    steps:',
      '      - run: echo "${{ needs.validate.outputs.integrity_ok }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/reusable-consumer.yml', source, {
      root: '/repo',
      exists: (candidate: string) => candidate === '/repo/.github/workflows/post-deploy-validate-dist.yml',
      reusableWorkflowOutputs: new Map([
        ['.github/workflows/post-deploy-validate-dist.yml', new Set(['integrity_ok'])],
      ]),
    });
    expect(findings.filter((item: any) => item.rule === 'workflow.needs-output-reference')).toEqual([]);
  });

  it('declassa a warning uno script che vive nel checkout actions/checkout runtime', () => {
    const source = [
      'name: runtime-checkout',
      'on: [push]',
      'jobs:',
      '  compare:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      '          path: build',
      '      - name: run generated tool',
      '        working-directory: build',
      '        run: node scripts/generated.mjs',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/runtime-checkout.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.script-reference'))
      .toEqual([expect.objectContaining({ severity: 'warning' })]);
    expect(findings.find((item: any) => item.rule === 'workflow.script-reference')?.message)
      .toContain('actions/checkout (build)');
  });

  it('accetta un checkout runtime quando lo stesso step verifica prima il file', () => {
    const source = [
      'name: runtime-checkout-guarded',
      'on: [push]',
      'jobs:',
      '  compare:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      '          path: build',
      '      - name: run guarded tool',
      '        working-directory: build',
      '        run: |',
      '          test -f scripts/generated.mjs',
      '          node scripts/generated.mjs',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/runtime-checkout-guarded.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.script-reference')).toEqual([]);
  });

  it('non usa una verifica runtime posta dopo il comando come prova', () => {
    const source = [
      'name: runtime-checkout-after',
      'on: [push]',
      'jobs:',
      '  compare:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      '          path: build',
      '      - name: run unguarded tool',
      '        working-directory: build',
      '        run: |',
      '          node scripts/generated.mjs',
      '          test -f scripts/generated.mjs',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/runtime-checkout-after.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.script-reference'))
      .toEqual([expect.objectContaining({ severity: 'warning' })]);
  });

  it('ignora un percorso di script citato soltanto in un commento shell', () => {
    const source = [
      'name: commented-script',
      'on: [push]',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: documentation',
      '        run: |',
      '          # esempio: node scripts/does-not-run.mjs',
      '          echo ready',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/commented-script.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.script-reference')).toEqual([]);
  });

  it('non considera una ricetta quotata come assertion runtime', () => {
    const source = [
      'name: quoted-runtime-assertion',
      'on: [push]',
      'jobs:',
      '  compare:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      '          path: build',
      '      - name: run unguarded tool',
      '        working-directory: build',
      '        run: |',
      '          echo "test -f scripts/generated.mjs"',
      "          printf '%s\\n' 'test -f scripts/generated.mjs'",
      '          node scripts/generated.mjs',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/quoted-runtime-assertion.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.script-reference'))
      .toEqual([expect.objectContaining({ severity: 'warning' })]);
  });

  it('non accetta una assertion con fallback che assorbe il fallimento', () => {
    const source = [
      'name: swallowed-runtime-assertion',
      'on: [push]',
      'jobs:',
      '  compare:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      '          path: build',
      '      - name: run unguarded tool',
      '        working-directory: build',
      '        run: |',
      '          test -f scripts/generated.mjs || true',
      '          node scripts/generated.mjs',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/swallowed-runtime-assertion.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.script-reference'))
      .toEqual([expect.objectContaining({ severity: 'warning' })]);
  });

  it('lega una assertion condizionale solo al ramo then', () => {
    const source = [
      'name: conditional-runtime-assertion',
      'on: [push]',
      'jobs:',
      '  compare:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      '          path: build',
      '      - name: run guarded tool',
      '        working-directory: build',
      '        run: |',
      '          if test -f "scripts/generated.mjs"; then',
      '            node scripts/generated.mjs',
      '          else',
      '            echo missing',
      '          fi',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/conditional-runtime-assertion.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.script-reference')).toEqual([]);
  });

  it('non estende una assertion condizionale al ramo else', () => {
    const source = [
      'name: conditional-runtime-assertion-else',
      'on: [push]',
      'jobs:',
      '  compare:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      '          path: build',
      '      - name: run unguarded tool',
      '        working-directory: build',
      '        run: |',
      '          if test -f scripts/generated.mjs; then',
      '            node scripts/generated.mjs',
      '          else',
      '            node scripts/generated.mjs',
      '          fi',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/conditional-runtime-assertion-else.yml', source, { root: '/repo' });
    expect(findings.filter((item: any) => item.rule === 'workflow.script-reference'))
      .toEqual([expect.objectContaining({ severity: 'warning' })]);
  });

  it('non usa un file omonimo nella root per mascherare working-directory errato', () => {
    const source = [
      'name: cwd',
      'on: [push]',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: run',
      '        working-directory: subdir',
      '        run: node scripts/tool.mjs',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/cwd.yml', source, {
      root: '/repo',
      exists: (candidate: string) => candidate === '/repo/scripts/tool.mjs',
    });
    expect(findings.find((item: any) => item.rule === 'workflow.script-reference')?.severity).toBe('error');
  });

  it('risolve le local action dalla root anche quando lo step dichiara working-directory', () => {
    const source = [
      'name: action-root',
      'on: [push]',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: action',
      '        uses: ./.github/actions/local-check',
      '        working-directory: subdir',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/action-root.yml', source, {
      root: '/repo',
      exists: (candidate: string) => candidate === '/repo/.github/actions/local-check/action.yml',
    });
    expect(findings.map((item: any) => item.rule)).not.toContain('workflow.local-action');
  });

  it('scansiona l’inventario reale e non può passare con uno scan vuoto', () => {
    const report = auditWorkflowFiles(process.cwd());
    expect(report.filesScanned).toBeGreaterThanOrEqual(200);
    expect(report.workflowFiles).toHaveLength(report.filesScanned);
    expect(report.workflowNames.length).toBeGreaterThanOrEqual(200);
    expect(report.findings.every((item: any) => item.file.endsWith('.yml') || item.file.endsWith('.yaml'))).toBe(true);
  }, 30_000);

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
