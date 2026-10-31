#!/usr/bin/env node
/** The sandboxed child claims its private job directory before loading candidate code. */
import { requestProcessRegistration } from './lib/process-registry.mjs';

await requestProcessRegistration({ socket: process.env.ASSISTED_APPLICATION_PROCESS_REGISTRY_SOCKET,
  nonce: process.env.ASSISTED_APPLICATION_PROCESS_REGISTRY_NONCE, role: 'agent', pid: process.pid });
const { runAgentAndClose } = await import('./agent.mjs');
await runAgentAndClose();
