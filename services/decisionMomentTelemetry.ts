/**
 * Shared bridge for decision-moment telemetry emitted by static HTML and the
 * SPA. The bridge carries categorical identifiers only; Analytics is kept in
 * the runtime shell so static build plugins never load Firebase or PostHog.
 */

export const DECISION_MOMENT_BRIDGE_EVENT = 'frontaliere:decision-moment';
export const DECISION_MOMENT_QUEUE_KEY = '__FRONTALIERE_DECISION_MOMENTS__';
export const DECISION_MOMENT_COMPLETED_ATTRIBUTE = 'data-decision-moment-completed';
export const DECISION_MOMENT_NEXT_ACTION_ATTRIBUTE = 'data-decision-moment-next-action';
export const DECISION_MOMENT_SURFACE_ATTRIBUTE = 'data-decision-moment-surface';
export const DECISION_MOMENT_ID_ATTRIBUTE = 'data-decision-moment-id';

export type DecisionMomentBridgePayload = {
  kind: 'completed' | 'next_action';
  surface: 'border' | 'pharmacy';
  id: string;
};

const VALID_KINDS = new Set<DecisionMomentBridgePayload['kind']>(['completed', 'next_action']);
const VALID_SURFACES = new Set<DecisionMomentBridgePayload['surface']>(['border', 'pharmacy']);
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_:-]{0,79}$/;

export function isDecisionMomentBridgePayload(value: unknown): value is DecisionMomentBridgePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<DecisionMomentBridgePayload>;
  return typeof candidate.kind === 'string'
    && VALID_KINDS.has(candidate.kind as DecisionMomentBridgePayload['kind'])
    && typeof candidate.surface === 'string'
    && VALID_SURFACES.has(candidate.surface as DecisionMomentBridgePayload['surface'])
    && typeof candidate.id === 'string'
    && SAFE_IDENTIFIER.test(candidate.id);
}

type DecisionMomentWindow = Window & Record<string, unknown>;

function queueFromWindow(create: boolean): DecisionMomentBridgePayload[] | null {
  if (typeof window === 'undefined') return null;
  const host = window as unknown as DecisionMomentWindow;
  const current = host[DECISION_MOMENT_QUEUE_KEY];
  if (Array.isArray(current)) return current as DecisionMomentBridgePayload[];
  if (!create) return null;
  const queue: DecisionMomentBridgePayload[] = [];
  host[DECISION_MOMENT_QUEUE_KEY] = queue;
  return queue;
}

/** Queue and synchronously announce a payload so early static events survive shell startup. */
export function emitDecisionMomentBridge(payload: DecisionMomentBridgePayload): void {
  if (!isDecisionMomentBridgePayload(payload)) return;
  const queue = queueFromWindow(true);
  if (!queue) return;
  queue.push(payload);
  try {
    window.dispatchEvent(new CustomEvent(DECISION_MOMENT_BRIDGE_EVENT, { detail: payload }));
  } catch {
    // The queue remains available for the shell to drain when CustomEvent is unavailable.
  }
}

export function drainDecisionMomentBridgeQueue(): DecisionMomentBridgePayload[] {
  const queue = queueFromWindow(false);
  return queue ? queue.splice(0).filter(isDecisionMomentBridgePayload) : [];
}

export function removeDecisionMomentBridgePayload(payload: unknown): void {
  const queue = queueFromWindow(false);
  if (!queue) return;
  const index = queue.indexOf(payload as DecisionMomentBridgePayload);
  if (index >= 0) queue.splice(index, 1);
}
