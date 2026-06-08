import type { FeeBreakdown } from '../shared/types';

export interface FeeConfig {
  perContractFee:      number; // $/RT (exchange + NFA + clearing + CQG + commission)
  liquidationDaily:    number; // $/day flat
  dataFeedMonthly:     number; // $/month amortized
  tradingDaysPerMonth: number;
}

export const DEFAULT_FEE_CONFIG: FeeConfig = {
  perContractFee:      1.24,
  liquidationDaily:    2.50,
  dataFeedMonthly:     45.00,
  tradingDaysPerMonth: 21,
};

// MES: 1 point = $5.00 (0.25-tick × $1.25/tick × 4 ticks/point)
const MES_POINT_VALUE = 5.0;

export function dailyFixedFee(cfg: FeeConfig): number {
  return cfg.liquidationDaily + cfg.dataFeedMonthly / cfg.tradingDaysPerMonth;
}

export function calculateFees(roundTripCount: number, cfg: FeeConfig): FeeBreakdown {
  const variableFees = cfg.perContractFee * roundTripCount;
  const fixed        = dailyFixedFee(cfg);
  return {
    perContractRate: cfg.perContractFee,
    contractCount:   roundTripCount,
    variableFees,
    dailyFixed:      fixed,
    totalFees:       variableFees + fixed,
  };
}

export function calculateNetPnl(grossPnl: number, roundTripCount: number, cfg: FeeConfig) {
  const fees = calculateFees(roundTripCount, cfg);
  return { grossPnl, totalFees: fees.totalFees, netPnl: grossPnl - fees.totalFees, feeBreakdown: fees };
}

/** Points needed on the next 1-contract trade to reach net-zero for the day. */
export function getBreakevenPoints(netPnl: number): number {
  if (netPnl >= 0) return 0;
  return Math.abs(netPnl) / MES_POINT_VALUE;
}
