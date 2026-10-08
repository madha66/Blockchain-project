import { ethers } from 'ethers';

import LendingPoolABI from '../contracts/LendingPool.json';
import CreditScoreABI from '../contracts/CreditScore.json';
import GLPTokenABI from '../contracts/GLPToken.json';

export const CONTRACT_ADDRESSES = {
  LendingPool: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  CreditScore: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  GLPToken: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
};

export const getContract = (name, providerOrSigner) => {
  let abi;
  if (name === 'LendingPool') abi = LendingPoolABI.abi;
  else if (name === 'CreditScore') abi = CreditScoreABI.abi;
  else if (name === 'GLPToken') abi = GLPTokenABI.abi;

  const address = CONTRACT_ADDRESSES[name];
  return new ethers.Contract(address, abi, providerOrSigner);
};
