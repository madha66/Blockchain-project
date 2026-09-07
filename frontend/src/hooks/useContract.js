import { getContract } from '../utils/contractHelpers';

export const useContract = (contractName, signerOrProvider) => {
  if (!signerOrProvider) return null;
  return getContract(contractName, signerOrProvider);
};
