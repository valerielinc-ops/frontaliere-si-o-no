import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

const root = fs.realpathSync.native(path.resolve(process.env.SPARSE_READS_ROOT || process.cwd()));
const output = process.env.SPARSE_READS_OUTPUT;
const touched = new Set();

function asPath(value) {
  if (typeof value === 'string') return value;
  if (value instanceof URL && value.protocol === 'file:') return fileURLToPath(value);
  return null;
}

function record(value, directory = false) {
  const raw = asPath(value);
  if (raw === null) return;
  const absolute = path.resolve(root, raw);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
  const normalized = relative.split(path.sep).join('/');
  touched.add(directory ? `${normalized}/` : normalized);
}

function wrap(target, name, directory = false) {
  const original = target?.[name];
  if (typeof original !== 'function') return;
  target[name] = function wrappedFsRead(...args) {
    const result = original.apply(this, args);
    if (name !== 'existsSync' || result) record(args[0], directory);
    return result;
  };
}

for (const name of ['readFileSync', 'existsSync', 'statSync', 'lstatSync', 'openSync']) {
  wrap(fs, name);
}
wrap(fs, 'readdirSync', true);

for (const name of ['readFile', 'stat', 'lstat', 'open']) {
  const original = fs.promises[name];
  fs.promises[name] = async function wrappedFsPromiseRead(...args) {
    const result = await original.apply(this, args);
    record(args[0]);
    return result;
  };
}
{
  const original = fs.promises.readdir;
  fs.promises.readdir = async function wrappedFsPromiseDirectoryRead(...args) {
    const result = await original.apply(this, args);
    record(args[0], true);
    return result;
  };
}

syncBuiltinESMExports();

const writeLog = fs.writeFileSync.bind(fs);
process.on('exit', () => {
  if (!output) return;
  writeLog(output, `${JSON.stringify([...touched].sort())}\n`, 'utf8');
});
