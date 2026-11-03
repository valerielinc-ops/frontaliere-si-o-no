import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLargeJsonArray, readJsonFile } from '../scripts/lib/read-large-json.mjs';

describe('large JSON reader', () => {
  it('parses nested records when chunks split strings and objects', () => {
    const chunks = [
      '[{"id":1,"title":"caf',
      'é ","nested":{"ok":true}},',
      '{"id":2,"items":[1,{"value":"x"}]}]',
    ];

    expect(parseLargeJsonArray(chunks)).toEqual([
      { id: 1, title: 'café ', nested: { ok: true } },
      { id: 2, items: [1, { value: 'x' }] },
    ]);
  });

  it('switches to item-wise parsing before the inline threshold', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-large-json-'));
    const target = path.join(dir, 'jobs.json');
    const rows = [{ id: 1, title: 'café', description: 'a'.repeat(64) }, { id: 2, description: 'b'.repeat(64) }];

    try {
      fs.writeFileSync(target, JSON.stringify(rows), 'utf8');
      expect(readJsonFile(target, { maxInlineBytes: 1 })).toEqual(rows);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a large root object instead of silently returning partial data', () => {
    expect(() => parseLargeJsonArray(['{"jobs":[]}'])).toThrow(/top-level array/);
  });

  it.each(['[,{}]', '[{},]', '[{},,{}]', '[{}{}]'])('rejects invalid separators: %s', (input) => {
    expect(() => parseLargeJsonArray([input])).toThrow();
  });
});
