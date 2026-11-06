import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const GENERATION_WORKFLOW_CONTRACT_MARKER = '# generation-cloud-clock-contract: v1';
const GENERATION_DISPATCH_ORIGINS = ['manual', 'cloud_scheduler', 'chain', 'editorial_signal'];

function rootSection(source, name) {
  const lines = String(source ?? '').split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `${name}:` || line.startsWith(`${name}: #`));
  if (start < 0) return [];
  const section = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[A-Za-z][A-Za-z0-9_-]*:\s*(?:#.*)?$/u.test(lines[index])) break;
    section.push(lines[index]);
  }
  return section;
}

export function inspectGenerationWorkflowContract(source) {
  const text = String(source ?? '');
  const onLines = rootSection(text, 'on');
  const dispatchStart = onLines.findIndex((line) => /^  workflow_dispatch:\s*$/u.test(line));
  const dispatchLines = dispatchStart < 0 ? [] : onLines.slice(dispatchStart + 1).filter((line) => !/^  [A-Za-z_][A-Za-z0-9_-]*:\s*$/u.test(line));
  const hasInput = (name) => dispatchLines.some((line) => new RegExp(`^      ${name}:\\s*$`, 'u').test(line));
  const originStart = dispatchLines.findIndex((line) => line === '      dispatch_origin:');
  const originEnd = originStart < 0 ? -1 : dispatchLines.findIndex((line, index) => (
    index > originStart && /^      [A-Za-z_][A-Za-z0-9_-]*:\s*$/u.test(line)
  ));
  const originLines = originStart < 0
    ? []
    : dispatchLines.slice(originStart, originEnd < 0 ? undefined : originEnd);
  const originOptions = originLines
    .filter((line) => /^          - /u.test(line))
    .map((line) => line.slice('          - '.length));
  const originContractReady = originLines.some((line) => /^        required: true\s*$/u.test(line))
    && originLines.some((line) => /^        type: choice\s*$/u.test(line))
    && !originLines.some((line) => /^        default:/u.test(line))
    && JSON.stringify(originOptions) === JSON.stringify(GENERATION_DISPATCH_ORIGINS);
  const hasNativeSchedule = onLines.some((line) => /^  schedule:\s*$/u.test(line));
  const markerPresent = text.split(/\r?\n/u).includes(GENERATION_WORKFLOW_CONTRACT_MARKER);
  const missingInputs = ['section', 'dry_run', 'loop_clock', 'recovery_slot', 'recovery_claim']
    .filter((name) => !hasInput(name));
  const runNameReady = text.split(/\r?\n/u).some((line) => (
    /^run-name:\s*/u.test(line)
    && line.includes('inputs.loop_clock')
    && line.includes('inputs.recovery_slot')
    && line.includes('[loop-clock ')
    && line.includes('[generation-slot ')
  ));
  const ready = markerPresent && dispatchStart >= 0 && !hasNativeSchedule
    && missingInputs.length === 0 && hasInput('dispatch_origin') && originContractReady && runNameReady;
  let reason = 'ready';
  if (!markerPresent) reason = 'contract_marker_missing';
  else if (hasNativeSchedule) reason = 'native_schedule_still_present';
  else if (dispatchStart < 0) reason = 'workflow_dispatch_missing';
  else if (!hasInput('dispatch_origin')) reason = 'dispatch_origin_missing';
  else if (!originContractReady) reason = 'dispatch_origin_invalid';
  else if (missingInputs.length > 0) reason = 'recovery_inputs_missing';
  else if (!runNameReady) reason = 'run_name_contract_missing';
  return {
    ready,
    reason,
    hasWorkflowDispatch: dispatchStart >= 0,
    hasNativeSchedule,
    missingInputs,
    hasUrlInput: hasInput('url'),
    hasSectionInput: hasInput('section'),
    hasDispatchOrigin: hasInput('dispatch_origin'),
    dispatchOrigins: originOptions,
  };
}

export function generationWorkflowSupportsOrigin(source, origin = 'editorial_signal') {
  const contract = inspectGenerationWorkflowContract(source);
  return contract.hasWorkflowDispatch
    && contract.hasUrlInput
    && contract.hasSectionInput
    && contract.hasDispatchOrigin
    && contract.dispatchOrigins.includes(origin);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let source;
  try {
    source = readFileSync(0, 'utf8');
    const { parse } = await import('yaml');
    parse(source);
  } catch {
    process.stderr.write('generation_workflow_yaml_read_or_parse_failed\n');
    process.exitCode = 2;
  }
  if (process.exitCode !== 2) {
    const contract = inspectGenerationWorkflowContract(source);
    if (!contract.hasWorkflowDispatch || !contract.hasUrlInput || !contract.hasSectionInput) {
      process.stderr.write('generation_workflow_dispatch_inputs_invalid\n');
      process.exitCode = 2;
    } else if (!contract.hasDispatchOrigin) {
      process.stdout.write('legacy\n');
    } else if (generationWorkflowSupportsOrigin(source)) {
      process.stdout.write('supported\n');
    } else {
      process.stderr.write('generation_workflow_dispatch_origin_invalid\n');
      process.exitCode = 2;
    }
  }
}
