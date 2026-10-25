import { useMemo } from 'react';
import { getContract } from '../utils/contractHelpers';

// Memoised so effects that depend on a contract do not re-run on every render.
export const useContract = (contractName, signerOrProvider) =>
  useMemo(
    () => (signerOrProvider ? getContract(contractName, signerOrProvider) : null),
    [contractName, signerOrProvider]
  );
