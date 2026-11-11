#!/usr/bin/env node
import { spawn } from "node:child_process";
import { isInvokedDirectly } from "../lib/is-invoked-directly.mjs";
import {
  acquireShardWriterLeases,
  releaseShardWriterLeases,
  renewShardWriterLeases,
  SHARD_WRITER_LOCK_DEFAULTS,
} from "../lib/shard-writer-lease.mjs";

function parseArgs(argv) {
  const out = {
    policy: "wait",
    timeoutMs: 15 * 60_000,
    sections: [],
    child: [],
  };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--") {
      out.child = argv.slice(index + 1);
      break;
    }
    if (arg === "--section") out.sections.push(argv[++index]);
    else if (arg.startsWith("--section="))
      out.sections.push(arg.slice("--section=".length));
    else if (arg === "--locale") out.locale = argv[++index];
    else if (arg.startsWith("--locale="))
      out.locale = arg.slice("--locale=".length);
    else if (arg === "--policy") out.policy = argv[++index];
    else if (arg.startsWith("--policy="))
      out.policy = arg.slice("--policy=".length);
    else if (arg === "--timeout-ms") out.timeoutMs = Number(argv[++index]);
    else if (arg.startsWith("--timeout-ms="))
      out.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    else
      throw new Error(`[with-shard-writer-lock] unexpected argument: ${arg}`);
    index++;
  }
  if (!out.child.length || out.sections.length === 0 || !out.locale) {
    throw new Error(
      "usage: with-shard-writer-lock.mjs --section <section> [--section <section>...] --locale <it|en|de|fr> --policy <wait|skip> -- <command> [args...]",
    );
  }
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs < 0) {
    throw new Error(
      "[with-shard-writer-lock] --timeout-ms must be a non-negative number",
    );
  }
  return out;
}

function runChild(command, args, onSpawn = () => {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    onSpawn(child);
    let signal = null;
    let settled = false;
    const onSignal = (received) => {
      signal = received;
      if (child.exitCode === null) child.kill(received);
    };
    const onTerm = () => onSignal("SIGTERM");
    const onInt = () => onSignal("SIGINT");
    process.once("SIGTERM", onTerm);
    process.once("SIGINT", onInt);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      resolve({ code: 1, signal: null, error });
    });
    child.once("exit", (code, childSignal) => {
      if (settled) return;
      settled = true;
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      resolve({
        code: signal ? 128 + (signal === "SIGINT" ? 2 : 15) : (code ?? 1),
        signal: childSignal,
      });
    });
  });
}

export async function runWithShardWriterLock(args = process.argv.slice(2)) {
  const parsed = parseArgs(args);
  const scopes = parsed.sections.map((section) => ({
    section,
    locale: parsed.locale,
  }));
  const leaseSet = await acquireShardWriterLeases(scopes, {
    policy: parsed.policy,
    timeoutMs: parsed.timeoutMs,
  });
  if (!leaseSet.acquired) {
    console.log(
      `[with-shard-writer-lock] skipped busy scopes=${leaseSet.busy.join(",")}`,
    );
    return 75;
  }

  let renewalError = null;
  let renewing = false;
  let childProcess = null;
  const interval = setInterval(async () => {
    if (renewing || renewalError) return;
    renewing = true;
    try {
      await renewShardWriterLeases(leaseSet);
    } catch (error) {
      renewalError = error;
      console.error(
        `[with-shard-writer-lock] renewal failed: ${error?.message || error}`,
      );
      if (childProcess?.exitCode === null) childProcess.kill("SIGTERM");
    } finally {
      renewing = false;
    }
  }, SHARD_WRITER_LOCK_DEFAULTS.heartbeatMs);
  interval.unref?.();

  let result;
  try {
    result = await runChild(parsed.child[0], parsed.child.slice(1), (child) => {
      childProcess = child;
      if (renewalError) child.kill("SIGTERM");
    });
  } finally {
    clearInterval(interval);
    if (renewing) {
      while (renewing) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await releaseShardWriterLeases(leaseSet);
  }
  if (renewalError) return 1;
  if (result?.error) {
    console.error(
      `[with-shard-writer-lock] child could not start: ${result.error.message}`,
    );
    return 1;
  }
  return result?.code ?? 1;
}

if (isInvokedDirectly(import.meta.url)) {
  runWithShardWriterLock()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[with-shard-writer-lock] ${error?.message || error}`);
      process.exitCode = 1;
    });
}
