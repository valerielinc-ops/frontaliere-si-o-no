import net from 'node:net';

const socketPath = process.env.CODEX_GIT_SOCKET;
if (!socketPath) {
  console.error('Codex Git bridge socket unavailable');
  process.exit(2);
}
const args = process.argv.slice(2);
const client = net.createConnection(socketPath);
let response = '';
client.setEncoding('utf8');
client.on('data', (chunk) => { response += chunk; });
client.on('error', (error) => {
  console.error(`Codex Git bridge: ${error.message}`);
  process.exit(2);
});
client.on('end', () => {
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
client.end(`${JSON.stringify(args)}\n`);
