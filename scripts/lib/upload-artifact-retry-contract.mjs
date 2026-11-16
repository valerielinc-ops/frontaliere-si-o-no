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
