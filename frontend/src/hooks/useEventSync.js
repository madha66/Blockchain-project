import { useState, useEffect, useCallback, useRef } from 'react';
import { ethers } from 'ethers';
import { getContract, getSyncProvider, CONTRACT_ADDRESSES } from '../utils/contractHelpers';

// Every contract whose events feed the Dashboard, Pool and Transactions pages.
const WATCHED = [
  'LendingPool',
  'LoanManager',
  'DefaultManager',
  'IdentityRegistry',
  'CreditScore',
  'ReserveFund',
  'PolicyConfig',
  'MockPayoutRouter',
];

const DTYPES = ['None', 'Hardship', 'Strategic', 'Fraud'];
const OPTIONS = ['None', 'Payment holiday', 'Tenure stretch'];
const eth = (wei) => `${Number(ethers.formatEther(wei ?? 0n)).toFixed(4)} ETH`;
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

/**
 * Maps a parsed log to { type, label, user, amount, details }. `type` drives the filter pills
 * and badge colour; unknown events return null and are ignored.
 */
function describe(name, a) {
  switch (name) {
    case 'Deposited':
      return { type: 'deposit', user: a.user, amount: eth(a.amount), details: `Minted ${eth(a.shares).replace(' ETH', ' GLP')}` };
    case 'Withdrawn':
      return { type: 'withdraw', user: a.user, amount: eth(a.ethAmount), details: `Burned ${eth(a.glpBurned).replace(' ETH', ' GLP')}` };
    case 'WithdrawalQueued':
      return { type: 'withdraw', label: 'queued', user: a.user, amount: eth(a.shares).replace(' ETH', ' GLP'), details: `Joined the withdrawal queue at #${a.queueIndex}` };
    case 'WithdrawalPaid':
      return { type: 'withdraw', label: 'queue paid', user: a.user, amount: eth(a.ethAmount), details: `Pro rata payout · ${eth(a.sharesRemaining).replace(' ETH', ' GLP')} still queued` };
    case 'ResidualSwept':
      return { type: 'recovery', user: a.user, amount: eth(a.amount), details: `50% of a deposit applied to member #${a.memberId}'s claim` };
    case 'Borrowed':
      return { type: 'borrow', user: a.user, amount: eth(a.amount), details: `${a.tenureDays} days @ ${(Number(a.interestRateBps) / 100).toFixed(2)}% APR` };
    case 'LoanOpened':
      return { type: 'borrow', label: Number(a.kind) === 0 ? 'builder' : 'unsecured', user: a.borrower, amount: eth(a.principal), details: `Loan #${a.loanId}: ${a.nInstallments} × ${eth(a.installment)} every ${a.periodDays} days` };
    case 'Repaid':
      return { type: 'repay', user: a.user, amount: eth(a.amount), details: `Principal ${eth(a.principalPaid)}, interest ${eth(a.interestPaid)}${a.refund > 0n ? `, refund ${eth(a.refund)}` : ''}` };
    case 'LoanRepaid':
      return { type: 'repay', label: 'loan closed', amount: '', details: `Loan #${a.loanId} fully repaid` };
    case 'EscrowReleased':
      return { type: 'repay', label: 'escrow', user: a.borrower, amount: eth(a.amount), details: `Builder escrow released for loan #${a.loanId}` };
    case 'LoanExited':
      return { type: 'repay', label: 'exit', amount: '', details: `Loan #${a.loanId} returned within the penalty-free window` };
    case 'SweepApplied':
      return { type: 'repay', label: 'sweep', amount: eth(a.amount), details: `Income sweep into loan #${a.loanId}` };
    case 'AutopayCollected':
      return { type: 'repay', label: 'autopay', amount: eth(a.amount), details: `SafeRepay pull for loan #${a.loanId}` };
    case 'InstallmentMissed':
      return { type: 'late', label: 'missed', amount: '', details: `Loan #${a.loanId} installment ${a.number} missed` };
    case 'LateFeeCharged':
      return { type: 'late', label: 'late fee', amount: eth(a.fee), details: `Loan #${a.loanId} installment ${a.number} (once, never compounding)` };
    case 'StakeApplied':
      return { type: 'late', label: 'stake applied', user: a.account, amount: eth(a.value), details: `${a.guarantor ? 'Guarantor' : 'Borrower'} stake applied to loan #${a.loanId}` };
    case 'BountyPaid':
      return a.loanId !== undefined
        ? { type: 'late', label: 'bounty', user: a.caller, amount: eth(a.amount), details: `Keeper bounty for loan #${a.loanId}` }
        : null;
    case 'RestructureGranted':
      return { type: 'restructure', amount: eth(a.fee), details: `Loan #${a.loanId}: ${OPTIONS[Number(a.option)]}, next due ${new Date(Number(a.nextDueDate) * 1000).toLocaleDateString()}` };
    case 'ShockModeSet':
      return { type: 'restructure', label: 'shock mode', amount: '', details: `Cohort ${a.cohortId} until ${new Date(Number(a.until) * 1000).toLocaleDateString()}` };
    case 'LoanDefaulted':
      return { type: 'default', amount: eth(a.lenderLoss), details: `Loan #${a.loanId} · ${DTYPES[Number(a.defaultType)]} · stake ${eth(a.stakeUsed)}, guarantor ${eth(a.guarantorUsed)}, reserve ${eth(a.reserveUsed)}, lender loss ${eth(a.lenderLoss)}` };
    case 'ClaimSettled':
      return { type: 'recovery', label: a.fullySettled ? 'settled' : 'claim payment', amount: eth(a.paid), details: `Member #${a.memberId}${a.discount > 0n ? `, discount ${eth(a.discount)}` : ''}` };
    case 'ClaimRecovered':
      return { type: 'recovery', amount: eth(a.amount), details: `Member #${a.memberId}: reserve refilled ${eth(a.reserveReplenished)}, pool ${eth(a.toPool)}` };
    case 'WorkoutStarted':
      return { type: 'restructure', label: 'workout', amount: eth(a.installment), details: `Member #${a.memberId}: ${a.periods} installments, no interest` };
    case 'WorkoutCompleted':
      return { type: 'recovery', label: 'workout done', amount: '', details: `Member #${a.memberId} completed a hardship workout` };
    case 'Appealed':
      return { type: 'appeal', amount: '', details: `Loan #${a.loanId} appealed (deadline ${new Date(Number(a.deadline) * 1000).toLocaleDateString()})` };
    case 'Reclassified':
      return { type: 'appeal', label: 'reclassified', amount: '', details: `Loan #${a.loanId}: ${DTYPES[Number(a.oldType)]} → ${DTYPES[Number(a.newType)]}` };
    case 'MemberRegistered':
      return { type: 'identity', label: 'registered', user: a.wallet, amount: '', details: `Member #${a.memberId}, cohort ${a.cohortId}` };
    case 'WalletLinked':
      return { type: 'identity', label: 'wallet linked', user: a.wallet, amount: '', details: `Member #${a.memberId}` };
    case 'CoolingOffSet':
      return { type: 'identity', label: 'cooling-off', amount: '', details: `Member #${a.memberId} ${a.until >= 2n ** 63n ? 'locked until the claim is settled' : `until ${new Date(Number(a.until) * 1000).toLocaleDateString()}`}` };
    case 'ScoreChanged':
      return { type: 'identity', label: 'score', amount: `${a.delta > 0n ? '+' : ''}${a.delta}`, details: `Member #${a.memberId}: ${ethers.decodeBytes32String(a.reasonCode)}` };
    case 'ParameterUpdated':
      return { type: 'admin', label: 'parameter', amount: '', details: `${ethers.decodeBytes32String(a.key)}: ${a.oldValue} → ${a.newValue}` };
    case 'PayoutRouted':
      return { type: 'repay', label: 'payout', user: a.worker, amount: eth(a.amount), details: `Sweep ${eth(a.sweptToLoan)}, claim ${eth(a.sweptToClaim)}, forwarded ${eth(a.forwarded)}` };
    default:
      return null;
  }
}

/**
 * Cross-client event sync across all protocol contracts. WebSocket when configured, HTTP
 * polling otherwise; historical backfill, de-duplication by txHash-logIndex, reorg handling.
 */
export const useEventSync = (walletProvider) => {
  const [events, setEvents] = useState([]);
  const [syncTick, setSyncTick] = useState(0);
  const [isLive, setIsLive] = useState(false);
  const [connectionMode, setConnectionMode] = useState('initializing');
  const seenEventKeys = useRef(new Set());
  const providerRef = useRef(null);

  const processLog = useCallback(async (interfaces, log) => {
    try {
      const iface = interfaces[log.address.toLowerCase()];
      if (!iface) return null;
      const parsed = iface.parseLog(log);
      if (!parsed) return null;

      const txHash = log.transactionHash;
      const logIndex = log.index ?? log.logIndex ?? 0;
      const key = `${txHash}-${logIndex}`;
      if (seenEventKeys.current.has(key)) return null;

      const info = describe(parsed.name, parsed.args);
      if (!info) return null;
      seenEventKeys.current.add(key);

      const block = await log.getBlock().catch(() => null);
      const timestamp = block?.timestamp
        ? new Date(Number(block.timestamp) * 1000).toLocaleString()
        : new Date().toLocaleTimeString();

      return {
        id: key,
        txHash,
        logIndex,
        blockNumber: log.blockNumber,
        name: parsed.name,
        type: info.type,
        label: info.label || info.type,
        user: info.user || '',
        amount: info.amount,
        details: info.details,
        shortUser: short(info.user),
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

      const { provider: syncProvider, mode } = getSyncProvider(walletProvider);
      providerRef.current = syncProvider;
      setConnectionMode(mode);
      if (!syncProvider) {
        setIsLive(false);
        return;
      }

      try {
        const targetChainId = import.meta.env.VITE_CHAIN_ID ? BigInt(import.meta.env.VITE_CHAIN_ID) : 31337n;
        const network = await syncProvider.getNetwork().catch(() => null);
        if (network && network.chainId !== targetChainId) {
          console.warn(`Chain mismatch: expected ${targetChainId}, got ${network.chainId}`);
          setConnectionMode('chain-mismatch');
          setIsLive(false);
          return;
        }

        const interfaces = {};
        const addresses = [];
        for (const name of WATCHED) {
          const c = getContract(name, syncProvider);
          if (!c) continue;
          interfaces[CONTRACT_ADDRESSES[name].toLowerCase()] = c.interface;
          addresses.push(CONTRACT_ADDRESSES[name]);
        }
        if (addresses.length === 0) {
          setIsLive(false);
          return;
        }

        const fromBlock = import.meta.env.VITE_START_BLOCK ? Number(import.meta.env.VITE_START_BLOCK) : 0;
        const historicalLogs = await syncProvider
          .getLogs({ address: addresses, fromBlock: Math.max(0, fromBlock), toBlock: 'latest' })
          .catch((err) => {
            console.warn('Historical log query fallback:', err);
            return [];
          });

        if (active && historicalLogs.length > 0) {
          const parsedList = [];
          for (const log of historicalLogs) {
            if (!log.removed) {
              const item = await processLog(interfaces, log);
              if (item) parsedList.push(item);
            }
          }
          parsedList.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
          setEvents(parsedList);
          setSyncTick((t) => t + 1);
        }

        const handleNewLog = async (log) => {
          if (!active) return;
          const key = `${log.transactionHash}-${log.index ?? log.logIndex ?? 0}`;
          if (log.removed) {
            seenEventKeys.current.delete(key);
            setEvents((prev) => prev.filter((e) => e.id !== key));
            setSyncTick((t) => t + 1);
            return;
          }
          const parsed = await processLog(interfaces, log);
          if (parsed) {
            setEvents((prev) => [parsed, ...prev.filter((e) => e.id !== parsed.id)]);
            setSyncTick((t) => t + 1);
          }
        };

        syncProvider.on({ address: addresses }, handleNewLog);
        setIsLive(true);

        if (mode === 'http') {
          fallbackPollInterval = setInterval(async () => {
            if (!active) return;
            try {
              const currentBlock = await syncProvider.getBlockNumber();
              const recentLogs = await syncProvider.getLogs({
                address: addresses,
                fromBlock: Math.max(0, currentBlock - 5),
                toBlock: 'latest',
              });
              let added = false;
              for (const log of recentLogs) {
                const item = await processLog(interfaces, log);
                if (item) {
                  setEvents((prev) => [item, ...prev.filter((e) => e.id !== item.id)]);
                  added = true;
                }
              }
              if (added) setSyncTick((t) => t + 1);
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
      if (providerRef.current) providerRef.current.removeAllListeners();
      setIsLive(false);
    };
  }, [walletProvider, processLog]);

  return { events, syncTick, isLive, connectionMode };
};
