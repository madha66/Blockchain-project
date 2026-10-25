import { useCallback, useEffect, useState } from 'react';

export const TIER_NAMES = ['New', 'Builder', 'Standard', 'Trusted', 'Prime'];

/**
 * On-chain membership for the connected wallet: memberId, member record and eligibility.
 */
export function useMembership(identityRegistry, account, refreshKey) {
  const [state, setState] = useState({ loading: true, memberId: 0n, member: null, eligible: false, reason: '' });

  const load = useCallback(async () => {
    if (!identityRegistry || !account) {
      setState({ loading: false, memberId: 0n, member: null, eligible: false, reason: 'Not connected' });
      return;
    }
    try {
      const memberId = await identityRegistry.memberOf(account);
      if (memberId === 0n) {
        setState({ loading: false, memberId, member: null, eligible: false, reason: 'Not registered' });
        return;
      }
      const [member, [eligible, reason]] = await Promise.all([
        identityRegistry.getMember(memberId),
        identityRegistry.eligibility(account),
      ]);
      setState({ loading: false, memberId, member, eligible, reason });
    } catch (err) {
      console.warn('Membership lookup failed:', err);
      setState({ loading: false, memberId: 0n, member: null, eligible: false, reason: 'Registry unavailable' });
    }
  }, [identityRegistry, account]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return { ...state, reload: load };
}
