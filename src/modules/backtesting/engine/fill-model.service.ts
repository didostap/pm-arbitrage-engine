import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { PrismaService } from '../../../common/prisma.service';
import {
  calculateVwapWithFillInfo,
  type VwapFillResult,
} from '../../../common/utils/financial-math';
import type { NormalizedOrderBook } from '../../../common/types/normalized-order-book.type';
import type { ContractId } from '../../../common/types/branded.type';
import { PlatformId } from '../../../common/types/platform.type';
import type { NormalizedHistoricalDepth } from '../types/normalized-historical.types';
import { parseJsonDepthLevels } from '../utils/depth-parsing.utils';
import {
  findNearestDepthFromCache,
  type DepthCache,
} from './backtest-data-loader.service';
import { Platform } from '@prisma/client';

@Injectable()
export class FillModelService {
  constructor(private readonly prisma: PrismaService) {}

  adaptDepthToOrderBook(
    depth: NormalizedHistoricalDepth,
    platformId: PlatformId,
  ): NormalizedOrderBook {
    const bids = depth.bids
      .map((l) => ({ price: l.price, quantity: l.size }))
      .sort((a, b) => b.price - a.price);

    const asks = depth.asks
      .map((l) => ({ price: l.price, quantity: l.size }))
      .sort((a, b) => a.price - b.price);

    return {
      platformId,
      contractId: depth.contractId as ContractId,
      bids,
      asks,
      timestamp: depth.timestamp,
    };
  }

  async findNearestDepth(
    platform: string,
    contractId: string,
    timestamp: Date,
  ): Promise<NormalizedHistoricalDepth | null> {
    const record = await this.prisma.historicalDepth.findFirst({
      where: {
        platform: platform as Platform,
        contractId,
        timestamp: { lte: timestamp },
      },
      orderBy: { timestamp: 'desc' },
    });

    if (!record) return null;

    const bidsJson = record.bids as unknown;
    const asksJson = record.asks as unknown;

    if (!Array.isArray(bidsJson) || !Array.isArray(asksJson)) return null;

    return {
      platform: record.platform,
      contractId: record.contractId,
      source: record.source,
      bids: parseJsonDepthLevels(bidsJson as Array<Record<string, unknown>>),
      asks: parseJsonDepthLevels(asksJson as Array<Record<string, unknown>>),
      timestamp: record.timestamp,
      updateType: record.updateType as 'snapshot' | 'price_change' | null,
    };
  }

  async modelFill(
    platform: string,
    contractId: ContractId,
    platformId: PlatformId,
    timestamp: Date,
    side: 'buy' | 'sell',
    positionSize: Decimal,
    depthCache?: DepthCache,
    closePrice?: Decimal,
  ): Promise<VwapFillResult | null> {
    const depth = depthCache
      ? await findNearestDepthFromCache(
          depthCache,
          platform,
          contractId,
          timestamp,
        )
      : await this.findNearestDepth(platform, contractId, timestamp);
    if (!depth) {
      // No depth data — use close price as flat fill (conservative assumption).
      // Kalshi has no public depth API; empty depth table is expected early on.
      if (closePrice && closePrice.gt(0)) {
        return {
          vwap: closePrice,
          filledQty: positionSize.div(closePrice),
          totalQtyAvailable: positionSize.div(closePrice),
        };
      }
      return null;
    }

    const orderBook = this.adaptDepthToOrderBook(depth, platformId);

    // For backtesting taker fills:
    // buy = take from asks → pass 'sell' as closeSide (walks asks)
    // sell = hit bids → pass 'buy' as closeSide (walks bids)
    const closeSide = side === 'buy' ? 'sell' : 'buy';
    return calculateVwapWithFillInfo(orderBook, closeSide, positionSize);
  }
}
