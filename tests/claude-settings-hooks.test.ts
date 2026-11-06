/**
 * Claude Code può applicare `.claude/settings.json` del sito a una sessione
 * nata nella root del workspace: `CLAUDE_PROJECT_DIR` resta la root, dove gli
 * script non esistono. Ogni comando deve funzionare in quel contesto invece di
 * fallire con MODULE_NOT_FOUND e lasciare il gate spento.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type HookEntry = { hooks: { command: string }[] };
const settings = JSON.parse(readFileSync('.claude/settings.json', 'utf8')) as {
  hooks: Record<string, HookEntry[]>;
};
const commands = Object.values(settings.hooks)
  .flat()
  .flatMap((entry) => entry.hooks.map((hook) => hook.command));
const scriptOf = (command: string) => command.match(/scripts\/[\w/.-]+\.(?:mjs|sh)/)?.[0] ?? '';

const dirs: string[] = [];
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-hooks-'));
  dirs.push(dir);
  return dir;
}
function write(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}
function run(command: string, dir: string, marker: string) {
  execFileSync('sh', ['-c', command], {
    input: '{}',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, MARKER: marker },
  });
}
function waitForMarker(marker: string): string {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const value = readFileSync(marker, 'utf8');
      if (value) return value;
    } catch {
      // Il comando di prune gira in background: il marker può non esistere ancora.
    }
    execFileSync('sleep', ['0.05']);
  }
  return '';
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('.claude/settings.json hooks', () => {
  it('covers every command that depends on CLAUDE_PROJECT_DIR', () => {
    expect(commands.length).toBeGreaterThanOrEqual(7);
    for (const command of commands) expect(scriptOf(command), command).not.toBe('');
  });

  it.each(commands)('runs the checkout script when it exists: %s', (command) => {
    const dir = project();
    const marker = join(dir, 'marker');
    const script = scriptOf(command);
    write(
      join(dir, script),
      script.endsWith('.sh')
        ? 'printf local > "$MARKER"\n'
        : `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.MARKER, 'local');\n`,
    );
    run(command, dir, marker);
    expect(waitForMarker(marker)).toBe('local');
  });

  it.each(commands.filter((command) => command.includes('site-hook')))(
    'delegates to bin/site-hook from the workspace root: %s',
    (command) => {
      const dir = project();
      const marker = join(dir, 'marker');
      write(join(dir, 'bin/site-hook'), 'printf "%s" "$*" > "$MARKER"\n');
      run(command, dir, marker);
      expect(waitForMarker(marker).startsWith(scriptOf(command))).toBe(true);
    },
  );

  it.each(commands)('stays fail-open when neither path exists: %s', (command) => {
    const dir = project();
    expect(() => run(command, dir, join(dir, 'marker'))).not.toThrow();
  });
});
