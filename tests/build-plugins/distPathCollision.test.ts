import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertDistFilePathAvailable,
  assertNoFileDirectoryPathCollisions,
  DistPathCollisionError,
  isMissingOrNotDirectoryError,
} from '../../build-plugins/shared/distPathCollision';
import { pdfWhitepapersPlugin } from '../../build-plugins/pdfWhitepapersPlugin';

describe('dist file/directory collision guard', () => {
  it('detects an emitted file used as the ancestor of an emitted index', () => {
    const filePath = path.join(os.tmpdir(), 'dist-collision-fixture', 'guide.pdf');
    const nestedIndexPath = path.join(filePath, 'index.html');

    expect(() => assertNoFileDirectoryPathCollisions([filePath, nestedIndexPath]))
      .toThrow(DistPathCollisionError);
    expect(() => assertNoFileDirectoryPathCollisions([filePath, filePath])).not.toThrow();
  });

  it('fails the PDF emitter before its per-guide recovery can hide a blocked landing path', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-output-collision-'));
    const blockedLandingPath = path.join(
      rootDir,
      'dist',
      'guides',
      'guida-completa-frontaliere-2026',
    );
    try {
      fs.mkdirSync(path.dirname(blockedLandingPath), { recursive: true });
      fs.writeFileSync(blockedLandingPath, 'not-a-directory', 'utf8');
      const closeBundle = pdfWhitepapersPlugin(rootDir).closeBundle as () => Promise<void>;
      await expect(closeBundle()).rejects.toBeInstanceOf(DistPathCollisionError);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('recognizes ENOENT and ENOTDIR as optional probe misses only', () => {
    expect(isMissingOrNotDirectoryError({ code: 'ENOENT' })).toBe(true);
    expect(isMissingOrNotDirectoryError({ code: 'ENOTDIR' })).toBe(true);
    expect(isMissingOrNotDirectoryError({ code: 'EACCES' })).toBe(false);
  });

  it('reports an existing file ancestor before a nested output is written', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-file-ancestor-'));
    const filePath = path.join(rootDir, 'guides', 'guide.pdf');
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '%PDF-fixture', 'utf8');
      expect(() => assertDistFilePathAvailable(path.join(filePath, 'index.html')))
        .toThrow(DistPathCollisionError);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
