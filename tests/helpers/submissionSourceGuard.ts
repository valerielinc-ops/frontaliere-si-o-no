/** Source-provider test double for transport/CAS tests; real ledger validation is tested separately. */
export const transportSourceGuard = () => ({ fingerprint: 'f'.repeat(64), assertInTransaction: async (_transaction: any) => {} });
