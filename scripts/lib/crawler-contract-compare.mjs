import { canonicalJson } from './canonical-json-digest.mjs';

// These fields are post-merge attestations refreshed by
// `reattest-crawler-contract.yml`. Do not add a new field here without an
// explicit decision: every field not listed remains contract content.
export const CONTRACT_ATTESTATION_FIELD_PATHS = Object.freeze([
  Object.freeze(['sourceCommit']),
  Object.freeze(['sourceCommitVerified']),
  Object.freeze(['artifactObservation', 'sourceCommit']),
  Object.freeze(['crawlerRosterCardinality', 'sourceCommit']),
  Object.freeze(['checkout', 'treeMb']),
]);

export function stripContractAttestation(contract) {
  const stripped = structuredClone(contract);

  for (const fieldPath of CONTRACT_ATTESTATION_FIELD_PATHS) {
    let parent = stripped;
    for (const key of fieldPath.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !(key in parent)) {
        parent = null;
        break;
      }
      parent = parent[key];
    }

    const key = fieldPath.at(-1);
    if (parent && typeof parent === 'object' && key in parent) delete parent[key];
  }

  return stripped;
}

export function contractContentEquals(committed, generated) {
  return canonicalJson(stripContractAttestation(committed))
    === canonicalJson(stripContractAttestation(generated));
}
