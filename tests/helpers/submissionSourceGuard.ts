/** Source-provider test double for transport/CAS tests; real ledger validation is tested separately. */
export const transportSourceGuard = () => ({ fingerprint: 'f'.repeat(64), assertInTransaction: async (_transaction: any) => {} });

/** Server-intent test double only; full native proof derivation is tested separately. */
export const transportOwnerIntent = () => Object.fromEntries(['idHash', 'nativeDigest', 'materialDigest', 'submitterDigest', 'assessmentHash'].map(key => [key, 'a'.repeat(64)]));
