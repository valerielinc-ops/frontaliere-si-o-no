import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyFastShardOverlay } from "../scripts/ci/shard-fast-overlay.mjs";
import { ticinoTreePhysicalPath } from "../scripts/lib/ticino-tree-fanout.mjs";

const scratch = [];

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRemote(section, sub, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "jobs-fast-overlay-"));
  scratch.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "jobs-fast-test@example.invalid");
  git(root, "config", "user.name", "jobs-fast-test");
  writeFileSync(path.join(root, ".shard-filecount"), String(Object.keys(files).length));
  writeFileSync(path.join(root, ".shard-deploys"), "1");
  writeFileSync(path.join(root, ".shard-source"), "0123456789abcdef");
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, sub, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  git(root, "add", ".");
  git(root, "commit", "-qm", "seed section shard");
  const source = path.join(root, "source");
  mkdirSync(source, { recursive: true });
  return { root, source };
}

function writeSource(source, relative, contents) {
  const absolute = path.join(source, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

afterEach(() => {
  for (const root of scratch.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("append-only fast shard overlay", () => {
  it("updates only rendered routes and retains unrelated remote pages", () => {
    const sub = "cerca-lavoro-zurigo";
    const { root, source } = makeRemote("zurigo", sub, {
      "existing/index.html": "existing page",
      "target/index.html": "old target",
    });
    writeSource(source, "target/index.html", "new target");
    writeSource(source, "added/index.html", "new offer");

    const result = applyFastShardOverlay({
      stage: root,
      source,
      section: "zurigo",
      sub,
      "previous-count": "2",
      "source-count": "2",
      "next-deploy-count": "2",
      "source-sha": "abcdef0123456789",
      out: path.join(root, "receipt.json"),
    });

    expect(result.changed).toBe(true);
    expect(result.fileCount).toBe(3);
    expect(git(root, "show", `:${sub}/existing/index.html`)).toBe(
      "existing page",
    );
    expect(git(root, "show", `:${sub}/target/index.html`)).toBe("new target");
    expect(git(root, "show", `:${sub}/added/index.html`)).toBe("new offer");
    expect(git(root, "show", ":.shard-filecount")).toBe("3");
    expect(git(root, "show", ":.shard-deploys")).toBe("2");
  });

  it("uses the canonical Ticino fanout path for a fast offer page", () => {
    const sub = "cerca-lavoro-ticino";
    const { root, source } = makeRemote("ticino", sub, {
      "retained/index.html": "retained",
    });
    writeSource(source, "new-offer/index.html", "offer html");
    const physical = ticinoTreePhysicalPath("new-offer/index.html");

    applyFastShardOverlay({
      stage: root,
      source,
      section: "ticino",
      sub,
      "previous-count": "1",
      "source-count": "1",
      "next-deploy-count": "2",
      "source-sha": "abcdef0123456789",
      out: path.join(root, "receipt.json"),
    });

    expect(git(root, "show", `:${sub}/${physical}`)).toBe("offer html");
    expect(git(root, "show", `:${sub}/retained/index.html`)).toBe("retained");
  });
});
