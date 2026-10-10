import { useState, useEffect, useCallback, useRef } from 'react';
import { ethers } from 'ethers';
import { getContract, getSyncProvider, CONTRACT_ADDRESSES } from '../utils/contractHelpers';

/**
 * Hook for cross-client blockchain event synchronization.
 * Supports WebSocket provider with HTTP polling fallback,
 * historical backfilling from starting block, event deduplication,
 * and reactive refresh triggers.
 */
export const useEventSync = (walletProvider) => {
  const [events, setEvents] = useState([]);
  const [syncTick, setSyncTick] = useState(0);
  const [isLive, setIsLive] = useState(false);
  const [connectionMode, setConnectionMode] = useState('initializing'); // 'ws' | 'http' | 'none'
  const seenEventKeys = useRef(new Set());
  const providerRef = useRef(null);

  const processLog = useCallback(async (contractInterface, log) => {
    try {
      const parsed = contractInterface.parseLog(log);
      if (!parsed) return null;

      const txHash = log.transactionHash;
      const logIndex = log.index ?? log.logIndex ?? 0;
      const key = `${txHash}-${logIndex}`;

      if (seenEventKeys.current.has(key)) {
        return null; // Deduplicate
      }
      seenEventKeys.current.add(key);

      const block = await log.getBlock().catch(() => null);
      const timestamp = block?.timestamp 
        ? new Date(Number(block.timestamp) * 1000).toLocaleString() 
        : new Date().toLocaleTimeString();

      const args = parsed.args;
      let type = 'unknown';
      let user = '';
      let amountEth = '0.0000';
      let details = '';

      if (parsed.name === 'Deposited') {
        type = 'deposit';
        user = args.user;
        amountEth = ethers.formatEther(args.amount);
        details = `Minted ${ethers.formatEther(args.shares)} GLP`;
      } else if (parsed.name === 'Borrowed') {
        type = 'borrow';
        user = args.user;
        amountEth = ethers.formatEther(args.amount);
        const apr = (Number(args.interestRateBps) / 100).toFixed(2);
        details = `Tenure ${args.tenureDays}d @ ${apr}% APR`;
      } else if (parsed.name === 'Repaid') {
        type = 'repay';
        user = args.user;
        amountEth = ethers.formatEther(args.amount);
        const refund = args.refund > 0n ? ` (Refund: ${ethers.formatEther(args.refund)} ETH)` : '';
        details = `Principal ${ethers.formatEther(args.principalPaid)} ETH, Interest ${ethers.formatEther(args.interestPaid)} ETH${refund}`;
      } else if (parsed.name === 'Withdrawn') {
        type = 'withdraw';
        user = args.user;
        amountEth = ethers.formatEther(args.ethAmount);
        details = `Burned ${ethers.formatEther(args.glpBurned)} GLP`;
      } else if (parsed.name === 'DefaultSettled') {
        type = 'default';
        user = args.borrower;
        amountEth = ethers.formatEther(args.writtenOffPrincipal);
        details = `Burned ${ethers.formatEther(args.sharesBurned)} GLP, Written off: ${ethers.formatEther(args.writtenOffPrincipal)} ETH`;
      } else if (parsed.name === 'DebtRecovered') {
        type = 'recovery';
        user = args.borrower;
        amountEth = ethers.formatEther(args.totalRecovered);
        details = `Reserve repaid: ${ethers.formatEther(args.reserveReplenished)} ETH, Memo cleared: ${ethers.formatEther(args.memoCleared)} ETH`;
      }

      return {
        id: key,
        txHash,
        logIndex,
        blockNumber: log.blockNumber,
        name: parsed.name,
        type,
        user,
        amount: `${Number(amountEth).toFixed(4)} ETH`,
        details,
        timestamp,
      };
    } catch (err) {
      console.warn('Error parsing log in useEventSync:', err);
      return null;
    }
  }, []);

  useEffect(() => {
    let active = true;
    let fallbackPollInterval = null;

    const setupSync = async () => {
      seenEventKeys.current.clear();
      setEvents([]);

      // 1. Get synchronization provider (WebSocket if configured, or HTTP fallback)
      const { provider: syncProvider, mode } = getSyncProvider(walletProvider);
      providerRef.current = syncProvider;
      setConnectionMode(mode);

      if (!syncProvider) {
        setIsLive(false);
        return;
      }

      try {
        // 2. Target network chain ID validation
        const targetChainId = import.meta.env.VITE_CHAIN_ID ? BigInt(import.meta.env.VITE_CHAIN_ID) : 31337n;
        const network = await syncProvider.getNetwork().catch(() => null);
        if (network && network.chainId !== targetChainId) {
          console.warn(`Chain mismatch: expected ${targetChainId}, got ${network.chainId}`);
          setConnectionMode('chain-mismatch');
          setIsLive(false);
          return;
        }

        const poolContract = getContract('LendingPool', syncProvider);
        const iface = poolContract.interface;

        // 3. Historical event backfill from starting block
        const fromBlock = import.meta.env.VITE_START_BLOCK ? Number(import.meta.env.VITE_START_BLOCK) : 0;
        
        const filter = {
          address: CONTRACT_ADDRESSES.LendingPool,
          fromBlock: Math.max(0, fromBlock),
          toBlock: 'latest',
        };

        const historicalLogs = await syncProvider.getLogs(filter).catch((err) => {
          console.warn('Historical log query fallback:', err);
          return [];
        });

        if (active && historicalLogs.length > 0) {
          const parsedList = [];
          for (const log of historicalLogs) {
            if (!log.removed) {
              const item = await processLog(iface, log);
              if (item) parsedList.push(item);
            }
          }
          parsedList.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
          setEvents(parsedList);
          setSyncTick((t) => t + 1);
        }

        // 4. Real-time event subscription with reorg / removed-log handling
        const handleNewLog = async (log) => {
          if (!active) return;
          const txHash = log.transactionHash;
          const logIndex = log.index ?? log.logIndex ?? 0;
          const key = `${txHash}-${logIndex}`;

          if (log.removed) {
            seenEventKeys.current.delete(key);
            setEvents((prev) => prev.filter((e) => e.id !== key));
            setSyncTick((t) => t + 1);
            return;
          }

          const parsed = await processLog(iface, log);
          if (parsed) {
            setEvents((prev) => [parsed, ...prev.filter((e) => e.id !== parsed.id)]);
            setSyncTick((t) => t + 1); // Trigger cross-client state refresh
          }
        };

        const liveFilter = {
          address: CONTRACT_ADDRESSES.LendingPool,
        };

        syncProvider.on(liveFilter, handleNewLog);
        setIsLive(true);

        // Fallback polling for HTTP providers where live socket events are not supported
        if (mode === 'http') {
          fallbackPollInterval = setInterval(async () => {
            if (!active) return;
            try {
              const currentBlock = await syncProvider.getBlockNumber();
              const recentLogs = await syncProvider.getLogs({
                address: CONTRACT_ADDRESSES.LendingPool,
                fromBlock: Math.max(0, currentBlock - 5),
                toBlock: 'latest',
              });
              let added = false;
              for (const log of recentLogs) {
                const item = await processLog(iface, log);
                if (item) {
                  setEvents((prev) => [item, ...prev.filter((e) => e.id !== item.id)]);
                  added = true;
                }
              }
              if (added) {
                setSyncTick((t) => t + 1);
              }
            } catch {
              // Ignore background poll errors
            }
          }, 3000);
        }
      } catch (err) {
        console.warn('Failed to initialize event synchronization:', err);
        setIsLive(false);
      }
    };

    setupSync();

    return () => {
      active = false;
      if (fallbackPollInterval) clearInterval(fallbackPollInterval);
      if (providerRef.current) {
        providerRef.current.removeAllListeners();
      }
      setIsLive(false);
    };
  }, [walletProvider, processLog]);

  return { events, syncTick, isLive, connectionMode };
};
