/**
 * Conservative, deterministic decisions for the Instagram creative loop.
 *
 * The collector and scorecard deliberately keep objectives separate. This
 * module is the next layer: it promotes a creative variant only when there
 * are at least two comparable variants, each has the minimum number of
 * independent observations, and the leader clears both a relative and an
 * absolute lift. A zero-signal or underpowered test never picks a winner.
 *
 * Content variants are pooled across the randomized background arms. This is
 * intentional: the background assignment is a separate experiment and the
 * creative decision should not wait for one exact visual arm. Both maps remain
 * objective-scoped: creative winners use kind + base id + objective, while
 * background winners use kind + creative id + objective.
 */

export const DECISION_SCHEMA_VERSION = 2;
export const DEFAULT_DECISION_WINDOW_HOURS = 72;
export const DEFAULT_MINIMUM_OBSERVATIONS = 3;
export const DEFAULT_MIN_RELATIVE_LIFT = 0.15;
export const DEFAULT_MIN_ABSOLUTE_LIFT = 0.005;
const LEGACY_OBJECTIVE_KEY = '__legacy__';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function text(value) {
  const result = String(value ?? '').trim();
  return result || null;
}

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = finiteNumber(value, fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value, fallback) {
  const parsed = finiteNumber(value, fallback);
  return parsed >= 0 ? parsed : fallback;
}

function booleanValue(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'on') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'off') return false;
  return fallback;
}

function parseJsonObject(value) {
  if (isRecord(value)) return value;
  const raw = String(value ?? '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function creativeWinnerMap(value) {
  const source = parseJsonObject(value);
  const result = {};
  for (const [outerKey, outerValue] of Object.entries(source)) {
    if (!isRecord(outerValue)) continue;
    const bases = {};
    for (const [baseKey, baseValue] of Object.entries(outerValue)) {
      const legacy = !isRecord(baseValue) && !Array.isArray(baseValue) ? text(baseValue) : null;
      if (legacy) {
        bases[String(baseKey)] = { [LEGACY_OBJECTIVE_KEY]: legacy };
        continue;
      }
      if (!isRecord(baseValue)) continue;
      const objectives = {};
      for (const [objectiveKey, winnerValue] of Object.entries(baseValue)) {
        const clean = text(winnerValue);
        if (clean) objectives[String(objectiveKey)] = clean;
      }
      if (Object.keys(objectives).length) bases[String(baseKey)] = objectives;
    }
    if (Object.keys(bases).length) result[String(outerKey)] = bases;
  }
  return result;
}

function stringMap(value) {
  const source = parseJsonObject(value);
  const result = {};
  for (const [key, item] of Object.entries(source)) {
    const clean = text(item);
    if (clean) result[String(key)] = clean;
  }
  return result;
}

function sortObject(value) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function sortNestedObject(value) {
  return Object.fromEntries(
    Object.entries(value || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortObject(nested)]),
  );
}

function sortCreativeWinnerMap(value) {
  return Object.fromEntries(
    Object.entries(value || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, bases]) => [kind, sortNestedObject(bases)]),
  );
}

function creativeWinnerKey({ kind, baseId, objective } = {}) {
  return [text(kind) || 'unknown', text(baseId) || 'unknown', text(objective) || 'unknown'].join(':');
}

function backgroundWinnerKey({ kind, creativeId, objective } = {}) {
  return [text(kind) || 'unknown', text(creativeId) || 'unknown', text(objective) || 'unknown'].join(':');
}

function legacyBackgroundWinnerKey({ kind, creativeId } = {}) {
  return [text(kind) || 'unknown', text(creativeId) || 'unknown'].join(':');
}

function setCreativeWinner(map, { kind, baseId, objective, winner } = {}) {
  const cleanKind = text(kind);
  const cleanBaseId = text(baseId);
  const cleanObjective = text(objective);
  const cleanWinner = text(winner);
  if (!cleanKind || !cleanBaseId || !cleanObjective || !cleanWinner) return;
  map[cleanKind] ||= {};
  const base = isRecord(map[cleanKind][cleanBaseId]) ? map[cleanKind][cleanBaseId] : {};
  delete base[LEGACY_OBJECTIVE_KEY];
  base[cleanObjective] = cleanWinner;
  map[cleanKind][cleanBaseId] = base;
}

function clearCreativeWinner(map, { kind, baseId, objective } = {}) {
  const cleanKind = text(kind);
  const cleanBaseId = text(baseId);
  const cleanObjective = text(objective);
  if (!cleanKind || !cleanBaseId || !cleanObjective) return;
  const bases = map[cleanKind];
  const current = bases?.[cleanBaseId];
  if (!current) return;
  if (!isRecord(current)) {
    delete bases[cleanBaseId];
  } else {
    delete current[cleanObjective];
    delete current[LEGACY_OBJECTIVE_KEY];
    if (!Object.keys(current).length) delete bases[cleanBaseId];
  }
  if (bases && !Object.keys(bases).length) delete map[cleanKind];
}

function comparisonCreativeScope(comparison) {
  return {
    kind: comparison?.kind,
    baseId: comparison?.baseId,
    objective: comparison?.objective,
  };
}

function comparisonBackgroundScope(comparison) {
  return {
    kind: comparison?.kind,
    creativeId: comparison?.creativeId,
    objective: comparison?.objective,
  };
}

export function resolveInstagramDecisionConfig(env = process.env) {
  return {
    enabled: booleanValue(env.INSTAGRAM_INSIGHTS_AUTONOMOUS_DECISIONS_ENABLED, false),
    windowHours: positiveInteger(env.INSTAGRAM_INSIGHTS_DECISION_WINDOW_HOURS, DEFAULT_DECISION_WINDOW_HOURS),
    minimumObservations: positiveInteger(env.INSTAGRAM_INSIGHTS_MIN_OBSERVATIONS, DEFAULT_MINIMUM_OBSERVATIONS),
    minimumRelativeLift: nonNegativeNumber(env.INSTAGRAM_INSIGHTS_MIN_RELATIVE_LIFT, DEFAULT_MIN_RELATIVE_LIFT),
    minimumAbsoluteLift: nonNegativeNumber(env.INSTAGRAM_INSIGHTS_MIN_ABSOLUTE_LIFT, DEFAULT_MIN_ABSOLUTE_LIFT),
    currentCreativeWinners: creativeWinnerMap(env.INSTAGRAM_AUTONOMOUS_CREATIVE_WINNERS),
    currentBackgroundWinners: stringMap(env.INSTAGRAM_CAROUSEL_BACKGROUND_AB_WINNERS),
  };
}

function baseIdForTreatment(treatment) {
  return text(treatment?.creativeBaseId)
    || text(treatment?.creativeId)?.split('-', 1)[0]
    || 'unknown';
}

function treatmentWindow(treatment) {
  return finiteNumber(treatment?.windowHours, null);
}

function treatmentBackground(treatment) {
  return text(treatment?.backgroundVariant) || 'legacy';
}

function addAggregate(map, key, treatment, { includeBackground = false } = {}) {
  const existing = map.get(key) || {
    creativeId: text(treatment.creativeId) || 'unknown',
    creativeBaseId: baseIdForTreatment(treatment),
    creativeLabel: text(treatment.creativeLabel),
    objective: text(treatment.objective),
    primaryMetric: text(treatment.primaryMetric),
    kind: text(treatment.kind) || 'unknown',
    windowHours: treatmentWindow(treatment),
    backgroundVariant: includeBackground ? treatmentBackground(treatment) : null,
    observations: 0,
    primaryTotal: 0,
    reach: 0,
    primaryRate: 0,
    backgroundVariants: new Set(),
  };
  existing.observations += Number(treatment.observations) || 0;
  existing.primaryTotal += Number(treatment.primaryTotal) || 0;
  existing.reach += Number(treatment.reach) || 0;
  existing.primaryRate = existing.reach > 0 ? existing.primaryTotal / existing.reach : 0;
  existing.backgroundVariants.add(treatmentBackground(treatment));
  map.set(key, existing);
  return existing;
}

function serializeAggregate(candidate) {
  return {
    creativeId: candidate.creativeId,
    creativeBaseId: candidate.creativeBaseId,
    creativeLabel: candidate.creativeLabel,
    objective: candidate.objective,
    primaryMetric: candidate.primaryMetric,
    kind: candidate.kind,
    windowHours: candidate.windowHours,
    backgroundVariant: candidate.backgroundVariant === 'legacy' ? null : candidate.backgroundVariant,
    backgroundVariants: [...candidate.backgroundVariants].sort(),
    observations: candidate.observations,
    primaryTotal: candidate.primaryTotal,
    reach: candidate.reach,
    primaryRate: candidate.primaryRate,
    eligible: candidate.eligible,
  };
}

function compareCandidates(candidates, {
  minimumObservations,
  minimumRelativeLift,
  minimumAbsoluteLift,
  type,
  key,
  winnerKey,
  scope,
} = {}) {
  const eligible = candidates
    .map((candidate) => ({ ...candidate, eligible: candidate.observations >= minimumObservations }))
    .sort((a, b) => b.primaryRate - a.primaryRate || b.primaryTotal - a.primaryTotal || a.creativeId.localeCompare(b.creativeId));
  const comparable = eligible.filter((candidate) => candidate.eligible);
  const base = {
    type,
    key,
    winnerKey,
    ...scope,
    candidates: eligible.map(serializeAggregate),
    eligibleCandidates: comparable.length,
    minimumObservations,
    minimumRelativeLift,
    minimumAbsoluteLift,
  };

  if (comparable.length < 2) {
    return {
      ...base,
      status: comparable.length === 0 ? 'needs-observations' : 'needs-comparator',
      reason: comparable.length === 0
        ? 'nessuna variante ha raggiunto il minimo di osservazioni indipendenti'
        : 'serve almeno una seconda variante eleggibile per un confronto',
      winner: null,
      runnerUp: null,
      relativeLift: null,
      absoluteLift: null,
    };
  }

  const winner = comparable[0];
  const runnerUp = comparable[1];
  const absoluteLift = winner.primaryRate - runnerUp.primaryRate;
  const relativeLift = runnerUp.primaryRate > 0
    ? absoluteLift / runnerUp.primaryRate
    : winner.primaryRate > 0 ? 1 : 0;
  if (winner.primaryRate <= 0) {
    return {
      ...base,
      status: 'insufficient-signal',
      reason: 'la metrica primaria è zero per tutte le varianti eleggibili',
      winner: serializeAggregate(winner),
      runnerUp: serializeAggregate(runnerUp),
      relativeLift,
      absoluteLift,
    };
  }

  const passesRelative = relativeLift >= minimumRelativeLift;
  const passesAbsolute = absoluteLift >= minimumAbsoluteLift;
  return {
    ...base,
    status: passesRelative && passesAbsolute ? 'winner' : 'insufficient-lift',
    reason: passesRelative && passesAbsolute
      ? 'la variante leader supera la seconda con il margine configurato'
      : 'il margine osservato non supera entrambe le soglie configurate',
    winner: serializeAggregate(winner),
    runnerUp: serializeAggregate(runnerUp),
    relativeLift,
    absoluteLift,
  };
}

function creativeComparisons(report, options) {
  const groups = new Map();
  for (const treatment of report?.treatments || []) {
    if (treatmentWindow(treatment) !== options.windowHours) continue;
    const kind = text(treatment.kind) || 'unknown';
    const baseId = baseIdForTreatment(treatment);
    const objective = text(treatment.objective) || 'unknown';
    const key = [kind, baseId, objective, options.windowHours].join('\u0000');
    const candidateKey = text(treatment.creativeId) || 'unknown';
    const group = groups.get(key) || { kind, baseId, objective, candidates: new Map() };
    addAggregate(
      group.candidates,
      candidateKey,
      treatment,
      {},
    );
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => compareCandidates([...group.candidates.values()], {
      ...options,
      type: 'creative',
      key,
      winnerKey: creativeWinnerKey({ kind: group.kind, baseId: group.baseId, objective: group.objective }),
      scope: { kind: group.kind, baseId: group.baseId, objective: group.objective },
    }));
}

function backgroundComparisons(report, options) {
  const groups = new Map();
  for (const treatment of report?.treatments || []) {
    if (treatmentWindow(treatment) !== options.windowHours) continue;
    if (!text(treatment.backgroundVariant)) continue;
    const kind = text(treatment.kind) || 'unknown';
    const creativeId = text(treatment.creativeId) || 'unknown';
    const objective = text(treatment.objective) || 'unknown';
    const key = [kind, creativeId, objective, options.windowHours].join('\u0000');
    const group = groups.get(key) || { kind, creativeId, objective, candidates: new Map() };
    const candidateKey = treatmentBackground(treatment);
    addAggregate(group.candidates, candidateKey, treatment, { includeBackground: true });
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => compareCandidates([...group.candidates.values()], {
      ...options,
      type: 'background',
      key,
      winnerKey: backgroundWinnerKey({ kind: group.kind, creativeId: group.creativeId, objective: group.objective }),
      scope: { kind: group.kind, creativeId: group.creativeId, objective: group.objective },
    }));
}

export function buildAutonomousDecisions(report, {
  windowHours = DEFAULT_DECISION_WINDOW_HOURS,
  minimumObservations = DEFAULT_MINIMUM_OBSERVATIONS,
  minimumRelativeLift = DEFAULT_MIN_RELATIVE_LIFT,
  minimumAbsoluteLift = DEFAULT_MIN_ABSOLUTE_LIFT,
} = {}) {
  const options = {
    windowHours: positiveInteger(windowHours, DEFAULT_DECISION_WINDOW_HOURS),
    minimumObservations: positiveInteger(minimumObservations, DEFAULT_MINIMUM_OBSERVATIONS),
    minimumRelativeLift: nonNegativeNumber(minimumRelativeLift, DEFAULT_MIN_RELATIVE_LIFT),
    minimumAbsoluteLift: nonNegativeNumber(minimumAbsoluteLift, DEFAULT_MIN_ABSOLUTE_LIFT),
  };
  const creative = creativeComparisons(report, options);
  const background = backgroundComparisons(report, options);
  const creativeWinners = {};
  const backgroundWinners = {};
  for (const comparison of creative) {
    if (comparison.status === 'winner') {
      setCreativeWinner(creativeWinners, {
        ...comparisonCreativeScope(comparison),
        winner: comparison.winner.creativeId,
      });
    }
  }
  for (const comparison of background) {
    if (comparison.status === 'winner') {
      backgroundWinners[comparison.winnerKey] = comparison.winner.backgroundVariant;
    }
  }
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    windowHours: options.windowHours,
    minimumObservations: options.minimumObservations,
    minimumRelativeLift: options.minimumRelativeLift,
    minimumAbsoluteLift: options.minimumAbsoluteLift,
    creativeComparisons: creative,
    backgroundComparisons: background,
    creativeWinners: sortCreativeWinnerMap(creativeWinners),
    backgroundWinners: sortObject(backgroundWinners),
    winnerCount: Object.values(creativeWinners).reduce(
      (sum, bases) => sum + Object.values(bases).reduce((baseSum, objectives) => baseSum + Object.keys(objectives).length, 0),
      0,
    )
      + Object.keys(backgroundWinners).length,
  };
}

export function mergeAutonomousDecisionState({
  currentCreativeWinners = {},
  currentBackgroundWinners = {},
  decisions = {},
} = {}) {
  const creativeWinners = creativeWinnerMap(currentCreativeWinners);
  const backgroundWinners = stringMap(currentBackgroundWinners);
  const creativeComparisons = Array.isArray(decisions.creativeComparisons) ? decisions.creativeComparisons : null;
  for (const comparison of creativeComparisons || []) {
    const scope = comparisonCreativeScope(comparison);
    clearCreativeWinner(creativeWinners, scope);
    if (comparison.status === 'winner') {
      setCreativeWinner(creativeWinners, { ...scope, winner: comparison.winner?.creativeId });
    }
  }
  if (!creativeComparisons) {
    const incoming = creativeWinnerMap(decisions.creativeWinners);
    for (const [kind, bases] of Object.entries(incoming)) {
      for (const [baseId, objectives] of Object.entries(bases)) {
        for (const [objective, winner] of Object.entries(objectives)) {
          if (objective !== LEGACY_OBJECTIVE_KEY) setCreativeWinner(creativeWinners, { kind, baseId, objective, winner });
        }
      }
    }
  }
  const backgroundComparisons = Array.isArray(decisions.backgroundComparisons) ? decisions.backgroundComparisons : null;
  for (const comparison of backgroundComparisons || []) {
    const scope = comparisonBackgroundScope(comparison);
    delete backgroundWinners[backgroundWinnerKey(scope)];
    delete backgroundWinners[legacyBackgroundWinnerKey(scope)];
    if (comparison.status === 'winner') {
      backgroundWinners[backgroundWinnerKey(scope)] = comparison.winner?.backgroundVariant;
    }
  }
  if (!backgroundComparisons) {
    for (const [key, value] of Object.entries(stringMap(decisions.backgroundWinners))) {
      backgroundWinners[key] = value;
    }
  }
  return {
    creativeWinners: sortCreativeWinnerMap(creativeWinners),
    backgroundWinners: sortObject(backgroundWinners),
  };
}

export function decisionStateChanges(current, next) {
  const changes = [];
  const currentCreative = JSON.stringify(sortCreativeWinnerMap(creativeWinnerMap(current?.creativeWinners)));
  const nextCreative = JSON.stringify(sortCreativeWinnerMap(creativeWinnerMap(next?.creativeWinners)));
  if (currentCreative !== nextCreative) {
    changes.push({ parameter: 'INSTAGRAM_AUTONOMOUS_CREATIVE_WINNERS', value: nextCreative });
  }
  const currentBackground = JSON.stringify(sortObject(stringMap(current?.backgroundWinners)));
  const nextBackground = JSON.stringify(sortObject(stringMap(next?.backgroundWinners)));
  if (currentBackground !== nextBackground) {
    changes.push({ parameter: 'INSTAGRAM_CAROUSEL_BACKGROUND_AB_WINNERS', value: nextBackground });
  }
  return changes;
}
