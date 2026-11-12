#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sectionTreePhysicalPath } from "../lib/ticino-tree-fanout.mjs";
import { isInvokedDirectly } from "../lib/is-invoked-directly.mjs";

const JOB_SECTIONS = new Set(
  Object.keys(
    JSON.parse(
      fs.readFileSync(
        new URL("../lib/section-shard-slugs.json", import.meta.url),
        "utf8",
      ),
    ),
  ).filter((section) => !section.startsWith("articoli")),
);

function git(
  stage,
  args,
  { input, encoding = "utf8", maxBuffer = 64 * 1024 * 1024 } = {},
) {
  const result = spawnSync("git", ["-C", stage, ...args], {
    input,
    encoding,
    maxBuffer,
  });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : result.stderr;
    throw new Error(
      `git ${args[0]} failed: ${(stderr || "").trim() || `exit ${result.status}`}`,
    );
  }
  return result.stdout;
}

function walkFiles(root, relative = "", output = []) {
  const entries = fs
    .readdirSync(path.join(root, relative), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(root, rel);
    if (entry.isDirectory()) walkFiles(root, rel, output);
    else if (entry.isFile()) output.push({ absolute, relative: rel });
    else
      throw new Error(
        `[shard-fast-overlay] refusing non-regular source entry ${rel}`,
      );
  }
  return output;
}

function addCacheEntries(stage, rows) {
  const chunks = [];
  for (const { mode, oid, relative } of rows) {
    if (!/^100644$/u.test(mode) || !/^[0-9a-f]{40,64}$/u.test(oid)) {
      throw new Error(
        `[shard-fast-overlay] invalid index entry for ${relative}`,
      );
    }
    chunks.push(Buffer.from(`${mode} ${oid}\t${relative}\0`));
  }
  if (chunks.length > 0)
    git(stage, ["update-index", "-z", "--index-info"], {
      input: Buffer.concat(chunks),
      encoding: null,
    });
}

function countTreeFiles(stage, tree, sectionRoot) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "shard-fast-count-"));
  const output = path.join(scratch, "paths.z");
  const fd = fs.openSync(output, "w");
  try {
    const child = spawnSync(
      "git",
      [
        "-C",
        stage,
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        tree,
        "--",
        sectionRoot,
      ],
      {
        stdio: ["ignore", fd, "pipe"],
      },
    );
    if (child.status !== 0)
      throw new Error(
        `git ls-tree failed: ${(child.stderr || Buffer.alloc(0)).toString("utf8").trim()}`,
      );
    let count = 0;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const sourceFd = fs.openSync(output, "r");
    try {
      while (true) {
        const size = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
        if (size === 0) break;
        for (let i = 0; i < size; i += 1) if (buffer[i] === 0) count += 1;
      }
    } finally {
      fs.closeSync(sourceFd);
    }
    return count;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const [name, inline] = arg.slice(2).split("=", 2);
    values[name] = inline ?? argv[++i];
  }
  for (const name of [
    "stage",
    "source",
    "section",
    "sub",
    "previous-count",
    "source-count",
    "next-deploy-count",
    "source-sha",
    "out",
  ]) {
    if (values[name] == null || values[name] === "")
      throw new Error(`--${name} is required`);
  }
  return values;
}

export function applyFastShardOverlay(options) {
  const stage = path.resolve(options.stage);
  const source = path.resolve(options.source);
  const section = String(options.section);
  const sectionRoot = String(options.sub).replace(/^\/+|\/+$/gu, "");
  const previousCount = Number(options["previous-count"]);
  const expectedSourceCount = Number(options["source-count"]);
  const nextDeployCount = Number(options["next-deploy-count"]);
  const sourceSha = String(options["source-sha"]);
  const out = path.resolve(options.out);
  if (!JOB_SECTIONS.has(section)) {
    throw new Error(`[shard-fast-overlay] unsupported jobs section ${section}`);
  }
  if (
    !sectionRoot ||
    sectionRoot.startsWith(".") ||
    sectionRoot.includes("..") ||
    !Number.isSafeInteger(previousCount) ||
    previousCount < 1 ||
    !Number.isSafeInteger(expectedSourceCount) ||
    expectedSourceCount < 1 ||
    !Number.isSafeInteger(nextDeployCount) ||
    nextDeployCount < 2 ||
    !/^[0-9a-f]{7,64}$/iu.test(sourceSha)
  ) {
    throw new Error(
      "[shard-fast-overlay] invalid section, counters, or source SHA",
    );
  }
  if (!fs.statSync(stage).isDirectory() || !fs.statSync(source).isDirectory()) {
    throw new Error(
      "[shard-fast-overlay] stage and source must be directories",
    );
  }

  const baseSha = git(stage, ["rev-parse", "--verify", "HEAD"]).trim();
  if (!baseSha)
    throw new Error("[shard-fast-overlay] remote base HEAD is unavailable");
  git(stage, ["read-tree", "HEAD"]);

  const files = walkFiles(source);
  if (files.length !== expectedSourceCount) {
    throw new Error(
      `[shard-fast-overlay] source file count mismatch (${files.length} != ${expectedSourceCount})`,
    );
  }
  const targets = new Set();
  const entries = [];
  for (const file of files) {
    if (
      file.relative.includes("\n") ||
      file.relative.includes("\r") ||
      file.relative.includes("\0")
    ) {
      throw new Error(
        "[shard-fast-overlay] source path contains an unsupported control character",
      );
    }
    const physical = sectionTreePhysicalPath(section, file.relative);
    const relative = `${sectionRoot}/${physical}`;
    if (
      relative.split("/").some((part) => part === "." || part === "..") ||
      !relative.startsWith(`${sectionRoot}/`)
    ) {
      throw new Error(`[shard-fast-overlay] unsafe target path ${relative}`);
    }
    if (targets.has(relative))
      throw new Error(`[shard-fast-overlay] duplicate target path ${relative}`);
    targets.add(relative);
    const oid = git(stage, ["hash-object", "-w", "--", file.absolute]).trim();
    entries.push({ mode: "100644", oid, relative });
  }
  addCacheEntries(stage, entries);

  const contentChanges = git(
    stage,
    ["diff", "--cached", "--name-only", "-z", "HEAD"],
    { encoding: null },
  ).reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0);
  let tree = git(stage, ["write-tree", "--missing-ok"]).trim();
  let fileCount = countTreeFiles(stage, tree, sectionRoot);
  if (fileCount < previousCount) {
    throw new Error(
      `[shard-fast-overlay] append/update would shrink the remote shard (${previousCount} -> ${fileCount})`,
    );
  }

  if (contentChanges > 0) {
    const metadata = [
      [".shard-filecount", `${fileCount}`],
      [".shard-deploys", `${nextDeployCount}`],
      [".shard-source", sourceSha],
    ];
    for (const [relative, value] of metadata) {
      const oid = git(stage, ["hash-object", "-w", "--stdin"], {
        input: Buffer.from(value),
        encoding: "utf8",
      }).trim();
      addCacheEntries(stage, [{ mode: "100644", oid, relative }]);
    }
    tree = git(stage, ["write-tree", "--missing-ok"]).trim();
    fileCount = countTreeFiles(stage, tree, sectionRoot);
  }

  const receipt = {
    baseSha,
    tree,
    fileCount,
    previousCount,
    sourceFiles: files.length,
    contentChanges,
    changed: contentChanges > 0,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(receipt)}\n`);
  return receipt;
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    const result = applyFastShardOverlay(parseArgs(process.argv.slice(2)));
    console.log(
      `[shard-fast-overlay] section update ${result.changed ? "staged" : "already current"} files=${result.sourceFiles} changed=${result.contentChanges} shard-files=${result.fileCount}`,
    );
  } catch (error) {
    console.error(`[shard-fast-overlay] ${error?.message || error}`);
    process.exitCode = 1;
  }
}
