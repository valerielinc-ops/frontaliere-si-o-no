/**
 * Canonical categorical dimensions for the bounded G4 affiliate experiment.
 *
 * The campaign remains shared with legacy affiliate attribution for backwards
 * compatible links; `experiment_id` is the discriminator used by the L7
 * ledger, so generic affiliate clicks cannot become experiment outcomes.
 */
export const G4_EXPERIMENT_ID = 'g4-affiliate-contextual';
export const G4_EXPERIMENT_CAMPAIGN = 'g4-contextual';
export const AFFILIATE_CONTEXTUAL_CAMPAIGN = G4_EXPERIMENT_CAMPAIGN;
export const AFFILIATE_EXPERIMENT_ID_PROPERTY = 'experiment_id';
export const G4_EXPERIMENT_SESSION_ID_KEY = 'g4-affiliate-experiment-session-id';
export const G4_EXPERIMENT_VARIANT_KEY = 'g4-affiliate-experiment-variant';

export function isG4ExperimentContext(context, surface) {
  return surface === 'web' && (context === 'exchange' || context === 'banks');
}
