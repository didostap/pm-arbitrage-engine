import Decimal from 'decimal.js';
import {
  PlatformId,
  type FeeSchedule,
} from '../../../common/types/platform.type';

export const DEFAULT_KALSHI_FEE_SCHEDULE: FeeSchedule = {
  platformId: PlatformId.KALSHI,
  makerFeePercent: 0,
  takerFeePercent: 1.75,
  description: 'Kalshi dynamic taker fee: 0.07 × P × (1-P) per contract',
  takerFeeForPrice: (price: number): number => {
    if (price <= 0 || price >= 1) return 0;
    return new Decimal(0.07).mul(new Decimal(1).minus(price)).toNumber();
  },
};

export const DEFAULT_POLYMARKET_FEE_SCHEDULE: FeeSchedule = {
  platformId: PlatformId.POLYMARKET,
  makerFeePercent: 0,
  takerFeePercent: 2.0,
  description: 'Polymarket flat 2% taker fee',
};
