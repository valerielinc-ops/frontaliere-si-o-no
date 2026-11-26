import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isCodexAgentWorktreePath } from '../scripts/lib/worktree-locations.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-locations-')));
const home = path.join(root, 'home');
const main = path.join(home, 'Projects', 'frontaliere', 'frontaliere-si-o-no');
fs.mkdirSync(main, { recursive: true });
const offload = path.join(root, 'volume', 'codex-wt');
fs.mkdirSync(path.join(offload, 'linked'), { recursive: true });
fs.symlinkSync(offload, path.join(home, '.codex-worktrees'));

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('isCodexAgentWorktreePath', () => {
  const check = (p: string) => isCodexAgentWorktreePath(p, main, { home });

  it('riconosce le posizioni reali dei due Mac (2026-11-24)', () => {
    expect(check(path.join(home, '.codex-worktrees', 'fix-19031-review-20261116'))).toBe(true);
    expect(check(path.join(home, 'Projects', 'frontaliere', 'frontaliere-si-o-no-worktree-codex-fix-corpus-memory-20261113'))).toBe(true);
    expect(check(path.join(home, 'Projects', 'frontaliere-si-o-no-worktree-assisted-app-fix'))).toBe(true);
  });

  it('segue `~/.codex-worktrees` anche quando è un symlink', () => {
    expect(check(path.join(offload, 'linked'))).toBe(true);
  });

  it('esclude il checkout principale, i sosia e le sorelle lontane', () => {
    expect(check(main)).toBe(false);
    expect(check(path.join(home, 'Projects', 'frontaliere', 'frontaliere-si-o-no-worktree-'))).toBe(false);
    expect(check(path.join(home, 'Projects', 'frontaliere', 'frontaliere-si-o-no-worktreeish'))).toBe(false);
    expect(check(path.join(home, 'Desktop', 'frontaliere-si-o-no-worktree-review'))).toBe(false);
    expect(check(path.join(root, 'volume', '.codex-worktrees', 'x'))).toBe(false);
    expect(check(path.join(home, '.codex', 'worktrees', 'app'))).toBe(false);
  });
});
