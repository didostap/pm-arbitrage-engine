import { Injectable, Logger } from '@nestjs/common';
import { ContractPairLoaderService } from '../contract-matching/contract-pair-loader.service';
import { DegradationProtocolService } from '../data-ingestion/degradation-protocol.service';
import { PlatformHealthService } from '../data-ingestion/platform-health.service';
import { KalshiConnector } from '../../connectors/kalshi/kalshi.connector';
import { PolymarketConnector } from '../../connectors/polymarket/polymarket.connector';
import Decimal from 'decimal.js';
import { FinancialMath, FinancialDecimal } from '../../common/utils';
import { PlatformId, NormalizedOrderBook } from '../../common/types';
import { ContractPairConfig } from '../contract-matching/types';
import { getCorrelationId } from '../../common/services/correlation-context';
import { RawDislocation, DetectionCycleResult } from './types';
import { asContractId } from '../../common/types/branded.type';

@Injectable()
export class DetectionService {
  private readonly logger = new Logger(DetectionService.name);

  constructor(
    private readonly contractPairLoader: ContractPairLoaderService,
    private readonly degradationService: DegradationProtocolService,
    private readonly healthService: PlatformHealthService,
    private readonly kalshiConnector: KalshiConnector,
    private readonly polymarketConnector: PolymarketConnector,
  ) {}

  async detectDislocations(): Promise<DetectionCycleResult> {
    const startTime = Date.now();
    const dislocations: RawDislocation[] = [];
    let pairsEvaluated = 0;
    let pairsSkipped = 0;

    const activePairs = await this.contractPairLoader.getActivePairs();

    for (const pair of activePairs) {
      // Story 9.15: Skip if either contract's orderbook is stale (per-pair granularity)
      const kalshiStaleness = this.healthService.getContractStaleness(
        PlatformId.KALSHI,
        pair.kalshiContractId,
      );
      if (kalshiStaleness.stale) {
        this.logger.debug({
          message: 'Skipping pair — orderbook data stale',
          module: 'arbitrage-detection',
          correlationId: getCorrelationId(),
          data: {
            eventDescription: pair.eventDescription,
            platformId: PlatformId.KALSHI,
            contractId: pair.kalshiContractId,
            skipReason: 'orderbook_stale',
            stalenessMs: kalshiStaleness.stalenessMs,
          },
        });
        pairsSkipped++;
        continue;
      }

      const polymarketStaleness = this.healthService.getContractStaleness(
        PlatformId.POLYMARKET,
        pair.polymarketClobTokenId,
      );
      if (polymarketStaleness.stale) {
        this.logger.debug({
          message: 'Skipping pair — orderbook data stale',
          module: 'arbitrage-detection',
          correlationId: getCorrelationId(),
          data: {
            eventDescription: pair.eventDescription,
            platformId: PlatformId.POLYMARKET,
            contractId: pair.polymarketClobTokenId,
            skipReason: 'orderbook_stale',
            stalenessMs: polymarketStaleness.stalenessMs,
          },
        });
        pairsSkipped++;
        continue;
      }

      // AC2: Skip if either platform is degraded
      if (this.degradationService.isDegraded(PlatformId.KALSHI)) {
        this.logger.debug({
          message: 'Skipping pair — platform degraded',
          module: 'arbitrage-detection',
          correlationId: getCorrelationId(),
          data: {
            eventDescription: pair.eventDescription,
            platformId: PlatformId.KALSHI,
            skipReason: 'platform degraded',
          },
        });
        pairsSkipped++;
        continue;
      }

      if (this.degradationService.isDegraded(PlatformId.POLYMARKET)) {
        this.logger.debug({
          message: 'Skipping pair — platform degraded',
          module: 'arbitrage-detection',
          correlationId: getCorrelationId(),
          data: {
            eventDescription: pair.eventDescription,
            platformId: PlatformId.POLYMARKET,
            skipReason: 'platform degraded',
          },
        });
        pairsSkipped++;
        continue;
      }

      // AC3: Fetch order books
      let kalshiOrderBook: NormalizedOrderBook;
      let polymarketOrderBook: NormalizedOrderBook;

      try {
        kalshiOrderBook = await this.kalshiConnector.getOrderBook(
          asContractId(pair.kalshiContractId),
        );
      } catch (error) {
        this.logger.error({
          message: 'Order book fetch failed — skipping pair',
          module: 'arbitrage-detection',
          correlationId: getCorrelationId(),
          data: {
            eventDescription: pair.eventDescription,
            platformId: PlatformId.KALSHI,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
        pairsSkipped++;
        continue;
      }

      try {
        polymarketOrderBook = await this.polymarketConnector.getOrderBook(
          asContractId(pair.polymarketClobTokenId),
        );
      } catch (error) {
        this.logger.error({
          message: 'Order book fetch failed — skipping pair',
          module: 'arbitrage-detection',
          correlationId: getCorrelationId(),
          data: {
            eventDescription: pair.eventDescription,
            platformId: PlatformId.POLYMARKET,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
        pairsSkipped++;
        continue;
      }

      // AC3: Skip if empty bids or asks
      if (
        kalshiOrderBook.bids.length === 0 ||
        kalshiOrderBook.asks.length === 0 ||
        polymarketOrderBook.bids.length === 0 ||
        polymarketOrderBook.asks.length === 0
      ) {
        this.logger.debug({
          message: 'Skipping pair — no market depth',
          module: 'arbitrage-detection',
          correlationId: getCorrelationId(),
          data: {
            eventDescription: pair.eventDescription,
            kalshiBids: kalshiOrderBook.bids.length,
            kalshiAsks: kalshiOrderBook.asks.length,
            polymarketBids: polymarketOrderBook.bids.length,
            polymarketAsks: polymarketOrderBook.asks.length,
          },
        });
        pairsSkipped++;
        continue;
      }

      // Both order books are normalized to the YES outcome (Kalshi NO levels
      // are converted to YES-equivalent asks). Bids sorted descending, asks
      // ascending, so [0] is best bid / best ask. Compare to website "Yes"
      // prices only — "No" prices (e.g. 0.84) are the complement 1−YES.
      const polyBestAsk = polymarketOrderBook.asks[0]!;
      const kalshiBestAsk = kalshiOrderBook.asks[0]!;
      const polyBestBid = polymarketOrderBook.bids[0]!;
      const kalshiBestBid = kalshiOrderBook.bids[0]!;

      pairsEvaluated++;
      const now = new Date();

      // AC4: Scenario A — Buy Polymarket, Sell Kalshi
      const polyBuyPrice = new FinancialDecimal(polyBestAsk.price);
      const kalshiSellPrice = new FinancialDecimal(kalshiBestBid.price);
      const grossEdgeA = FinancialMath.calculateGrossEdge(
        polyBuyPrice,
        kalshiSellPrice,
      );

      if (grossEdgeA.greaterThan(0)) {
        dislocations.push(
          this.buildDislocation(
            pair,
            PlatformId.POLYMARKET,
            PlatformId.KALSHI,
            polyBuyPrice,
            kalshiSellPrice,
            grossEdgeA,
            polymarketOrderBook,
            kalshiOrderBook,
            now,
          ),
        );
      }

      // AC4: Scenario B — Buy Kalshi, Sell Polymarket
      const kalshiBuyPrice = new FinancialDecimal(kalshiBestAsk.price);
      const polySellPrice = new FinancialDecimal(polyBestBid.price);
      const grossEdgeB = FinancialMath.calculateGrossEdge(
        kalshiBuyPrice,
        polySellPrice,
      );

      if (grossEdgeB.greaterThan(0)) {
        dislocations.push(
          this.buildDislocation(
            pair,
            PlatformId.KALSHI,
            PlatformId.POLYMARKET,
            kalshiBuyPrice,
            polySellPrice,
            grossEdgeB,
            kalshiOrderBook,
            polymarketOrderBook,
            now,
          ),
        );
      }
    }

    const cycleDurationMs = Date.now() - startTime;

    // AC5: Summary log
    this.logger.log({
      message: 'Detection cycle complete',
      module: 'arbitrage-detection',
      correlationId: getCorrelationId(),
      data: {
        totalPairs: activePairs.length,
        evaluated: pairsEvaluated,
        skipped: pairsSkipped,
        dislocationsFound: dislocations.length,
        durationMs: cycleDurationMs,
      },
    });

    return {
      dislocations,
      pairsEvaluated,
      pairsSkipped,
      cycleDurationMs,
    };
  }

  private buildDislocation(
    pairConfig: ContractPairConfig,
    buyPlatformId: PlatformId,
    sellPlatformId: PlatformId,
    buyPrice: Decimal,
    sellPrice: Decimal,
    grossEdge: Decimal,
    buyOrderBook: NormalizedOrderBook,
    sellOrderBook: NormalizedOrderBook,
    detectedAt: Date,
  ): RawDislocation {
    return {
      pairConfig,
      buyPlatformId,
      sellPlatformId,
      buyPrice,
      sellPrice,
      grossEdge,
      buyOrderBook,
      sellOrderBook,
      detectedAt,
    };
  }
}
