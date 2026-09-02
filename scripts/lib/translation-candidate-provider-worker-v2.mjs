import { randomBytes } from 'node:crypto';
import { MessageChannel, parentPort, workerData } from 'node:worker_threads';

const PROVIDER_PROTOCOL_SCHEMA_VERSION = 3;
const MAX_PROVIDER_OUTPUT_LENGTH = 120_000;

if (!parentPort) {
  throw new Error('translation candidate provider worker requires a parent port');
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const controller = new AbortController();
const nonce = randomBytes(32).toString('hex');
const { port1: privatePort, port2: bootstrapPort } = new MessageChannel();
privatePort.unref();
const sendPrivateMessage = privatePort.postMessage.bind(privatePort);
const sendParentMessage = parentPort.postMessage.bind(parentPort);
sendParentMessage(Object.freeze({
  schemaVersion: PROVIDER_PROTOCOL_SCHEMA_VERSION,
  type: 'bootstrap',
  port: bootstrapPort,
  nonce,
}), [bootstrapPort]);

let terminal = false;

function finish(message) {
  if (terminal) return;
  terminal = true;
  controller.abort();
  sendPrivateMessage(Object.freeze({ ...message, nonce }));
}

function protocolFailure() {
  finish(Object.freeze({ schemaVersion: PROVIDER_PROTOCOL_SCHEMA_VERSION, type: 'fail' }));
}

function succeedText(text) {
  if (arguments.length !== 1 || typeof text !== 'string' || text.length > MAX_PROVIDER_OUTPUT_LENGTH) {
    protocolFailure();
    return;
  }
  finish(Object.freeze({ schemaVersion: PROVIDER_PROTOCOL_SCHEMA_VERSION, type: 'succeed', text }));
}

function fail() {
  if (arguments.length !== 0) {
    protocolFailure();
    return;
  }
  protocolFailure();
}

try {
  const providerModule = await import(workerData.provider.moduleUrl);
  const translate = providerModule[workerData.provider.exportName];
  if (typeof translate !== 'function') {
    protocolFailure();
  } else {
    const request = deepFreeze(workerData.request);
    const options = Object.freeze({ signal: controller.signal, succeedText, fail });
    let returned;
    let threw = false;
    try {
      returned = Reflect.apply(translate, undefined, [request, options]);
    } catch {
      threw = true;
      protocolFailure();
    }
    if (!threw && returned === undefined) {
      sendParentMessage(Object.freeze({
        schemaVersion: PROVIDER_PROTOCOL_SCHEMA_VERSION,
        type: 'ack',
        nonce,
      }));
    } else if (!threw) {
      protocolFailure();
    }
  }
} catch {
  protocolFailure();
}
