import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');

type Payload = {
  workflow: string;
  location: string;
  source: string;
};

type ScriptWriter = {
  script: string;
  source: string;
  writeStart: number;
  workflows: Payload[];
};

function filesUnder(directory: string, filePattern: RegExp): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(full, filePattern);
    return filePattern.test(entry.name) ? [full] : [];
  });
}

function workflowFiles(directory: string): string[] {
  return filesUnder(directory, /\.ya?ml$/i);
}

function collectPayloads(value: unknown, workflow: string, location = '$') {
  const found: Payload[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      found.push(...collectPayloads(item, workflow, `${location}[${index}]`));
    });
    return found;
  }
  if (!value || typeof value !== 'object') return found;

  const record = value as Record<string, unknown>;
  if (typeof record.run === 'string') {
    found.push({ workflow, location: `${location}.run`, source: record.run });
  }
  const withBlock = record.with;
  if (withBlock && typeof withBlock === 'object' && !Array.isArray(withBlock)) {
    const prompt = (withBlock as Record<string, unknown>).prompt;
    if (typeof prompt === 'string') {
      found.push({ workflow, location: `${location}.with.prompt`, source: prompt });
    }
  }

  for (const [key, child] of Object.entries(record)) {
    found.push(...collectPayloads(child, workflow, `${location}.${key}`));
  }
  return found;
}

function withoutShellComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function withoutSourceComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/^\s*(?:\/\/|#).*$/gm, (comment) => comment.replace(/[^\n]/g, ' '));
}

function bodyWriteCommands(source: string): Array<{ start: number; command: string }> {
  const live = withoutShellComments(source);
  // Stop at the next gh command too, not only at the next PR command: a
  // label-only `gh pr edit` followed by `gh pr comment --body` is not a body
  // writer and must not be joined into one synthetic command.
  const matches = [...live.matchAll(/\bgh\s+[a-z][\w-]*(?:\s+[a-z][\w-]*)?\b/g)];
  return matches.flatMap((match, index) => {
    const start = match.index ?? -1;
    if (start < 0) return [];
    const nextStart = matches[index + 1]?.index ?? live.length;
    const command = live.slice(start, nextStart);
    return /^gh\s+pr\s+(create|edit)\b/.test(match[0]) &&
      /--body(?:-file)?(?:[=\s])/.test(command)
      ? [{ start, command }]
      : [];
  });
}

function scriptBodyWriteStart(source: string): number {
  const live = withoutSourceComments(source);
  const nodeCli = live.search(
    /(?:execFileSync|spawnSync)\(\s*['"]gh['"]\s*,\s*\[\s*['"]pr['"]\s*,\s*['"](?:create|edit)['"]/
  );
  if (nodeCli >= 0) return nodeCli;
  const shellCli = live.search(/(?:^|\n)\s*(?:if\s+!)?gh\s+pr\s+(?:create|edit)\b/m);
  return shellCli >= 0 && /--body-file(?:[=\s])/.test(live.slice(shellCli))
    ? shellCli
    : -1;
}

function scriptGateStart(source: string): number {
  const live = withoutSourceComments(source);
  const importedValidator = live.search(/\bvalidatePrBody(?:File)?\s*\(/);
  if (importedValidator >= 0) return importedValidator;
  return live.search(/\bnode\b[^\n]*pr-body-check-gate\.mjs[^\n]*--body-file/);
}

function workflowReferencedScripts(payloads: Payload[]): string[] {
  const paths = new Set<string>();
  for (const payload of payloads) {
    for (const match of payload.source.matchAll(/(?:scripts|bin)\/[A-Za-z0-9_./-]+\.(?:mjs|js|sh)\b/g)) {
      const script = match[0];
      if (fs.existsSync(path.join(ROOT, script))) paths.add(script);
    }
  }
  return [...paths];
}

function discoverWriters(): { direct: Payload[]; prompts: Payload[]; scripts: ScriptWriter[] } {
  const direct: Payload[] = [];
  const prompts: Payload[] = [];
  const payloads: Payload[] = [];

  for (const file of workflowFiles(WORKFLOW_DIR)) {
    const workflow = path.relative(ROOT, file);
    const document = YAML.parse(fs.readFileSync(file, 'utf8'));
    for (const payload of collectPayloads(document, workflow)) {
      payloads.push(payload);
      if (payload.location.endsWith('.run')) {
        if (bodyWriteCommands(payload.source).length > 0) direct.push(payload);
      } else if (
        /\bgh\s+pr\s+(create|edit)\b/i.test(payload.source) &&
        /\bbody\b/i.test(payload.source)
      ) {
        prompts.push(payload);
      }
    }
  }

  const scripts = workflowReferencedScripts(payloads)
    .map((script): ScriptWriter | null => {
      const source = fs.readFileSync(path.join(ROOT, script), 'utf8');
      const writeStart = scriptBodyWriteStart(source);
      if (writeStart < 0) return null;
      return {
        script,
        source,
        writeStart,
        workflows: payloads.filter((payload) => payload.source.includes(script)),
      };
    })
    .filter((writer): writer is ScriptWriter => writer !== null);

  return { direct, prompts, scripts };
}

describe('every workflow PR body writer crosses the deterministic gate', () => {
  it('discovers body-writing paths instead of maintaining a hand-written workflow list', () => {
    const writers = discoverWriters();
    expect(
      writers.direct.length + writers.prompts.length + writers.scripts.length,
      'the coverage detector must find at least one live PR body writer',
    ).toBeGreaterThan(0);

    for (const payload of writers.direct) {
      const commands = bodyWriteCommands(payload.source);
      const firstWrite = commands[0];
      const live = withoutShellComments(payload.source);
      const gate = live.indexOf('pr-body-check-gate.mjs');
      expect(
        gate,
        `${payload.workflow} ${payload.location} writes a PR body but never invokes the shared gate`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        gate,
        `${payload.workflow} ${payload.location} invokes the gate after its body write`,
      ).toBeLessThan(firstWrite.start);
      expect(
        firstWrite.command,
        `${payload.workflow} ${payload.location} must pass the validated file to gh`,
      ).toMatch(/--body-file\b/);
    }

    for (const payload of writers.prompts) {
      expect(
        payload.source,
        `${payload.workflow} ${payload.location} writes a PR body without --body-file`,
      ).toMatch(/--body-file(?:[=\s])/);
      expect(
        payload.source,
        `${payload.workflow} ${payload.location} does not invoke the shared gate before gh`,
      ).toMatch(/pr-body-check-gate\.mjs\s+--body-file/);
      expect(
        payload.source,
        `${payload.workflow} ${payload.location} still mentions an inline --body writer`,
      ).not.toMatch(/--body(?!-file)\b/);

      const workflowSource = fs.readFileSync(path.join(ROOT, payload.workflow), 'utf8');
      expect(workflowSource, `${payload.workflow} is missing the gh wrapper`).toContain(
        'scripts/gh-pr-body-check.mjs',
      );
      expect(workflowSource, `${payload.workflow} does not put the wrapper on PATH`).toContain(
        '$GITHUB_PATH',
      );
    }

    for (const writer of writers.scripts) {
      expect(
        writer.workflows.length,
        `${writer.script} writes a PR body but no workflow invokes it`,
      ).toBeGreaterThan(0);
      const live = withoutSourceComments(writer.source);
      const gateReference = live.indexOf('pr-body-check-gate.mjs');
      expect(
        gateReference,
        `${writer.script} writes a PR body but never references the shared gate`,
      ).toBeGreaterThanOrEqual(0);
      const gate = scriptGateStart(writer.source);
      expect(
        gate,
        `${writer.script} writes a PR body but has no executable shared-gate call`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        gate,
        `${writer.script} invokes the gate after its remote body writer`,
      ).toBeLessThan(writer.writeStart);
      expect(
        live.slice(writer.writeStart),
        `${writer.script} must pass the validated file to gh`,
      ).toMatch(/--body-file\b/);
      expect(
        live.slice(writer.writeStart),
        `${writer.script} still contains an inline --body writer`,
      ).not.toMatch(/--body(?!-file)\b/);
    }
  });
});
