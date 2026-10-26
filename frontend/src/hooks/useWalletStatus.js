import { useCallback, useEffect, useState } from 'react';

const EMPTY = {
  loading: true,
  memberId: 0n,
  verified: false,
  banned: false,
  expelled: false,
  defaulter: false,
  outstanding: 0n,
  settlementQuote: 0n,
};

/**
 * Identity and debt status of a wallet, read from the chain: verified (registered, attestation
 * valid, identity not banned), banned, expelled, and any unpaid default claim.
 */
export function useWalletStatus(contracts, account, refreshKey) {
  const { identityRegistry, lendingPool, defaultManager } = contracts || {};
  const [state, setState] = useState(EMPTY);

  const load = useCallback(async () => {
    if (!identityRegistry || !lendingPool || !account) {
      setState({ ...EMPTY, loading: false });
      return;
    }
    try {
      const [memberId, verified, banned, expelled, defaulter] = await Promise.all([
        identityRegistry.memberOf(account),
        identityRegistry.isVerified(account),
        identityRegistry.isBanned(account),
        lendingPool.expelled(account),
        lendingPool.isDefaulter(account),
      ]);
      let outstanding = 0n;
      let settlementQuote = 0n;
      if (memberId !== 0n && defaultManager) {
        [outstanding, settlementQuote] = await Promise.all([
          defaultManager.claimOf(memberId),
          defaultManager.settlementQuote(memberId),
        ]);
      }
      setState({ loading: false, memberId, verified, banned, expelled, defaulter, outstanding, settlementQuote });
    } catch (err) {
      console.warn('Wallet status lookup failed:', err);
      setState({ ...EMPTY, loading: false });
    }
  }, [identityRegistry, lendingPool, defaultManager, account]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return { ...state, reload: load };
}
