const WORKFLOW_INPUT_REFERENCE_RE = /(?<![A-Za-z0-9_.-])(?:github\.event\.)?inputs\.([A-Za-z0-9_-]+)/gu;

/**
 * Return only real Actions input property references. In particular, the
 * `inputs` substring in a job id such as `validate-inputs.result` is not an
 * input context and must not be classified as one.
 */
export function workflowInputReferences(value) {
  return [...String(value || '').matchAll(WORKFLOW_INPUT_REFERENCE_RE)];
}
