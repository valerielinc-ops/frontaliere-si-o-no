/** Synthetic sibling only: no real manager environment is ever inspected. */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';

const execute = promisify(execFile);
const code = String.raw`require 'fiddle/import'
module Native
  extend Fiddle::Importer
  dlload '/usr/lib/libSystem.B.dylib'
  extern 'int sysctl(void*, unsigned int, void*, void*, void*, unsigned long)'
end
mib = [1, 49, Integer(ARGV.fetch(0))].pack('i!*'); length = [0].pack('J')
unless Native.sysctl(mib, 3, nil, length, nil, 0) == 0
  exit(2) unless [1, 13].include?(Fiddle.last_error)
  STDOUT.write('denied'); exit(0)
end
size = length.unpack1('J'); exit(2) unless size > 4 && size <= 1048576
data = "\0" * size
unless Native.sysctl(mib, 3, data, length, nil, 0) == 0
  exit(2) unless [1, 13].include?(Fiddle.last_error)
  STDOUT.write('denied'); exit(0)
end
argc = data.unpack1('i!'); exit(2) unless argc >= 0 && argc <= 4096
offset = data.index("\0", 4); exit(2) unless offset
offset += 1; offset += 1 while data.getbyte(offset) == 0
argc.times { stop = data.index("\0", offset); exit(2) unless stop; offset = stop + 1 }
values = data.byteslice(offset, length.unpack1('J') - offset).split("\0")
STDOUT.write(values.include?('SYNTHETIC_MANAGER_COOKIE=' + ARGV.fetch(1)) ? 'allowed' : 'unknown')`;

export async function probeProcessEnvironmentPrivacy({ sandbox, node = process.execPath }) {
  const cookie = randomBytes(24).toString('hex');
  const child = spawn(node, ['-e', 'setInterval(()=>{},1000)'], {
    env: { SYNTHETIC_MANAGER_COOKIE: cookie, OPENSSL_CONF: '/dev/null' }, stdio: 'ignore',
  });
  try {
    await once(child, 'spawn');
    const args = ['/usr/bin/ruby', '--disable-gems', '-e', code, String(child.pid), cookie];
    const control = await execute(args[0], args.slice(1), { env: { PATH: '/usr/bin:/bin' }, timeout: 5000, maxBuffer: 4096 });
    if (control.stdout !== 'allowed') throw new Error('darwin_process_privacy_control_unknown');
    const result = await sandbox(args);
    if (!result.ok || result.stdout !== 'denied') throw new Error(result.stdout === 'allowed'
      ? 'darwin_process_environment_exposed' : 'darwin_process_privacy_unknown');
    return { processEnvironmentDenied: true };
  } finally {
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }
}
