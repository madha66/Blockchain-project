import { ethers } from 'ethers';

import LendingPoolABI from '../contracts/LendingPool.json';
import CreditScoreABI from '../contracts/CreditScore.json';
import GLPTokenABI from '../contracts/GLPToken.json';

export const CONTRACT_ADDRESSES = {
  LendingPool: '0x82e01223d51Eb87e16A03E24687EDF0F294da6f1',
  CreditScore: '0xCD8a1C3ba11CF5ECfa6267617243239504a98d90',
  GLPToken: '0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575',
};

export const getContract = (name, providerOrSigner) => {
  let abi;
  if (name === 'LendingPool') abi = LendingPoolABI.abi;
  else if (name === 'CreditScore') abi = CreditScoreABI.abi;
  else if (name === 'GLPToken') abi = GLPTokenABI.abi;

  const address = CONTRACT_ADDRESSES[name];
  return new ethers.Contract(address, abi, providerOrSigner);
};
