import { Injectable, Logger } from '@nestjs/common';
import { ContractPairLoaderService } from '../contract-matching/contract-pair-loader.service';
import { DegradationProtocolService } from '../data-ingestion/degradation-protocol.service';
import { KalshiConnector } from '../../connectors/kalshi/kalshi.connector';
import { PolymarketConnector } from '../../connectors/polymarket/polymarket.connector';
import Decimal from 'decimal.js';
import { FinancialMath, FinancialDecimal } from '../../common/utils';
import { PlatformId, NormalizedOrderBook } from '../../common/types';
import { ContractPairConfig } from '../contract-matching/types';
import { getCorrelationId } from '../../common/services/correlation-context';
import { RawDislocation, DetectionCycleResult } from './types';

@Injectable()
export class DetectionService {
  private readonly logger = new Logger(DetectionService.name);

  constructor(
    private readonly contractPairLoader: ContractPairLoaderService,
    private readonly degradationService: DegradationProtocolService,
    private readonly kalshiConnector: KalshiConnector,
    private readonly polymarketConnector: PolymarketConnector,
  ) {}

  async detectDislocations(): Promise<DetectionCycleResult> {
    const startTime = Date.now();
    const dislocations: RawDislocation[] = [];
    let pairsEvaluated = 0;
    let pairsSkipped = 0;

    const activePairs = this.contractPairLoader.getActivePairs();

    for (const pair of activePairs) {
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
          pair.kalshiContractId,
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
          pair.polymarketContractId,
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

      const polyBestAsk = polymarketOrderBook.asks[0]!;
      const kalshiBestAsk = kalshiOrderBook.asks[0]!;

      pairsEvaluated++;
      const now = new Date();

      // AC4: Scenario A — Buy Polymarket, Sell Kalshi
      const polyBuyPrice = new FinancialDecimal(polyBestAsk.price);
      const kalshiSellPrice = new FinancialDecimal(kalshiBestAsk.price);
      const grossEdgeA = FinancialMath.calculateGrossEdge(
        polyBuyPrice,
        kalshiSellPrice,
      );

      if (grossEdgeA.greaterThan(0)) {
        // Verify direction: buy price < implied sell price means actual arb
        const impliedSellPrice = new FinancialDecimal(1).minus(kalshiSellPrice);
        if (polyBuyPrice.lessThan(impliedSellPrice)) {
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
      }

      // AC4: Scenario B — Buy Kalshi, Sell Polymarket
      const kalshiBuyPrice = new FinancialDecimal(kalshiBestAsk.price);
      const polySellPrice = new FinancialDecimal(polyBestAsk.price);
      const grossEdgeB = FinancialMath.calculateGrossEdge(
        kalshiBuyPrice,
        polySellPrice,
      );

      if (grossEdgeB.greaterThan(0)) {
        const impliedSellPrice = new FinancialDecimal(1).minus(polySellPrice);
        if (kalshiBuyPrice.lessThan(impliedSellPrice)) {
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

  private getConnector(
    platformId: PlatformId,
  ): KalshiConnector | PolymarketConnector {
    return platformId === PlatformId.KALSHI
      ? this.kalshiConnector
      : this.polymarketConnector;
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
