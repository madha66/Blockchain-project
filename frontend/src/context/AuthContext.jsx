import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';
import { signSiwe } from '../utils/siwe';

const AuthContext = createContext(null);

/**
 * Session state from the backend (`/api/auth/me`). scope is "signup" (wizard in progress),
 * "preauth" (password ok, SIWE pending) or "full".
 */
export function AuthProvider({ children, account }) {
  const [user, setUser] = useState(null);
  const [scope, setScope] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api('/auth/me');
      setUser(me.user);
      setScope(me.scope);
      return me;
    } catch {
      setUser(null);
      setScope(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(
    async ({ identifier, password, otp }) => {
      const res = await api('/auth/login', { method: 'POST', body: { identifier, password, otp } });
      await refresh();
      return res;
    },
    [refresh]
  );

  const completeSiweLogin = useCallback(
    async (signer) => {
      const signed = await signSiwe(signer, 'Log in to GigLend with your linked wallet.');
      await api('/auth/siwe/verify', { method: 'POST', body: signed });
      return refresh();
    },
    [refresh]
  );

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    setScope(null);
  }, []);

  const walletMismatch = Boolean(
    user?.wallet && account && scope === 'full' && account.toLowerCase() !== user.wallet.toLowerCase()
  );

  const value = useMemo(
    () => ({
      user,
      scope,
      loading,
      isLoggedIn: scope === 'full',
      walletMismatch,
      refresh,
      login,
      completeSiweLogin,
      logout,
    }),
    [user, scope, loading, walletMismatch, refresh, login, completeSiweLogin, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
