import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { PlatformId } from '../../common/types/platform.type';
import type { ContractId } from '../../common/types/branded.type';
import type { NormalizedOrderBook } from '../../common/types/normalized-order-book.type';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { DataDivergenceEvent } from '../../common/events/platform.events';

interface SnapshotData {
  bestBid: Decimal;
  bestAsk: Decimal;
  timestamp: Date;
}

/**
 * Compares poll and WebSocket data paths for the same contract.
 * Read-only and observational — does NOT modify either data path.
 * Emits platform.data.divergence when price or staleness delta exceeds threshold.
 */
@Injectable()
export class DataDivergenceService {
  private readonly logger = new Logger(DataDivergenceService.name);

  private readonly lastPollSnapshot = new Map<string, SnapshotData>();
  private readonly lastWsSnapshot = new Map<string, SnapshotData>();
  private readonly divergentContracts = new Set<string>();

  private readonly priceThreshold: Decimal;
  private readonly stalenessThresholdMs: number;

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
  ) {
    this.priceThreshold = new Decimal(
      this.configService.get<number>('DIVERGENCE_PRICE_THRESHOLD', 0.02),
    );
    this.stalenessThresholdMs = this.configService.get<number>(
      'DIVERGENCE_STALENESS_THRESHOLD_MS',
      90000,
    );
  }

  recordPollData(
    platformId: PlatformId,
    contractId: ContractId,
    book: NormalizedOrderBook,
  ): void {
    if (book.bids.length === 0 || book.asks.length === 0) return; // Skip books with missing sides
    const key = `${platformId}:${contractId as string}`;
    this.lastPollSnapshot.set(key, {
      bestBid: new Decimal(book.bids[0]!.price),
      bestAsk: new Decimal(book.asks[0]!.price),
      timestamp: book.timestamp,
    });
    this.checkDivergence(platformId, contractId);
  }

  recordWsData(
    platformId: PlatformId,
    contractId: ContractId,
    book: NormalizedOrderBook,
  ): void {
    if (book.bids.length === 0 || book.asks.length === 0) return; // Skip books with missing sides
    const key = `${platformId}:${contractId as string}`;
    this.lastWsSnapshot.set(key, {
      bestBid: new Decimal(book.bids[0]!.price),
      bestAsk: new Decimal(book.asks[0]!.price),
      timestamp: book.timestamp,
    });
    this.checkDivergence(platformId, contractId);
  }

  clearContractData(platformId: PlatformId, contractId: ContractId): void {
    const key = `${platformId}:${contractId as string}`;
    this.lastPollSnapshot.delete(key);
    this.lastWsSnapshot.delete(key);
    this.divergentContracts.delete(key);
  }

  getDivergenceStatus(platformId: PlatformId): 'normal' | 'divergent' {
    for (const key of this.divergentContracts) {
      if (key.startsWith(`${platformId}:`)) {
        return 'divergent';
      }
    }
    return 'normal';
  }

  private checkDivergence(
    platformId: PlatformId,
    contractId: ContractId,
  ): void {
    const key = `${platformId}:${contractId as string}`;
    const poll = this.lastPollSnapshot.get(key);
    const ws = this.lastWsSnapshot.get(key);

    if (!poll || !ws) return; // Need both to compare

    const bidDelta = poll.bestBid.minus(ws.bestBid).abs();
    const askDelta = poll.bestAsk.minus(ws.bestAsk).abs();
    const priceDelta = Decimal.max(bidDelta, askDelta);
    const stalenessDeltaMs = Math.abs(
      poll.timestamp.getTime() - ws.timestamp.getTime(),
    );

    const isDivergent =
      priceDelta.greaterThan(this.priceThreshold) ||
      stalenessDeltaMs > this.stalenessThresholdMs;
    const wasDivergent = this.divergentContracts.has(key);

    if (isDivergent && !wasDivergent) {
      // normal → divergent transition (exactly-once emission)
      this.divergentContracts.add(key);
      this.eventEmitter.emit(
        EVENT_NAMES.DATA_DIVERGENCE,
        new DataDivergenceEvent(
          platformId,
          contractId,
          poll.bestBid.toString(),
          poll.bestAsk.toString(),
          poll.timestamp.toISOString(),
          ws.bestBid.toString(),
          ws.bestAsk.toString(),
          ws.timestamp.toISOString(),
          priceDelta.toString(),
          stalenessDeltaMs,
        ),
      );
    } else if (!isDivergent && wasDivergent) {
      // divergent → normal recovery (log only, no event)
      this.divergentContracts.delete(key);
      this.logger.log({
        message: 'Data divergence recovered',
        module: 'data-ingestion',
        timestamp: new Date().toISOString(),
        metadata: {
          platformId,
          contractId,
          priceDelta: priceDelta.toString(),
          stalenessDeltaMs,
        },
      });
    }
  }
}
