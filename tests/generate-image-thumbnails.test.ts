// The thumbnail generator runs in the deploy's `prep` job. One unreadable image
// used to reject the whole run on its first error with a message that did not
// name the file (run 37035643275: «Input file contains unsupported image
// format»): no build for the whole site, and nothing to say which file to fix.
//
// These tests run the REAL script against a temporary directory. They never
// touch the tracked public/images tree.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'generate-image-thumbnails.mjs');

async function validImage(format: 'webp' | 'png'): Promise<Buffer> {
  const image = sharp({
    create: { width: 640, height: 360, channels: 3, background: { r: 200, g: 30, b: 30 } },
  });
  return format === 'webp' ? image.webp().toBuffer() : image.png().toBuffer();
}

/** What the incident shipped: a real WebP after a UTF-8 text round trip. */
function textRoundTrip(bytes: Buffer): Buffer {
  return Buffer.from(bytes.toString('utf8'), 'utf8');
}

function run(dir: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT, '--source-dir', dir], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '', ...env },
  });
}

describe('generate-image-thumbnails', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-'));
    tmpDirs.push(dir);
    return dir;
  }

  const thumb = (dir: string, stem: string) => path.join(dir, 'thumbnails', `${stem}-480w.webp`);

  it('encodes every readable image, exits 1 and names each unreadable one', async () => {
    const dir = makeDir();
    const webp = await validImage('webp');
    // The broken files sort before and between the valid ones: a generator that
    // stops at the first error never reaches `m-valid` or `z-valid`.
    fs.writeFileSync(path.join(dir, 'a-broken.webp'), textRoundTrip(webp));
    fs.writeFileSync(path.join(dir, 'm-valid.webp'), webp);
    fs.writeFileSync(path.join(dir, 'p-broken.png'), Buffer.from('<html>not an image</html>'));
    fs.writeFileSync(path.join(dir, 'z-valid.png'), await validImage('png'));

    const result = run(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path.join(dir, 'a-broken.webp'));
    expect(result.stderr).toContain(path.join(dir, 'p-broken.png'));
    expect(result.stderr).not.toContain(path.join(dir, 'm-valid.webp'));
    expect(result.stderr).not.toContain(path.join(dir, 'z-valid.png'));
    for (const stem of ['m-valid', 'z-valid']) {
      const meta = await sharp(thumb(dir, stem)).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(480);
    }
    // No thumbnail may survive for a broken source: the committed-thumbnail
    // fast path would trust it and the next run would go green.
    expect(fs.existsSync(thumb(dir, 'a-broken'))).toBe(false);
    expect(fs.existsSync(thumb(dir, 'p-broken'))).toBe(false);

    // Still red on the next run: the failure is not recorded as done.
    const again = run(dir);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain(path.join(dir, 'a-broken.webp'));
  });

  it('emits one GitHub annotation per unreadable file in CI', async () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'broken.webp'), textRoundTrip(await validImage('webp')));

    const result = run(dir, { GITHUB_ACTIONS: 'true' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`::error file=${path.join(dir, 'broken.webp')},`);
  });

  it('exits 0 when every image is readable', async () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'only.webp'), await validImage('webp'));

    const result = run(dir);

    expect(result.status).toBe(0);
    expect(fs.existsSync(thumb(dir, 'only'))).toBe(true);
  });
});
