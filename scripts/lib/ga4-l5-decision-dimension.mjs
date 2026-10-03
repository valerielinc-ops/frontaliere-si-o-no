export const L5_DECISION_SESSION_PARAMETER = 'decision_session_id';
export const L5_DECISION_SESSION_DIMENSION_API_NAME = `customEvent:${L5_DECISION_SESSION_PARAMETER}`;

export const L5_DECISION_SESSION_DIMENSION = Object.freeze({
  parameterName: L5_DECISION_SESSION_PARAMETER,
  displayName: 'Decision Session ID',
  description: 'Opaque browser-session and GA4-session join key for L5 decision-moment events',
});
