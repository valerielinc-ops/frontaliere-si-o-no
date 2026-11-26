import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MAX_RESPONSE_BYTES = 1024 * 1024;

function validateDirectory(directory) {
  if (directory === undefined || directory === '') return '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(directory)) {
    throw new Error('Response artifact directory must be a plain basename.');
  }
  return directory;
}

function existingDirectory(root, directory) {
  const safeDirectory = validateDirectory(directory);
  const parent = safeDirectory ? path.join(root, safeDirectory) : root;
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Response artifact directory must be a real directory.');
  }
  return parent;
}

function destination(runnerTemp, filename, directory) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(filename || '')) {
    throw new Error('Response artifact must be a plain basename.');
  }
  return path.join(existingDirectory(fs.realpathSync(runnerTemp), directory), filename);
}

/** Called before the model starts; never allow an earlier response to be published. */
export function prepareResponseArtifact({ runnerTemp, filename, directory = '' }) {
  const target = destination(runnerTemp, filename, directory);
  try {
    fs.unlinkSync(target); // Unlinks a stale symlink itself, never its target or a directory.
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/** Export only the caller-declared regular file, before the ephemeral home is removed. */
export function exportResponseArtifact({ runnerTemp, scratchRoot, filename, directory = '' }) {
  const target = destination(runnerTemp, filename, directory);
  const scratch = fs.lstatSync(scratchRoot);
  if (!scratch.isDirectory() || scratch.isSymbolicLink()) throw new Error('Invalid response scratch directory.');
  const sourceDirectory = existingDirectory(scratchRoot, directory);
  let source;
  try {
    source = fs.openSync(path.join(sourceDirectory, filename), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', bytes: 0 };
    throw error;
  }
  let temporary;
  try {
    const stat = fs.fstatSync(source);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Response artifact must be a single-link regular file.');
    if (stat.size > MAX_RESPONSE_BYTES) throw new Error('Response artifact exceeds the size limit.');
    const buffer = Buffer.alloc(MAX_RESPONSE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(source, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_RESPONSE_BYTES) throw new Error('Response artifact exceeds the size limit.');
    temporary = path.join(path.dirname(target), `.codex-response-${randomUUID()}`);
    fs.writeFileSync(temporary, buffer.subarray(0, size), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target); // Atomic: the publisher never sees a partial response.
    temporary = undefined;
    return { status: 'exported', bytes: size };
  } finally {
    fs.closeSync(source);
    if (temporary) fs.rmSync(temporary, { force: true });
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, filename, runnerTemp, scratchRoot, directory = ''] = process.argv.slice(2);
  try {
    if (mode === 'prepare') prepareResponseArtifact({ runnerTemp, filename, directory });
    else if (mode === 'export') {
      const result = exportResponseArtifact({ runnerTemp, scratchRoot, filename, directory });
      console.log(`Codex response artifact: ${result.status} (${result.bytes} bytes).`);
    } else throw new Error('Unknown response artifact operation.');
  } catch (error) {
    // Do not print paths or model-authored file content from filesystem errors.
    console.error(`::error::Codex response artifact handoff failed (${error.code || 'invalid artifact'}).`);
    process.exitCode = 1;
  }
}
