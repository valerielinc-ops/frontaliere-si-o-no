/** Native control ownership is distinct from flattened sibling labels. Missing is not an owned contract. */
export function addressContextContract(question) {
  if (!Object.hasOwn(question || {}, 'addressContext')) return undefined;
  const context = question.addressContext;
  if (!context || typeof context !== 'object' || Array.isArray(context)
    || Object.keys(context).some(key => !['section', 'owners', 'unknown'].includes(key))
    || typeof context.section !== 'string' || context.section.length > 300
    || typeof context.unknown !== 'boolean' || !Array.isArray(context.owners) || context.owners.length > 16
    || context.owners.some(owner => typeof owner !== 'string' || owner.length > 300)) return null;
  return { section: context.section, owners: [...context.owners], unknown: context.unknown };
}

/** A valid representation is not ownership proof. This does not identify self/employer or an address purpose. */
export function hasAddressContextOwnership(question) {
  const context = addressContextContract(question);
  return context != null && context.unknown === false
    && (Boolean(context.section.trim()) || context.owners.some(owner => Boolean(owner.trim())));
}
