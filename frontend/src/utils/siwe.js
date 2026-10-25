import { ethers } from 'ethers';
import { api } from './api';

/**
 * Builds an EIP-4361 (Sign-In with Ethereum) message in the exact format the backend's
 * `siwe` parser expects.
 */
export function buildSiweMessage({ domain, address, statement, uri, chainId, nonce }) {
  const issuedAt = new Date().toISOString();
  return `${domain} wants you to sign in with your Ethereum account:
${ethers.getAddress(address)}

${statement}

URI: ${uri}
Version: 1
Chain ID: ${chainId}
Nonce: ${nonce}
Issued At: ${issuedAt}`;
}

/**
 * Gets a nonce for the current session, asks MetaMask to sign, and returns {message, signature}.
 */
export async function signSiwe(signer, statement = 'Sign in to GigLend.') {
  const { nonce, domain, chainId } = await api('/auth/siwe/nonce', { method: 'POST' });
  const address = await signer.getAddress();
  const message = buildSiweMessage({
    domain,
    address,
    statement,
    uri: window.location.origin,
    chainId,
    nonce,
  });
  const signature = await signer.signMessage(message);
  return { message, signature };
}
