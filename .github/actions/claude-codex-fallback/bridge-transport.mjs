// Linux's restricted Codex profile blocks connect(2), including AF_UNIX.
// File IPC keeps the existing request validators and child lifecycle intact.
// No credential is written to this mailbox; only argv and bounded results.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const REQUEST_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const POLL_MS = 25;
const requestName = /^[0-9a-f-]{36}\.request$/;

function pinDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  // Pin the inode on Linux: replacing a mailbox pathname cannot redirect host IO.
  const root = process.platform === 'linux' ? `/proc/self/fd/${fd}` : directory;
  return { root, close: () => fs.closeSync(fd) };
}

function readBounded(file, limit) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('Invalid bridge message file');
    const buffer = Buffer.alloc(limit + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > limit) throw new Error('Bridge message exceeds its limit');
    return buffer.subarray(0, count).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function publish(file, data, limit) {
  if (Buffer.byteLength(data) > limit) throw new Error('Bridge message exceeds its limit');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
    // Rename publishes a complete message; it never follows a destination symlink.
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

class Connection extends EventEmitter {
  destroyed = false;
  timer;
  setEncoding() { return this; }
  setTimeout(ms, callback) {
    clearTimeout(this.timer);
    this.timer = setTimeout(callback, ms);
    return this;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.timer);
    this.emit('close');
  }
}

export function createConnection(endpoint) {
  if (process.env.CODEX_BRIDGE_TRANSPORT !== 'files') return net.createConnection(endpoint);
  const client = new Connection();
  let directory;
  let poll;
  const id = randomUUID();
  client.on('close', () => {
    clearInterval(poll);
    if (!directory) return;
    for (const suffix of ['request', 'response']) fs.rmSync(path.join(directory.root, `${id}.${suffix}`), { force: true });
    directory.close();
  });
  client.end = (request) => {
    try {
      directory = pinDirectory(endpoint);
      publish(path.join(directory.root, `${id}.request`), request, REQUEST_LIMIT);
      poll = setInterval(() => {
        try {
          const result = readBounded(path.join(directory.root, `${id}.response`), RESPONSE_LIMIT);
          client.emit('data', result);
          // Existing CLI clients exit from end; clean mailbox first.
          client.destroy();
          client.emit('end');
        } catch (error) {
          if (error.code !== 'ENOENT') { client.emit('error', error); client.destroy(); }
        }
      }, POLL_MS);
    } catch (error) { queueMicrotask(() => { client.emit('error', error); client.destroy(); }); }
  };
  return client;
}

export function createServer(options, handler) {
  if (process.env.CODEX_BRIDGE_TRANSPORT !== 'files') return net.createServer(options, handler);
  const pending = new Map();
  let directory;
  let poll;
  const server = {
    listening: false,
    listen(endpoint) {
      fs.mkdirSync(endpoint, { mode: 0o700 });
      directory = pinDirectory(endpoint);
      server.listening = true;
      poll = setInterval(() => {
        const names = new Set(fs.readdirSync(directory.root).filter(name => requestName.test(name)));
        for (const [name, client] of pending) {
          if (!names.has(name)) { client.destroy(); pending.delete(name); }
        }
        let admitted = 0;
        for (const name of names) {
          if (pending.has(name)) continue;
          if (++admitted > 64 || pending.size >= 1024) break;
          const client = new Connection();
          pending.set(name, client);
          client.end = (result) => {
            try { publish(path.join(directory.root, name.replace(/\.request$/, '.response')), result, RESPONSE_LIMIT); }
            catch { /* Requester can remove its mailbox; never escape it to reply. */ }
            client.destroy();
          };
          try {
            const request = readBounded(path.join(directory.root, name), REQUEST_LIMIT);
            handler(client);
            if (!client.destroyed) { client.emit('data', request); client.emit('end'); }
          } catch { client.destroy(); }
        }
      }, POLL_MS);
      return server;
    },
    close(callback) {
      clearInterval(poll);
      for (const client of pending.values()) client.destroy();
      pending.clear();
      directory?.close();
      server.listening = false;
      callback?.();
    },
  };
  return server;
}
