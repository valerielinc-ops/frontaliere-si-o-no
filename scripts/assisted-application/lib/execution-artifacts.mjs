/** The same already-redacted portal issue records used by the hosted workflow. */
import fs from 'node:fs';
import { redactStopReport, portalPassRecord } from './portal/stop-report.mjs';

const LIMIT = 32 * 1024;
const text = value => typeof value === 'string' && value.length <= 1000;
export function executionArtifacts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > LIMIT) return {};
  const result = {};
  const stop = value.stop;
  if (stop && ['host', 'path', 'reason', 'channel'].every(key => text(stop[key]))
    && /^[a-z0-9.-]{1,253}$/i.test(stop.host) && /^\/(?!\/)[^?#]*$/.test(stop.path)
    && ['buttons', 'fields', 'errors', 'agent'].every(key => Array.isArray(stop[key]))
    && stop.buttons.every(text) && stop.errors.every(text)
    && stop.fields.every(field => field && text(field.label) && text(field.kind))
    && stop.agent.every(item => item && text(item.hint) && text(item.status))) result.stop = redactStopReport(stop);
  const pass = value.pass;
  if (!result.stop && pass && /^[a-z0-9.-]{1,253}$/i.test(pass.host || '')
    && text(pass.channel) && ['submit', 'dry_run'].includes(pass.mode)
    && ['submitted', 'final_review'].includes(pass.stage)) result.pass = portalPassRecord(pass, pass.mode);
  return result;
}

export function readExecutionArtifacts(env = process.env) {
  const read = file => {
    try {
      if (!file || !fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > LIMIT) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { return null; }
  };
  return executionArtifacts({ stop: read(env.ASSISTED_APPLICATION_STOP_REPORT), pass: read(env.ASSISTED_APPLICATION_PORTAL_PASS) });
}

export function writeExecutionArtifacts(artifacts, env = process.env) {
  const safe = executionArtifacts(artifacts);
  for (const [key, target] of [['stop', env.ASSISTED_APPLICATION_STOP_REPORT], ['pass', env.ASSISTED_APPLICATION_PORTAL_PASS]]) {
    if (target && safe[key]) fs.writeFileSync(target, JSON.stringify(safe[key]), { mode: 0o600, flag: 'wx' });
  }
}
