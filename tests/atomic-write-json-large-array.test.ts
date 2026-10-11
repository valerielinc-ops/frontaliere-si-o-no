import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeJsonAtomic } from '../scripts/lib/atomic-write-json.mjs';

describe('writeJsonAtomic large arrays', () => {
  it('keeps the exact existing pretty format for small arrays too', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-small-array-'));
    const target = path.join(dir, 'jobs.json');
    const rows = [{ id: 1, nested: ['a', 'b'] }];

    try {
      writeJsonAtomic(target, rows);
      expect(fs.readFileSync(target, 'utf8')).toBe(`${JSON.stringify(rows, null, 2)}\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows an aggregate writer to opt small arrays into streaming', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-opt-in-array-'));
    const target = path.join(dir, 'expired-jobs.json');
    const rows = [{ id: 1 }, { id: 2 }];

    try {
      writeJsonAtomic(target, rows, { streamArray: true });
      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(rows);
      expect(fs.readFileSync(target, 'utf8')).toBe(`${JSON.stringify(rows, null, 2)}\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes compact arrays incrementally without changing their JSON value', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-large-array-'));
    const target = path.join(dir, 'jobs.json');
    const rows = Array.from({ length: 2_000 }, (_, index) => ({
      id: index,
      title: `Job ${index}`,
      description: 'A bounded item serialized independently from its siblings.',
    }));

    try {
      writeJsonAtomic(target, rows, { compact: true });

      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(rows);
      expect(fs.readFileSync(target, 'utf8')).toBe(`${JSON.stringify(rows)}\n`);
      expect(fs.readdirSync(dir).filter((file) => file.includes('.tmp'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the existing two-space pretty format for large arrays', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-large-array-pretty-'));
    const target = path.join(dir, 'jobs.json');
    const rows = Array.from({ length: 1_025 }, (_, index) => ({
      id: index,
      nested: { enabled: index % 2 === 0 },
    }));

    try {
      writeJsonAtomic(target, rows);

      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(rows);
      expect(fs.readFileSync(target, 'utf8')).toBe(`${JSON.stringify(rows, null, 2)}\n`);
      expect(fs.readdirSync(dir).filter((file) => file.includes('.tmp'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
