import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// F8 (2026-11-14): i workflow di contorno non devono consumare runner ne'
// GITHUB_TOKEN per eventi che non possono produrre lavoro utile (run `tests`
// cancellate, push su main, HEAD gia' superate).
const wf = (name: string) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');

describe('stale-pr-rescuer: completion cancellate o superate', () => {
  const text = wf('stale-pr-rescuer.yml');

  it('non parte per una run tests cancellata ne\' per un push su main', () => {
    expect(text).toContain("github.event.workflow_run.event != 'push' && github.event.workflow_run.conclusion != 'cancelled'");
  });

  it('legge una volta la PR e salta lo scan se la HEAD dell\'evento e\' superata', () => {
    expect(text).toContain('id: fresh');
    expect(text).toContain('[.state, .head.sha] | @tsv');
    expect(text).toContain('"$head" != "$RUN_HEAD_SHA"');
    // fail-open: una lettura fallita non spegne lo scan
    expect(text).toContain('lo scan procede (fail-open)');
    for (const step of [
      'Checkout App-token minter',
      'Setup Node.js',
      'Mint App token for non-recursive rescue labels',
      'Scan open PRs and flag stalled ones',
      'Orphan PR custodian',
    ]) {
      const at = text.indexOf(`- name: ${step}`);
      expect(at, step).toBeGreaterThan(-1);
      expect(text.slice(at, at + 200), step).toContain("steps.fresh.outputs.superseded != 'true'");
    }
  });

  it('mantiene cron e dispatch completi (la run cancellata mai rilanciata resta coperta)', () => {
    expect(text).toContain("cron: '20 * * * *'");
    expect(text).toContain('workflow_dispatch:');
  });
});

describe('retry-code-check-after-body-edit: solo completion di pull_request', () => {
  const text = wf('retry-code-check-after-body-edit.yml');

  it('filtra le completion non pull_request ma conserva le cancelled del recovery', () => {
    expect(text).toContain("github.event_name == 'workflow_run' && github.event.workflow_run.event == 'pull_request'");
    expect(text).toContain("github.event_name == 'schedule'");
    expect(text).toContain('github.event.changes.body != null');
    // il rerun dopo la cancellazione voluta dal recovery e' demandato all'evento cancelled
    expect(text).not.toMatch(/workflow_run\.conclusion\s*!=\s*'cancelled'/u);
    expect(text).toContain('cancelled workflow_run event performs the bounded');
  });

  it('scarta in script ogni completion su una HEAD superata, senza retry', () => {
    expect(text).toContain('pr.head.sha !== run.head_sha) continue;');
  });
});

describe('fixer: la HEAD si ricontrolla prima di npm ci e Remote Config', () => {
  it('redflag: l\'admission esce con actionable=false se la HEAD o lo stato PR sono cambiati', () => {
    const text = wf('pr-redflag-fixer.yml');
    const admission = text.indexOf('id: admission');
    const install = text.indexOf('- name: Install dependencies', admission);
    const recheck = text.indexOf('current_head="$(jq -r \'.head.sha // ""\' "$pr_file")"', admission);
    expect(recheck).toBeGreaterThan(admission);
    expect(recheck).toBeLessThan(install);
    expect(text).toContain('"$current_head" != "$HEAD_SHA"');
    expect(text.slice(recheck, recheck + 700)).toContain('echo "actionable=false" >> "$GITHUB_OUTPUT"');
  });

  it('redcheck: un recheck subito dopo il claim gatta setup, npm ci, Remote Config e guard', () => {
    const text = wf('pr-redcheck-fixer.yml');
    const claim = text.indexOf('id: claim');
    const early = text.indexOf('id: head_early');
    const install = text.indexOf('- name: Install dependencies');
    const rc = text.indexOf('- name: Load secrets from Remote Config (GITHUB_PAT)');
    const guard = text.indexOf('- name: Round cap + capability guard + tier');
    expect(claim).toBeLessThan(early);
    expect(early).toBeLessThan(install);
    for (const at of [install, rc, guard]) {
      expect(text.slice(at, at + 400)).toContain("steps.head_early.outputs.stale != 'true'");
    }
    // un guard che non gira non produce `proceed`: ogni step a valle resta saltato
    // e il finalize rilascia il claim (proceed vuoto -> released).
    expect(text).toContain('"$head" != "$CLAIM_HEAD_SHA"');
    expect(text).toContain("if: always() && steps.claim.outputs.claim_acquired == 'true'");
  });
});
