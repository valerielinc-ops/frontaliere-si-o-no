/** Manager-only proof for a surviving browser group whose original leader died. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectProcess } from './process-registry.mjs';

export const BROWSER_WITNESS_KEY = 'ASSISTED_APPLICATION_BROWSER_WITNESS';
// proc_pidpath is independent of argv[0]. Read process environment only AFTER
// the real image has been checked inside the approved browser bundle. Neither
// raw arguments nor environment leave this helper or enter diagnostic output.
const proof = String.raw`require 'fiddle/import'
require 'json'
module Native
  extend Fiddle::Importer
  dlload '/usr/lib/libSystem.B.dylib', '/usr/lib/libproc.dylib'
  extern 'int proc_pidpath(int, void*, unsigned int)'
  extern 'int sysctl(void*, unsigned int, void*, void*, void*, unsigned long)'
end
begin
  config = JSON.parse(STDIN.read(8193)); pid = Integer(ARGV.fetch(0))
  image = "\0" * 4096
  exit(2) unless Native.proc_pidpath(pid, image, image.bytesize) > 0
  real = File.realpath(image.split("\0", 2).first)
  bundle = File.realpath(config.fetch('bundle'))
  exit(2) unless real.start_with?(bundle + '/')
  mib = [1, 49, pid].pack('i!*'); length = [0].pack('J')
  exit(2) unless Native.sysctl(mib, 3, nil, length, nil, 0) == 0
  size = length.unpack1('J'); exit(2) unless size > 4 && size <= 1048576
  data = "\0" * size
  exit(2) unless Native.sysctl(mib, 3, data, length, nil, 0) == 0
  argc = data.unpack1('i!'); exit(2) unless argc >= 0 && argc <= 4096
  offset = 4; stop = data.index("\0", offset); exit(2) unless stop
  offset = stop + 1
  offset += 1 while data.getbyte(offset) == 0
  argc.times do
    stop = data.index("\0", offset); exit(2) unless stop
    offset = stop + 1
  end
  expected = config.fetch('key') + '=' + config.fetch('witness')
  values = data.byteslice(offset, length.unpack1('J') - offset).split("\0")
  STDOUT.write(values.count { |value| value == expected } == 1 ? '1' : '0')
rescue StandardError
  exit(2)
end`;

export function proveLeaderlessBrowserGroup(directory, pgid) {
  if (process.platform !== 'darwin') return false;
  const deadline = Date.now() + 5000;
  const remaining = maximum => Math.min(maximum, Math.max(1, deadline - Date.now()));
  const file = path.join(path.dirname(directory), 'browser-ownership.json');
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o777) !== 0o600 || stat.size > 8192) return false;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.version !== 1 || !/^[a-f0-9]{64}$/.test(record.witness || '')
    || typeof record.bundle !== 'string' || !record.bundle.endsWith('.app')) return false;
  const listed = execFileSync('/bin/ps', ['-g', String(pgid), '-o', 'pid=', '-o', 'pgid=', '-o', 'uid='],
    { encoding: 'utf8', timeout: 1000, maxBuffer: 32_768, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  const rows = listed.trim().split('\n');
  if (rows.length > 128) return false;
  for (const row of rows) {
    if (Date.now() >= deadline) return false;
    const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(row);
    if (!fields || Number(fields[2]) !== pgid || Number(fields[3]) !== process.getuid()) return false;
    const pid = Number(fields[1]); const before = inspectProcess(pid, { timeoutMs: remaining(1000) });
    if (!before || before.pgid !== pgid || before.uid !== process.getuid()) continue;
    let matches = false;
    try {
      matches = execFileSync('/usr/bin/ruby', ['--disable-gems', '-e', proof, String(pid)], {
        encoding: 'utf8', timeout: remaining(1500), maxBuffer: 16,
        input: JSON.stringify({ bundle: record.bundle, witness: record.witness, key: BROWSER_WITNESS_KEY }),
        env: { PATH: '/usr/bin:/bin', HOME: path.dirname(directory), LANG: 'C' }, stdio: ['pipe', 'pipe', 'ignore'],
      }) === '1';
    } catch { /* A missing or unreadable ownership witness is never authority. */ }
    if (Date.now() >= deadline) return false;
    const after = inspectProcess(pid, { timeoutMs: remaining(1000) });
    if (Date.now() < deadline && matches && after && after.started === before.started && after.pgid === pgid && after.uid === before.uid) return true;
  }
  return false;
}
