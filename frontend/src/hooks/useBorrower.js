import { useCallback, useEffect, useState } from 'react';

export const STAGE_NAMES = ['Active', 'Grace', 'Onset', 'Significant', 'Default-eligible'];
export const DEFAULT_TYPES = ['None', 'Hardship', 'Strategic', 'Fraud'];
export const LOAN_STATUS = ['None', 'Active', 'Repaid', 'Defaulted', 'Exited'];
export const KIND = { Builder: 0, Unsecured: 1 };

const EMPTY = {
  loading: true,
  memberId: 0n,
  member: null,
  score: null,
  limits: null,
  loanIds: [],
  loan: null,
  stage: null,
  amountDue: 0n,
  payoff: 0n,
  claim: null,
  quote: 0n,
  lastLoan: null,
};

/**
 * Everything the borrower pages need about the connected wallet's member record, in one read.
 */
export function useBorrower(contracts, account, refreshKey) {
  const { identityRegistry, creditScore, riskEngine, loanManager, defaultManager } = contracts;
  const [state, setState] = useState(EMPTY);

  const load = useCallback(async () => {
    if (!identityRegistry || !loanManager || !account) {
      setState({ ...EMPTY, loading: false });
      return;
    }
    try {
      const memberId = await identityRegistry.memberOf(account);
      if (memberId === 0n) {
        setState({ ...EMPTY, loading: false });
        return;
      }
      const [member, score, limits, loanIds, openId, claim] = await Promise.all([
        identityRegistry.getMember(memberId),
        creditScore ? creditScore.getScore(memberId) : null,
        riskEngine ? riskEngine.limits(memberId).catch(() => null) : null,
        loanManager.loansOfMember(memberId),
        loanManager.openLoanOf(memberId),
        defaultManager ? defaultManager.claims(memberId) : null,
      ]);
      let loan = null;
      let stage = null;
      let amountDue = 0n;
      let payoff = 0n;
      if (openId !== 0n) {
        [loan, stage, amountDue, payoff] = await Promise.all([
          loanManager.getLoan(openId),
          loanManager.stageOf(openId),
          loanManager.amountDue(openId),
          loanManager.payoffAmount(openId),
        ]);
      }
      const lastLoan = loanIds.length > 0 ? await loanManager.getLoan(loanIds[loanIds.length - 1]) : null;
      const quote = claim && claim.amount > 0n ? await defaultManager.settlementQuote(memberId) : 0n;
      setState({
        loading: false,
        memberId,
        member,
        score: score === null ? null : Number(score),
        limits,
        loanIds: [...loanIds],
        loan,
        stage: stage === null ? null : Number(stage),
        amountDue,
        payoff,
        claim,
        quote,
        lastLoan,
      });
    } catch (err) {
      console.warn('useBorrower failed:', err);
      setState({ ...EMPTY, loading: false });
    }
  }, [identityRegistry, creditScore, riskEngine, loanManager, defaultManager, account]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return { ...state, reload: load };
}

/** Best available limit for display: Unsecured cap if allowed, else the Builder cap. */
export const displayLimit = (limits) => {
  if (!limits) return 0n;
  return limits.unsecuredAllowed ? limits.unsecuredCap : limits.builderCap;
};
