import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/offload-generated-images-cdn.mjs', import.meta.url));
const CDN_BASE = 'https://valerielinc-ops.github.io/frontaliere-cdn';
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runOffload(html: string, withData = false) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-template-scan-'));
  tmpDirs.push(tmp);
  const dist = path.join(tmp, 'dist');
  fs.mkdirSync(withData ? path.join(dist, 'data') : dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), html, 'utf8');
  if (withData) fs.writeFileSync(path.join(dist, 'data', 'payload.json'), '{}', 'utf8');
  execFileSync('node', [SCRIPT], {
    cwd: tmp,
    env: { ...process.env, CDN_BASE },
    stdio: 'pipe',
  });
  return { html: fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), dist };
}

describe('CDN template scanner (#13616 FU-010)', () => {
  it('skips nested templates and comment text before the real charset tag', () => {
    const html = '<!doctype html><html><head>'
      + '<template><!-- </template> --><template><meta charset="utf-8"></template></template>'
      + '<meta charset="utf-8"><title>real</title></head><body>x</body></html>';
    const result = runOffload(html).html;

    expect(result.match(/window\.__CDN_DATA_BASE__\s*=/g) ?? []).toHaveLength(1);
    expect(result.indexOf('<meta charset="utf-8"><title>real</title>'))
      .toBeLessThan(result.indexOf('window.__CDN_DATA_BASE__'));
  });

  it('fails closed when only the outer nested template close is missing', () => {
    const malformed = '<!doctype html><html><head><template>'
      + '<template><meta charset="utf-8"></template><title>unclosed</title>'
      + '</head><body>x</body></html>';
    const result = runOffload(malformed, true);

    expect(fs.readFileSync(path.join(result.dist, 'index.html'), 'utf8')).toBe(malformed);
    expect(fs.existsSync(path.join(result.dist, 'data', 'payload.json'))).toBe(true);
  });
});
