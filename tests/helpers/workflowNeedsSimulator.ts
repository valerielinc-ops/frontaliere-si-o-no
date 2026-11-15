/**
 * Minimal evaluator for the job graph of a GitHub Actions workflow: it decides,
 * for a set of fixture job outcomes and outputs, which jobs RUN and which are
 * SKIPPED, following the rules the publisher depends on.
 *
 *  - A job runs when its `if` is true. An `if` that contains no status function
 *    (`always()`, `success()`, `failure()`, `cancelled()`) is treated as
 *    `success() && (if)`, and that implicit `success()` requires EVERY ancestor,
 *    direct or transitive, to be `success` (actions/runner#491): a skipped
 *    grandparent skips the job even when the middle job used `always()`.
 *  - A job without `if` behaves like `if: success()`.
 *  - A job that runs concludes with its override (default `success`); a job that
 *    does not run is `skipped`.
 *  - `needs.<job>.outputs.<name>` reads the fixture outputs and is empty for a
 *    job that did not conclude `success`.
 *
 * Only the expression subset the publisher uses is supported: `&&`, `||`, `!`,
 * `==`, `!=`, string literals, `needs.<job>.result|outputs.<name>`,
 * `inputs.<name>`, `contains()`, `fromJSON()` and the four status functions.
 * Anything else throws, so a new construct cannot silently evaluate wrong.
 */

export type JobResult = 'success' | 'failure' | 'skipped' | 'cancelled';

export interface SimulationOptions {
  outputs?: Record<string, Record<string, string>>;
  overrides?: Record<string, JobResult>;
  /** Jobs that are skipped regardless of their own `if` (an unmodelled upstream cause). */
  forceSkip?: string[];
  inputs?: Record<string, string>;
}

const STATUS_FUNCTION = /\b(?:always|success|failure|cancelled)\(\)/;
const ALLOWED_RESIDUE = /^[\s()&|!=',]*$/;

function jobNeeds(definition: any): string[] {
  const needs = definition?.needs;
  if (needs === undefined || needs === null) return [];
  return Array.isArray(needs) ? needs.map(String) : [String(needs)];
}

function stripExpressionDelimiters(expression: string): string {
  const trimmed = expression.trim();
  const match = /^\$\{\{([\s\S]*)\}\}$/.exec(trimmed);
  return (match ? match[1] : trimmed).replace(/\s+/g, ' ').trim();
}

/** Evaluate one `${{ … }}` expression (or a bare `if` condition) to its value. */
export function evaluateExpression(
  expression: string,
  context: {
    result: (job: string) => string;
    output: (job: string, name: string) => string;
    input: (name: string) => string;
  },
): unknown {
  const source = stripExpressionDelimiters(expression);
  const compiled = source
    .replace(/needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g, "O('$1','$2')")
    .replace(/needs\.([A-Za-z0-9_-]+)\.result/g, "R('$1')")
    .replace(/inputs\.([A-Za-z0-9_]+)/g, "I('$1')")
    .replace(/!=/g, '!==')
    .replace(/([^=!<>])==/g, '$1===');
  // Reject whatever the translation did not understand instead of guessing.
  const residue = compiled
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\b(?:always|success|failure|cancelled|contains|fromJSON|R|O|I)\b/g, '');
  if (!ALLOWED_RESIDUE.test(residue)) {
    throw new Error(`workflowNeedsSimulator: unsupported expression construct in: ${source}`);
  }
  const helpers = {
    always: () => true,
    cancelled: () => false,
    success: () => true,
    failure: () => false,
    fromJSON: (value: string) => JSON.parse(value),
    contains: (haystack: unknown, needle: unknown) => (Array.isArray(haystack)
      ? haystack.includes(needle)
      : String(haystack).toLowerCase().includes(String(needle).toLowerCase())),
    R: context.result,
    O: context.output,
    I: context.input,
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function(...Object.keys(helpers), `return (${compiled});`);
  return fn(...Object.values(helpers));
}

export function simulateWorkflow(
  workflow: { jobs: Record<string, any> },
  { outputs = {}, overrides = {}, forceSkip = [], inputs = {} }: SimulationOptions = {},
): Record<string, JobResult> {
  const jobs = workflow.jobs;
  const results: Record<string, JobResult> = {};

  const ancestorsOf = (job: string, seen = new Set<string>()): Set<string> => {
    for (const parent of jobNeeds(jobs[job])) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      ancestorsOf(parent, seen);
    }
    return seen;
  };

  const resolve = (job: string): JobResult => {
    if (results[job]) return results[job];
    if (!jobs[job]) throw new Error(`workflowNeedsSimulator: unknown job ${job}`);
    for (const parent of jobNeeds(jobs[job])) resolve(parent);
    const definition = jobs[job];
    const condition = definition.if === undefined ? '' : String(definition.if);
    const explicitStatus = STATUS_FUNCTION.test(condition);
    const allAncestorsSucceeded = [...ancestorsOf(job)].every((ancestor) => resolve(ancestor) === 'success');
    let runs = !forceSkip.includes(job);
    if (runs && !explicitStatus && !allAncestorsSucceeded) runs = false;
    if (runs && condition) {
      runs = Boolean(evaluateExpression(condition, {
        result: (name) => {
          if (!jobs[name]) throw new Error(`workflowNeedsSimulator: ${job} reads needs.${name} which is not a job`);
          return resolve(name);
        },
        output: (name, key) => (resolve(name) === 'success' ? outputs[name]?.[key] ?? '' : ''),
        input: (name) => inputs[name] ?? '',
      }));
    }
    results[job] = runs ? (overrides[job] ?? 'success') : 'skipped';
    return results[job];
  };

  for (const job of Object.keys(jobs)) resolve(job);
  return results;
}
