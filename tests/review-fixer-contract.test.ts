import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { importantFindings, partitionHistoricalImportantFindings } from '../scripts/ci/review-gate.mjs';
import { extractSectionByHeading } from '../scripts/ci/redflag-doc-sections.mjs';

// Il contratto fra la review e il 🔴-fixer (2026-09-25). Misurato su 46 PR bot
// (15-25/09): dopo un commit il 44% dei 🔴 si ripeteva e il 28% ne generava di
// nuovi; il fixer non aveva un canale per contestare (#9147: «già risolto alla
// riga 282», poi quattro review identiche). Questi test eseguono i pezzi veri:
// lo snippet di `tests.yml`, gli step di `pr-redflag-fixer.yml`, il gate.

const ROOT = path.resolve(__dirname, '..');
const REVIEW_MD = readFileSync(path.join(ROOT, 'REVIEW.md'), 'utf8');
const TESTS = YAML.parse(readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8')) as any;
const REDFLAG = YAML.parse(readFileSync(path.join(ROOT, '.github/workflows/pr-redflag-fixer.yml'), 'utf8')) as any;

function stepRun(workflow: any, job: string, name: string): string {
  const step = workflow.jobs[job].steps.find((s: any) => s.name === name);
  if (!step?.run) throw new Error(`step ${job}/${name} not found`);
  return step.run;
}

const ANCHOR = 'scripts/ci/export-l8-affiliate-outcomes.mjs:L288';
const reviewWith = (id: number, at: string, body: string) => ({
  id,
  user: { login: 'frontaliere-automation[bot]', type: 'Bot' },
  state: 'COMMENTED',
  commit_id: `c${id}`,
  submitted_at: at,
  body: `<!-- CODEX_FALLBACK_REVIEW -->\n## Scope\nL8 (tier: high)\n\n${body}`,
});
const FINDING_REVIEW = reviewWith(1, '2026-09-24T20:10:35Z', [
  '## Findings (Important: 1, Nit: 0)',
  `${ANCHOR}: 🔴 Important: [regression] The unavailable branch parses \`commercialPath\` again. Keep the fallback independent of the optional file. Accettazione: \`node --test tests/l8.test.mjs\` passa con un JSON commerciale malformato.`,
].join('\n'));

function writeFakeGh(dir: string, script: string) {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const gh = path.join(bin, 'gh');
  writeFileSync(gh, `#!/bin/bash\nset -u\n${script}\n`);
  chmodSync(gh, 0o755);
  return gh;
}

describe('REVIEW.md e prompt: ogni 🔴 è chiudibile e la re-review risponde al fixer', () => {
  const convergence = extractSectionByHeading(REVIEW_MD, '## Re-review convergence');

  it('il formato del finding porta un criterio di accettazione, e il prompt lo esige con un solo rimedio', () => {
    expect(extractSectionByHeading(REVIEW_MD, '## Output format')).toContain('Accettazione: <test|comando|input→output>.');
    const review = TESTS.jobs.vitest.steps.find((s: any) => s.name === 'Run Codex Luna Max review');
    const prompt = String(review.with.prompt);
    expect(prompt).toContain('End it with `Accettazione: <check>`');
    expect(prompt).toContain('One remedy only');
    expect(prompt).toContain('first judge every answered finding');
  });

  it('la re-review giudica fixed/disputed prima dei 🔴 nuovi e non ripete un 🔴 senza Replica', () => {
    for (const token of ['## Risposta del 🔴-fixer', 'prima dei 🔴 nuovi', 'anche a codice invariato', '`fixed`', '`disputed`', '(ritirato: <motivo>)', 'Replica: <cosa manca>', 'mai identico']) {
      expect(convergence).toContain(token);
    }
  });
});

describe('il gate: Accettazione e Replica non sono ancore da confermare', () => {
  it('il file di test nominato nell\'Accettazione non diventa una citazione del finding', () => {
    const [finding] = importantFindings(FINDING_REVIEW.body);
    expect(finding.citations.map((c: { path: string; line: number | null }) => `${c.path}:${c.line}`))
      .toEqual(['scripts/ci/export-l8-affiliate-outcomes.mjs:288']);
  });

  it('una Replica inline sulla riga del finding non aggiunge un\'ancora (review 5314694290 su #9810)', () => {
    const body = [
      '## Findings (Important: 1, Nit: 0)',
      'scripts/ci/original.mjs:L10: 🔴 Important: [correctness] Il guard salta il caso vuoto. Aggiungi il ramo. Replica: il fix in `scripts/ci/other/file.mjs:L20` non copre il caso vuoto. Accettazione: `node --test tests/original.test.mjs` passa con input vuoto.',
    ].join('\n');
    const [finding] = importantFindings(body);
    expect(finding.citations.map((c: { path: string; line: number | null }) => `${c.path}:${c.line}`))
      .toEqual(['scripts/ci/original.mjs:10']);
  });

  it('una riga Replica che cita un path non aggiunge un\'ancora', () => {
    const body = `${FINDING_REVIEW.body}\nReplica: il try/catch in \`scripts/ci/lib/other.mjs:L12\` copre la lettura, non il parse.`;
    const [finding] = importantFindings(body);
    expect(finding.citations).toHaveLength(1);
  });
});

describe('il gate chiude un 🔴 ritirato con la conferma che già conosce', () => {
  it('`Fix di …: ok (ritirato: …)` sposta il finding fra i confermati', () => {
    expect(partitionHistoricalImportantFindings([FINDING_REVIEW], { includeLatest: true }).open).toHaveLength(1);
    const withdrawal = reviewWith(2, '2026-09-24T21:20:29Z', [
      `Fix di \`${ANCHOR}\`: ok (ritirato: il fallback legge il file con try/catch alla riga 301).`,
      '',
      '## Findings (Important: 0, Nit: 0)',
      'Nessuno.',
      '',
      '## LGTM',
    ].join('\n'));
    const { open, confirmed } = partitionHistoricalImportantFindings([FINDING_REVIEW, withdrawal], { includeLatest: true });
    expect(open).toHaveLength(0);
    expect(confirmed).toHaveLength(1);
  });

  it('un 🔴 riportato con Replica resta aperto', () => {
    const replica = reviewWith(2, '2026-09-24T21:20:29Z', [
      '## Findings (Important: 1, Nit: 0)',
      `${ANCHOR}: 🔴 Important: [regression] The unavailable branch parses \`commercialPath\` again. Keep the fallback independent of the optional file. Accettazione: \`node --test tests/l8.test.mjs\` passa con un JSON commerciale malformato.`,
      'Replica: il try/catch alla riga 301 copre la lettura, non il parse della riga 288.',
    ].join('\n'));
    expect(partitionHistoricalImportantFindings([FINDING_REVIEW, replica], { includeLatest: true }).open).toHaveLength(1);
  });
});

describe('tests.yml: il bundle del reviewer contiene la risposta del fixer all\'ultima review', () => {
  const prefetch = stepRun(TESTS, 'vitest', 'Prefetch review context (zero-Claude, saves turns)');
  const snippet = prefetch.slice(prefetch.indexOf('# >>> fixer-response'), prefetch.indexOf('# <<< fixer-response'));

  function runSnippet(comments: unknown[], reviews: unknown[][]) {
    const dir = mkdtempSync(path.join(tmpdir(), 'fixer-response-'));
    const ctx = path.join(dir, 'ctx');
    mkdirSync(ctx);
    writeFileSync(path.join(ctx, 'reviews.json'), JSON.stringify(reviews));
    writeFileSync(path.join(dir, 'comments.json'), JSON.stringify(comments));
    // La CLI vera applica `--jq` alla risposta: qui lo fa jq con lo stesso filtro.
    const gh = writeFakeGh(dir, `filter=""; prev=""; for a in "$@"; do [ "$prev" = --jq ] && filter="$a"; prev="$a"; done
jq -r "$filter" < "${path.join(dir, 'comments.json')}"`);
    const result = spawnSync('bash', ['-c', `set -uo pipefail\n${snippet}`], {
      encoding: 'utf8',
      env: { ...process.env, TRUSTED_GH_BIN: gh, REPO: 'o/r', PR_NUMBER: '9753', CTX_DIR: ctx },
    });
    const out = readFileSync(path.join(ctx, 'fixer-response.md'), 'utf8');
    rmSync(dir, { recursive: true, force: true });
    return { result, out };
  }

  const bot = { login: 'github-actions[bot]', type: 'Bot' };
  const response = (at: string, text: string, user = bot) => ({ created_at: at, user, body: `<!-- REDFLAG_RESPONSE round=1 review=1 head=abc -->\n## Risposta del 🔴-fixer (round 1)\n\n${text}` });

  it('include la risposta successiva all\'ultima review bot e ignora le altre', () => {
    const { result, out } = runSnippet([
      response('2026-09-24T19:00:00Z', 'OLD'),
      response('2026-09-24T20:30:00Z', `- \`${ANCHOR}\` — disputed: try/catch alla riga 301.`),
      response('2026-09-24T20:40:00Z', 'FORGED', { login: 'someone', type: 'User' }),
      { created_at: '2026-09-24T20:50:00Z', user: bot, body: 'altro commento' },
    ], [[FINDING_REVIEW]]);
    expect(result.status, result.stderr).toBe(0);
    expect(out).toContain('disputed: try/catch alla riga 301');
    expect(out).not.toContain('OLD');
    expect(out).not.toContain('FORGED');
  });

  it('non riporta una risposta già giudicata da una review successiva', () => {
    const later = reviewWith(2, '2026-09-24T21:00:00Z', '## Findings (Important: 0, Nit: 0)\nNessuno.\n\n## LGTM');
    const { out } = runSnippet([response('2026-09-24T20:30:00Z', 'GIUDICATA')], [[FINDING_REVIEW, later]]);
    expect(out.trim()).toBe('');
  });

  it('la review di un bot che non è il reviewer non nasconde la risposta', () => {
    const other = {
      ...reviewWith(3, '2026-09-24T20:45:00Z', 'altro bot'),
      user: { login: 'dependabot[bot]', type: 'Bot' },
    };
    const { out } = runSnippet([response('2026-09-24T20:30:00Z', 'ANCORA DA GIUDICARE')], [[FINDING_REVIEW, other]]);
    expect(out).toContain('ANCORA DA GIUDICARE');
  });

  it('il bundle mostra la sezione solo quando c\'è una risposta', () => {
    expect(prefetch).toMatch(/if \[ -s "\$CTX_DIR\/fixer-response\.md" \]; then\s+echo "## Risposta del 🔴-fixer"/);
  });
});

describe('pr-redflag-fixer: il fixer vede i 🔴 aperti del gate e risponde per finding', () => {
  it('lo scope calcola i 🔴 aperti con review-gate.mjs dal checkout fidato', () => {
    const run = stepRun(REDFLAG, 'scope', "Render the gate's open findings for the fixer (zero-Claude)");
    const dir = mkdtempSync(path.join(tmpdir(), 'open-findings-'));
    const pages = path.join(dir, 'pages.json');
    writeFileSync(pages, JSON.stringify([[FINDING_REVIEW]]));
    const gh = writeFakeGh(dir, `cat "${pages}"`);
    const output = path.join(dir, 'out');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', run], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, TRUSTED_GH_BIN: gh, REPO: 'o/r', PR_NUMBER: '9753', RUNNER_TEMP: dir, GITHUB_OUTPUT: output, GITHUB_RUN_ID: '7' },
    });
    const text = readFileSync(output, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    expect(result.status, result.stderr).toBe(0);
    expect(text).toMatch(/^text<<OPEN_FINDINGS_EOF_7$/m);
    expect(text).toMatch(/- `[0-9a-f]{12}` \(scripts\/ci\/export-l8-affiliate-outcomes\.mjs:L288\):/);
    expect(text).toContain('Accettazione:');
  });

  it('il job del fixer riceve l\'elenco e legge le review paginate', () => {
    expect(REDFLAG.jobs.scope.outputs.open_findings).toContain('steps.open_findings.outputs.text');
    const ctx = stepRun(REDFLAG, 'redflag-fix', 'Collect PR + review context (zero-Claude)');
    expect(ctx).toMatch(/pulls\/\$PR_NUMBER\/reviews" --paginate/);
    expect(ctx).toContain('🔴 aperti secondo il gate');
    const codex = REDFLAG.jobs['redflag-fix'].steps.find((s: any) => /^Run Codex Luna Max/.test(s.name));
    const prompt = String(codex.with.prompt);
    for (const token of ['redflag-response.md', '— fixed:', '— disputed:', '— not-fixable:', 'Accettazione', 'Re-review convergence']) {
      expect(prompt).toContain(token);
    }
    expect(prompt.length).toBeLessThan(21_000);
  });

  describe('pubblicazione della risposta', () => {
    const run = stepRun(REDFLAG, 'redflag-fix', 'Publish the per-finding response (zero-Claude)');

    function setup(response: string | null, { advance = false } = {}) {
      const dir = mkdtempSync(path.join(tmpdir(), 'redflag-response-'));
      const remote = path.join(dir, 'remote.git');
      const repo = path.join(dir, 'repo');
      const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
      execFileSync('git', ['init', '-q', '--bare', remote]);
      mkdirSync(repo);
      git(repo, 'init', '-q');
      git(repo, 'config', 'user.name', 'Valerie Linc');
      git(repo, 'config', 'user.email', 'valerielinc@gmail.com');
      writeFileSync(path.join(repo, 'a.txt'), 'a\n');
      git(repo, 'add', 'a.txt');
      git(repo, 'commit', '-q', '-m', 'base');
      git(repo, 'remote', 'add', 'origin', remote);
      git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/fix/issue-8402');
      const base = git(repo, 'rev-parse', 'HEAD');
      if (advance) {
        writeFileSync(path.join(repo, 'a.txt'), 'b\n');
        git(repo, 'commit', '-q', '-am', 'fix');
        git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/fix/issue-8402');
      }
      const temp = path.join(dir, 'tmp');
      mkdirSync(temp);
      if (response !== null) writeFileSync(path.join(temp, 'redflag-response.md'), response);
      const posted = path.join(dir, 'posted.md');
      const gh = writeFakeGh(dir, `prev=""; for a in "$@"; do [ "$prev" = --body-file ] && cp "$a" "${posted}"; prev="$a"; done`);
      const output = path.join(dir, 'out');
      writeFileSync(output, '');
      const result = spawnSync('bash', ['-c', run], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env, TRUSTED_GH_BIN: gh, REPO: 'o/r', PR_NUMBER: '9753', HEAD_REF: 'fix/issue-8402',
          BASE_SHA: base, FIX_ROUND: '1', REVIEW_ID: '5309672011', RUNNER_TEMP: temp, GITHUB_OUTPUT: output,
        },
      });
      const remoteLog = git(remote, 'log', '--format=%s%n%(trailers:key=Fixer,valueonly)', '-1', 'fix/issue-8402');
      const remoteCount = Number(git(remote, 'rev-list', '--count', 'fix/issue-8402'));
      let comment = '';
      try { comment = readFileSync(posted, 'utf8'); } catch { comment = ''; }
      const out = readFileSync(output, 'utf8');
      rmSync(dir, { recursive: true, force: true });
      return { result, comment, out, remoteLog, remoteCount };
    }

    it('una contestazione senza commit viene pubblicata e chiede una re-review', () => {
      const r = setup(`- \`${ANCHOR}\` — disputed: il try/catch alla riga 301 copre già la lettura.\n`);
      expect(r.result.status, r.result.stderr).toBe(0);
      expect(r.comment).toMatch(/^<!-- REDFLAG_RESPONSE round=1 review=5309672011 head=[0-9a-f]{12} -->/);
      expect(r.comment).toContain('disputed: il try/catch');
      expect(r.remoteCount).toBe(2);
      expect(r.remoteLog).toContain('chiedi al reviewer di giudicare le contestazioni (round 1)');
      expect(r.remoteLog).toContain('redflag-round-1');
      expect(r.out).toContain('advanced=yes');
    });

    it('un round che ha già pushato codice non aggiunge commit', () => {
      const r = setup(`- \`${ANCHOR}\` — fixed: fallback indipendente. Verifica: node --test → ok\n- \`b.mjs:L3\` — disputed: x`, { advance: true });
      expect(r.result.status, r.result.stderr).toBe(0);
      expect(r.comment).toContain('fixed: fallback indipendente');
      expect(r.remoteCount).toBe(2);
      expect(r.remoteLog).toBe('fix');
    });

    it('senza contestazioni e senza commit la risposta resta solo una spiegazione', () => {
      const r = setup(`- \`${ANCHOR}\` — not-fixable: serve una misura live dell'endpoint.\n`);
      expect(r.result.status, r.result.stderr).toBe(0);
      expect(r.comment).toContain('not-fixable');
      expect(r.remoteCount).toBe(1);
    });

    it('senza risposta non pubblica nulla', () => {
      const r = setup(null);
      expect(r.result.status, r.result.stderr).toBe(0);
      expect(r.comment).toBe('');
      expect(r.out).toContain('published=none');
      expect(r.remoteCount).toBe(1);
    });
  });
});
