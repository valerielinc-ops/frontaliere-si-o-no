import * as net from './bridge-transport.mjs';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 150_000;
const socketPath = process.env.CODEX_GIT_SOCKET;
if (!socketPath) {
  console.error('Codex Git bridge socket unavailable');
  process.exit(2);
}
const args = process.argv.slice(2);
const request = `${JSON.stringify(args)}\n`;
if (Buffer.byteLength(request) > MAX_REQUEST_BYTES) {
  console.error('Codex Git bridge request exceeds its input limit');
  process.exit(2);
}
const client = net.createConnection(socketPath);
let response = '';
let finished = false;
const fail = (message) => {
  if (finished) return;
  finished = true;
  client.destroy();
  console.error(message);
  process.exit(2);
};
client.setEncoding('utf8');
client.setTimeout(RESPONSE_TIMEOUT_MS, () => fail('Codex Git bridge socket timed out'));
client.on('data', (chunk) => {
  response += chunk;
  if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) fail('Codex Git bridge response exceeds its output limit');
});
client.on('error', (error) => {
  fail(`Codex Git bridge: ${error.message}`);
});
client.on('end', () => {
  if (finished) return;
  finished = true;
  try {
    const result = JSON.parse(response);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(Number.isInteger(result.code) ? result.code : 1);
  } catch (error) {
    console.error(`Codex Git bridge response: ${error.message}`);
    process.exit(2);
  }
});
client.end(request);
