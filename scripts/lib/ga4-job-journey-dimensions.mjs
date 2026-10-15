// One categorical dimension fits the GA4 property quota. No random IDs.
export const JOB_JOURNEY_GA4_DIMENSIONS = Object.freeze([{
 parameterName: 'journey_context',
 displayName: 'Job Journey Context',
 description: 'UTC cohort|source|entry|stage|observed path (l=list,d=detail,g=gate,a=access,c=apply,h=handoff); no personal IDs',
}]);
