// MetaMask-free local demo wallet. Development builds only, opt-in with ?devwallet=<n>,
// where n is a Hardhat test-account index (the node keeps those accounts unlocked).
// It is a thin EIP-1193 bridge to the local JSON-RPC node and is never bundled into a
// production build's behaviour (guarded by import.meta.env.DEV).

const STORAGE_KEY = 'giglend.devwallet';

export function installDevWallet() {
  if (!import.meta.env.DEV) return;

  let index = new URLSearchParams(window.location.search).get('devwallet');
  try {
    if (index !== null) sessionStorage.setItem(STORAGE_KEY, index);
    else index = sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // storage unavailable: only the URL parameter works
  }
  if (index === null || index === 'off' || window.ethereum) return;

  const rpcUrl = import.meta.env.VITE_RPC_HTTP_URL || 'http://127.0.0.1:8545';
  let id = 0;
  const rpc = async (method, params = []) => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const body = await res.json();
    if (body.error) {
      const err = new Error(body.error.message);
      err.code = body.error.code;
      err.data = body.error.data;
      throw err;
    }
    return body.result;
  };

  let account = null;
  const accounts = async () => {
    if (!account) account = (await rpc('eth_accounts'))[Number(index)];
    return account ? [account] : [];
  };

  window.ethereum = {
    isGigLendDevWallet: true,
    async request({ method, params }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return accounts();
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
      return rpc(method, params);
    },
    on() {},
    removeListener() {},
  };
  console.info(`[dev-wallet] Hardhat account #${index} via ${rpcUrl} (development only)`);
}
