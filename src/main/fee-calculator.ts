import type { FeeBreakdown } from '../shared/types';

/**
 * Fee model for AMP Futures / MES, reconciled against AMP's 13-NOV-26 statement.
 *
 * Units matter here and used to be ambiguous: the rate is charged **per contract,
 * per side** — one contract bought is one side, the same contract sold later is a
 * second side. A 5-lot round trip is therefore 10 contract-sides, not 1 "trade".
 * Every function below counts in contract-sides; `contractSidesFromRoundTrips()`
 * is the only sanctioned way to convert from a round-trip count.
 */
export interface FeeConfig {
  /** $ per contract PER SIDE. AMP: 0.60 (see AMP_SIDE_FEE_COMPONENTS). */
  perContractSideFee:  number;
  /** $/day flat. AMP's statement shows none — defaults to 0 and is EXCLUDED from net. */
  liquidationDaily:    number;
  /** $/month data feed. AMP's statement shows none — defaults to 0 and is EXCLUDED from net. */
  dataFeedMonthly:     number;
  /** Divisor that amortises `dataFeedMonthly` across a month. Only used by dailyFixedFee(). */
  tradingDaysPerMonth: number;
}

/** What AMP's $0.60 per contract per side is actually made of, per the statement. */
export const AMP_SIDE_FEE_COMPONENTS = {
  exchange:   0.35,
  clearing:   0.13,
  cqg:        0.10,
  nfa:        0.01,
  commission: 0.01,
} as const;

/** The AMP per-side rate, derived from its components so the two can never drift apart. */
export const AMP_PER_CONTRACT_SIDE_FEE: number =
  Object.values(AMP_SIDE_FEE_COMPONENTS).reduce((sum, part) => sum + part, 0);

/** One contract in and back out again is two chargeable sides. */
export const SIDES_PER_ROUND_TRIP = 2;

export const DEFAULT_FEE_CONFIG: FeeConfig = {
  perContractSideFee:  AMP_PER_CONTRACT_SIDE_FEE, // 0.60
  liquidationDaily:    0,                         // AMP bills none
  dataFeedMonthly:     0,                         // AMP bills none
  tradingDaysPerMonth: 21,
};

// MES: 1 point = $5.00 (0.25-tick × $1.25/tick × 4 ticks/point)
const MES_POINT_VALUE = 5.0;

/**
 * Flat per-day charges. Kept for brokers that bill them, but deliberately NOT part of
 * `totalFees` — AMP charges neither, and folding a phantom $4.64/day into the daily
 * net is what made the old model disagree with the statement.
 */
export function dailyFixedFee(cfg: FeeConfig): number {
  const amortisedFeed = cfg.tradingDaysPerMonth > 0
    ? cfg.dataFeedMonthly / cfg.tradingDaysPerMonth
    : 0;
  return cfg.liquidationDaily + amortisedFeed;
}

/** Contract-sides implied by N round trips of `contractsPerRoundTrip` contracts each. */
export function contractSidesFromRoundTrips(roundTrips: number, contractsPerRoundTrip = 1): number {
  return roundTrips * contractsPerRoundTrip * SIDES_PER_ROUND_TRIP;
}

/** What a completed round trip of `contracts` contracts costs in fees (both sides). */
export function roundTripFee(contracts: number, cfg: FeeConfig): number {
  return contracts * SIDES_PER_ROUND_TRIP * cfg.perContractSideFee;
}

/** Fees for a number of contract-sides. `totalFees` excludes daily fixed charges by design. */
export function calculateFees(contractSides: number, cfg: FeeConfig): FeeBreakdown {
  const variableFees = cfg.perContractSideFee * contractSides;
  return {
    perContractRate: cfg.perContractSideFee,
    contractCount:   contractSides,
    variableFees,
    dailyFixed:      dailyFixedFee(cfg), // reported for visibility only
    totalFees:       variableFees,       // daily fixed is NOT charged against the day
  };
}

/** Gross P&L less fees, for a number of contract-sides. */
export function calculateNetPnl(grossPnl: number, contractSides: number, cfg: FeeConfig) {
  const fees = calculateFees(contractSides, cfg);
  return { grossPnl, totalFees: fees.totalFees, netPnl: grossPnl - fees.totalFees, feeBreakdown: fees };
}

/** Points needed on the next 1-contract round trip to reach net-zero for the day. */
export function getBreakevenPoints(netPnl: number): number {
  if (netPnl >= 0) return 0;
  return Math.abs(netPnl) / MES_POINT_VALUE;
}
