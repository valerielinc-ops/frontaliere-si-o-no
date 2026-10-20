import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = readFileSync(resolve(ROOT, '.github/workflows/followup-drainer.yml'), 'utf8');
const STALE_RESCUER = readFileSync(resolve(ROOT, '.github/workflows/stale-pr-rescuer.yml'), 'utf8');
const RECYCLE = readFileSync(resolve(ROOT, '.github/workflows/recycle-stale-prs.yml'), 'utf8');
const PARSED = YAML.parse(WORKFLOW) as {
  concurrency?: unknown;
  jobs: { drain: { if?: string; concurrency?: unknown } };
};

describe('followup-drainer trigger durability', () => {
  it('usa cron durevole e wake-up reattivi bounded', () => {
    expect(WORKFLOW).toMatch(/schedule:\s*\n\s*- cron: ['"]\*\/20 \* \* \* \*['"]/);
    expect(WORKFLOW).toContain('workflow_dispatch:');
    expect(WORKFLOW).toMatch(/issues:\s*\n\s*types:\s*\[labeled\]/);
    expect(WORKFLOW).toMatch(/workflow_run:\s*\n\s*workflows:\s*\[['"]Issue fix \(Codex Luna Max → PR\)['"]\]\s*\n\s*types:\s*\[completed\]/);
    expect(WORKFLOW).toContain("github.event.label.name == 'agent:fix-queued'");
    expect(WORKFLOW).toContain("github.event.label.name == 'agent:decompose-queued'");
    expect(WORKFLOW).toContain('cancel-in-progress: false');
  });

  it('condivide il mutex daily a livello di job, non di run', () => {
    expect(WORKFLOW).not.toMatch(/group:\s*followup-drainer-\$\{\{\s*github\.repository\s*\}\}-\$\{\{\s*github\.event\.issue\.number/);
    expect(WORKFLOW).not.toMatch(/group:\s*followup-drainer-\$\{\{\s*github\.repository\s*\}\}/);
    // A livello di run ogni `issues: labeled` irrilevante entrava nel gruppo e
    // sostituiva la pending utile (708 cancellate / 173 riuscite in 31h).
    expect(PARSED.concurrency).toBeUndefined();
    expect(PARSED.jobs.drain.concurrency).toEqual({
      group: 'followup-daily-${{ github.repository }}',
      'cancel-in-progress': false,
    });
  });

  it('non si sveglia per un issue-fix skipped', () => {
    const condition = (PARSED.jobs.drain.if ?? '').replace(/\s+/gu, ' ');
    expect(condition).toContain("github.event_name != 'workflow_run' || github.event.workflow_run.conclusion != 'skipped'");
    // Le due clausole sono in AND: nessuna delle due può aprire il job da sola.
    expect(condition).toMatch(/\)\s*&&\s*\(/);
  });

  it('propaga al drainer il fallback Codex già usato da issue-fix', () => {
    const drain = WORKFLOW.slice(WORKFLOW.indexOf('- name: Drain follow-up queue'));
    expect(drain).toContain("FOLLOWUP_CODEX_FALLBACK_MODE: '1'");
  });

  it('riesamina stale-review e rende l azione idempotente per classe e head', () => {
    expect(STALE_RESCUER).not.toContain('già stale-review — skip');
    expect(STALE_RESCUER).toContain('stale-pr-rescuer class=$CLASS head=${HEAD:0:7}');
    expect(STALE_RESCUER).toContain('agent:autofix');
  });

  it('non tronca gli scan delle PR oltre il vecchio limite 50', () => {
    for (const source of [STALE_RESCUER, RECYCLE]) {
      // stale-pr-rescuer attesta un path assoluto prima del checkout; recycle
      // conserva il vecchio invocatore nel proprio perimetro. Entrambi devono
      // però usare la stessa query paginata, senza il limite silenzioso a 50.
      expect(source).toMatch(/(?:gh|"\$TRUSTED_GH_BIN") api --paginate "repos\/\$REPO\/pulls\?state=open&per_page=100"/);
      expect(source).not.toContain('gh pr list --repo "$REPO" --state open --limit 50');
    }
  });
});
