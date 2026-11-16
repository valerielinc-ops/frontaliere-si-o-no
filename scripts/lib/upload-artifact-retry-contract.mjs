function normalizeWhitespace(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function removeOuterParentheses(value) {
  let expression = normalizeWhitespace(value);

  while (expression.startsWith('(') && expression.endsWith(')')) {
    let depth = 0;
    let quote = null;
    let wrapsEntireExpression = true;

    for (let index = 0; index < expression.length; index += 1) {
      const character = expression[index];

      if (quote) {
        if (character === quote && expression[index - 1] !== '\\') quote = null;
        continue;
      }

      if (character === "'" || character === '"') {
        quote = character;
        continue;
      }

      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;

      if (depth === 0 && index < expression.length - 1) {
        wrapsEntireExpression = false;
        break;
      }
    }

    if (!wrapsEntireExpression || depth !== 0) break;
    expression = normalizeWhitespace(expression.slice(1, -1));
  }

  return expression;
}

function normalizedValue(value) {
  if (typeof value === 'string') return normalizeWhitespace(value);
  if (Array.isArray(value)) return value.map(normalizedValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalizedValue(value[key])]),
    );
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(normalizedValue(left)) === JSON.stringify(normalizedValue(right));
}

function outcomeReference(id) {
  return `steps.${id}.outcome == 'failure'`;
}

function retryIfReferencesStep(retryIf, id) {
  return normalizeWhitespace(retryIf ?? '').includes(outcomeReference(id));
}

function retryInheritsFirstAttemptIf(retryIf, firstAttemptIf, id) {
  if (firstAttemptIf === undefined || firstAttemptIf === null || firstAttemptIf === '') return true;

  const original = removeOuterParentheses(firstAttemptIf);
  const retry = normalizeWhitespace(retryIf ?? '');
  const retryWithoutParenthesisPadding = retry.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
  const outcome = outcomeReference(id);

  return retryWithoutParenthesisPadding.includes(`(${original}) && ${outcome}`)
    || retry.includes(`${original} && ${outcome}`);
}

function allowedEntry(allowed, job, stepName) {
  return allowed.some((entry) => entry
    && entry.job === job
    && entry.stepName === stepName
    && typeof entry.reason === 'string'
    && entry.reason.trim().length > 0);
}

function checkFirstAttempt(steps, index) {
  const firstAttempt = steps[index];
  const retry = steps[index + 1];

  if (firstAttempt['continue-on-error'] !== true) {
    return 'missing continue-on-error';
  }

  if (typeof firstAttempt.id !== 'string' || !firstAttempt.id.trim()) {
    return 'missing id';
  }

  if (!retry || typeof retry.uses !== 'string' || !retry.uses.startsWith('actions/upload-artifact@')
    || typeof retry.name !== 'string' || !retry.name.startsWith('Retry ')) {
    return 'no retry step follows';
  }

  if (!retryIfReferencesStep(retry.if, firstAttempt.id)) {
    return `retry if does not reference steps.${firstAttempt.id}.outcome`;
  }

  if (!retryInheritsFirstAttemptIf(retry.if, firstAttempt.if, firstAttempt.id)) {
    return 'first attempt if not inherited';
  }

  if (retry.with?.overwrite !== true) {
    return 'retry lacks overwrite: true';
  }

  const originalWith = firstAttempt.with ?? {};
  const retryWith = retry.with ?? {};

  for (const key of Object.keys(originalWith)) {
    if (!Object.hasOwn(retryWith, key) || !sameValue(originalWith[key], retryWith[key])) {
      return `retry with.${key} differs`;
    }
  }

  const unexpectedKeys = Object.keys(retryWith).filter((key) => key !== 'overwrite' && !Object.hasOwn(originalWith, key));
  if (unexpectedKeys.length > 0) {
    return `retry with has unexpected key: ${unexpectedKeys[0]}`;
  }

  return null;
}

function isUploadArtifactStep(step) {
  return typeof step?.uses === 'string' && step.uses.startsWith('actions/upload-artifact@');
}

function retryPairs(workflowDoc) {
  const pairs = [];

  for (const [job, jobDoc] of Object.entries(workflowDoc?.jobs ?? {})) {
    const steps = Array.isArray(jobDoc?.steps) ? jobDoc.steps : [];

    for (let index = 0; index < steps.length - 1; index += 1) {
      const firstAttempt = steps[index];
      const retry = steps[index + 1];

      if (!isUploadArtifactStep(firstAttempt) || firstAttempt.name?.startsWith('Retry ')
        || !isUploadArtifactStep(retry) || !retry.name?.startsWith('Retry ')) continue;

      pairs.push({ job, jobDoc, firstAttempt, retry });
    }
  }

  return pairs;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stringValues(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) stringValues(entry, output);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) stringValues(entry, output);
  }

  return output;
}

function expressionContaining(value, index) {
  const wrappedExpressions = [...value.matchAll(/\$\{\{[\s\S]*?\}\}/g)];
  const containingExpression = wrappedExpressions.find((match) => (
    index >= match.index && index < match.index + match[0].length
  ));

  if (containingExpression) return containingExpression[0];
  if (wrappedExpressions.length === 0) return value;

  const previousExpression = wrappedExpressions.filter((match) => match.index + match[0].length <= index).at(-1);
  const nextExpression = wrappedExpressions.find((match) => match.index > index);
  const start = previousExpression ? previousExpression.index + previousExpression[0].length : 0;
  const end = nextExpression ? nextExpression.index : value.length;
  return value.slice(start, end).trim();
}

function consumerValues(workflowDoc, currentJob, retry) {
  const values = [];

  for (const [job, jobDoc] of Object.entries(workflowDoc?.jobs ?? {})) {
    if (typeof jobDoc?.if === 'string') values.push({ job, value: jobDoc.if });
    if (jobDoc?.outputs !== undefined) {
      for (const value of stringValues(jobDoc.outputs)) values.push({ job, value });
    }

    for (const step of Array.isArray(jobDoc?.steps) ? jobDoc.steps : []) {
      for (const key of ['if', 'env', 'with', 'run']) {
        if (key === 'if' && job === currentJob && step === retry) continue;
        if (step?.[key] === undefined) continue;
        for (const value of stringValues(step[key])) values.push({ job, value });
      }
    }
  }

  return values;
}

export function findStaleFirstAttemptReferences(workflowDoc) {
  const findings = [];

  for (const { job, firstAttempt, retry } of retryPairs(workflowDoc)) {
    if (typeof firstAttempt.id !== 'string' || !firstAttempt.id.trim()) continue;

    const reference = new RegExp(
      `steps\\.${escapeRegExp(firstAttempt.id)}\\.(?:outcome|conclusion|outputs(?:\\.[A-Za-z0-9_-]+)+)`,
      'g',
    );
    const retryReference = typeof retry.id === 'string' && retry.id.trim()
      ? new RegExp(`steps\\.${escapeRegExp(retry.id)}\\.`)
      : null;

    for (const { job: consumerJob, value } of consumerValues(workflowDoc, job, retry)) {
      for (const match of value.matchAll(reference)) {
        const expression = expressionContaining(value, match.index);
        if (retryReference?.test(expression)) continue;

        findings.push({
          job,
          stepName: typeof firstAttempt.name === 'string' ? firstAttempt.name : '',
          expression,
          reason: `unrouted steps.${firstAttempt.id} reference in ${consumerJob}; retry result ${retry.id ?? '(missing id)'} is not used`,
        });
      }
    }
  }

  return findings;
}

export function findUploadArtifactStepsWithoutRetry(workflowDoc, { allowed = [] } = {}) {
  const findings = [];

  for (const [job, jobDoc] of Object.entries(workflowDoc?.jobs ?? {})) {
    const steps = Array.isArray(jobDoc?.steps) ? jobDoc.steps : [];

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (!isUploadArtifactStep(step)) continue;

      if (typeof step.name === 'string' && step.name.startsWith('Retry ')) {
        const previous = steps[index - 1];
        if (isUploadArtifactStep(previous) && !previous.name?.startsWith('Retry ')) {
          // The preceding upload owns the diagnostic for a malformed adjacent retry.
          continue;
        }
        if (!isUploadArtifactStep(previous) || !previous.name?.startsWith('Retry ')) {
          const stepName = step.name;
          const reason = 'retry is not immediately preceded by its first attempt';
          if (!allowedEntry(allowed, job, stepName)) findings.push({ job, stepName, index, reason });
        }
        continue;
      }

      const reason = checkFirstAttempt(steps, index);
      if (!reason) continue;

      const stepName = typeof step.name === 'string' ? step.name : '';
      if (!allowedEntry(allowed, job, stepName)) findings.push({ job, stepName, index, reason });
    }
  }

  return findings;
}

export const UPLOAD_ARTIFACT_RETRY_ALLOWED = [];
