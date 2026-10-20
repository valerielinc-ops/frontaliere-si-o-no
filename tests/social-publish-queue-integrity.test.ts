import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { enqueuePost, loadQueue, parseQueue } from '../scripts/lib/social-publish-queue.mjs';
import { gitMainReader } from '../scripts/social-robot/lib/robot.mjs';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempQueue(contents?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'social-queue-integrity-'));
  tempRoots.push(root);
  const file = path.join(root, 'instagram-queue.json');
  if (contents !== undefined) fs.writeFileSync(file, contents, 'utf8');
  return file;
}

describe('social publish queue integrity', () => {
  it('uses an empty queue only when the queue file is absent', () => {
    expect(loadQueue(tempQueue())).toEqual({ schemaVersion: 1, pending: [] });
    expect(parseQueue(null)).toEqual({ schemaVersion: 1, pending: [] });
  });

  it.each([
    ['malformed JSON', '{ not json'],
    ['wrong root shape', '{"schemaVersion":1,"pending":{}}'],
    ['unsupported schema', '{"schemaVersion":2,"pending":[]}'],
    ['entry without id', '{"schemaVersion":1,"pending":[{"kind":"article"}]}'],
  ])('rejects %s without erasing pending posts', (_label, contents) => {
    const file = tempQueue(contents);
    const newEntry = { id: 'job-2026-10-20', kind: 'job' };
    expect(() => loadQueue(file)).toThrow(/social publish queue/i);
    expect(() => enqueuePost(file, newEntry)).toThrow(/social publish queue/i);
    expect(fs.readFileSync(file, 'utf8')).toBe(contents);
  });

  it('keeps every queued entry when the committed queue is valid', () => {
    const pending = [{ id: 'article-2026-10-19' }, { id: 'job-2026-10-19' }];
    expect(parseQueue(JSON.stringify({ schemaVersion: 1, pending }))).toEqual({ schemaVersion: 1, pending });
  });

  it('fails closed when origin/main does not expose the required queue', () => {
    const reader = gitMainReader({
      repoDir: '/repo',
      exec: (_command: string, args: string[]) => {
        if (args.includes('fetch')) return '';
        throw new Error(`missing ${args[args.length - 1]}`);
      },
      log: { warn: () => {} },
    });
    expect(() => reader.readQueue('instagram')).toThrow(/required queue from origin\/main/i);
  });

  it('fails closed when the tracked queue is malformed', () => {
    const reader = gitMainReader({
      repoDir: '/repo',
      exec: (_command: string, args: string[]) => args.includes('fetch') ? '' : '{ not json',
      log: { warn: () => {} },
    });
    expect(() => reader.readQueue('instagram')).toThrow(/social publish queue/i);
  });
});
