import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import Decimal from 'decimal.js';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import {
  ExitTriggeredEvent,
  ShadowDailySummaryEvent,
} from '../../common/events/execution.events';
import type { PositionId, PairId } from '../../common/types/branded.type';

/** Shape of a shadow comparison event payload received by the service. */
export interface ShadowComparisonPayload {
  positionId: PositionId;
  pairId: PairId;
  modelResult: {
    triggered: boolean;
    type?: string;
    currentPnl: Decimal;
    criteria: Array<{
      criterion: string;
      proximity: Decimal;
      triggered: boolean;
    }>;
  };
  fixedResult: {
    triggered: boolean;
    type?: string;
    currentPnl: Decimal;
  };
  timestamp: Date;
}

/** Shape of a position close event payload. */
export interface PositionClosePayload {
  positionId: PositionId;
  pairId: PairId;
  modelExitPnl: Decimal;
  fixedExitPnl: Decimal;
  modelExitTimestamp: Date;
  fixedWouldHaveExitedAt: Date;
  pnlDelta: Decimal;
}

interface ClosedPositionEntry {
  positionId: PositionId;
  pairId: PairId;
  pnlDelta: Decimal;
  modelExitTimestamp: Date;
  fixedWouldHaveExitedAt: Date;
  triggerCriterion?: string;
}

const MAX_SHADOW_COMPARISONS = 50_000;

interface DailySummary {
  totalComparisons: number;
  fixedTriggerCount: number;
  modelTriggerCount: number;
  triggerCountByCriterion: Record<string, number>;
  cumulativePnlDelta: Decimal;
}

@Injectable()
export class ShadowComparisonService {
  private readonly logger = new Logger(ShadowComparisonService.name);

  private comparisons: ShadowComparisonPayload[] = [];
  private closedEntries: ClosedPositionEntry[] = [];

  constructor(private readonly eventEmitter: EventEmitter2) {}

  /**
   * Handle incoming shadow comparison event — accumulate in daily window.
   * ShadowComparisonEvent serializes Decimal values as strings (.toFixed(8)),
   * so we convert them back to Decimal here at the event boundary.
   */
  @OnEvent(EVENT_NAMES.SHADOW_COMPARISON, { async: true })
  handleShadowComparison(
    event: ShadowComparisonPayload | Record<string, unknown>,
  ): void {
    try {
      const raw = event as {
        positionId: PositionId;
        pairId: PairId;
        modelResult: {
          triggered: boolean;
          type?: string;
          currentPnl: Decimal | string;
          criteria: Array<{
            criterion: string;
            proximity: Decimal | string;
            triggered: boolean;
          }>;
        };
        fixedResult: {
          triggered: boolean;
          type?: string;
          currentPnl: Decimal | string;
        };
        timestamp: Date;
      };

      const normalized: ShadowComparisonPayload = {
        positionId: raw.positionId,
        pairId: raw.pairId,
        modelResult: {
          triggered: raw.modelResult.triggered,
          type: raw.modelResult.type,
          currentPnl:
            raw.modelResult.currentPnl instanceof Decimal
              ? raw.modelResult.currentPnl
              : new Decimal(raw.modelResult.currentPnl),
          criteria: raw.modelResult.criteria.map((c) => ({
            criterion: c.criterion,
            proximity:
              c.proximity instanceof Decimal
                ? c.proximity
                : new Decimal(c.proximity),
            triggered: c.triggered,
          })),
        },
        fixedResult: {
          triggered: raw.fixedResult.triggered,
          type: raw.fixedResult.type,
          currentPnl:
            raw.fixedResult.currentPnl instanceof Decimal
              ? raw.fixedResult.currentPnl
              : new Decimal(raw.fixedResult.currentPnl),
        },
        timestamp: raw.timestamp,
      };

      this.comparisons.push(normalized);

      // Evict oldest entries if cap exceeded
      if (this.comparisons.length > MAX_SHADOW_COMPARISONS) {
        const evictCount = this.comparisons.length - MAX_SHADOW_COMPARISONS;
        this.comparisons.splice(0, evictCount);
      }
    } catch (error) {
      this.logger.warn({
        message: 'Failed to normalize shadow comparison event — skipping',
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /** Handle position close — record final comparison entry. */
  handlePositionClose(event: PositionClosePayload): void {
    this.closedEntries.push({
      positionId: event.positionId,
      pairId: event.pairId,
      pnlDelta: event.pnlDelta,
      modelExitTimestamp: event.modelExitTimestamp,
      fixedWouldHaveExitedAt: event.fixedWouldHaveExitedAt,
    });
  }

  /**
   * When an exit triggers, cross-reference accumulated shadow comparisons
   * to record a closed position entry with P&L delta (model vs fixed).
   */
  @OnEvent(EVENT_NAMES.EXIT_TRIGGERED, { async: true })
  handleExitTriggered(event: ExitTriggeredEvent): void {
    const positionComparisons = this.comparisons.filter(
      (c) => c.positionId === event.positionId,
    );
    if (positionComparisons.length === 0) return;

    const lastComp = positionComparisons[positionComparisons.length - 1]!;
    const pnlDelta = lastComp.modelResult.currentPnl.minus(
      lastComp.fixedResult.currentPnl,
    );

    // Find first timestamp where fixed triggered (if ever)
    const firstFixedTrigger = positionComparisons.find(
      (c) => c.fixedResult.triggered,
    );

    this.closedEntries.push({
      positionId: event.positionId,
      pairId: event.pairId,
      pnlDelta,
      modelExitTimestamp: new Date(),
      fixedWouldHaveExitedAt: firstFixedTrigger?.timestamp ?? new Date(),
      triggerCriterion: event.exitType,
    });
  }

  /** Get stats about accumulated comparisons. */
  getComparisonStats(): {
    totalComparisons: number;
    closedPositionComparisons: number;
  } {
    return {
      totalComparisons: this.comparisons.length,
      closedPositionComparisons: this.closedEntries.length,
    };
  }

  /** Get closed position comparison entries. */
  getClosedPositionEntries(): ClosedPositionEntry[] {
    return [...this.closedEntries];
  }

  /** Generate daily summary from accumulated data. */
  generateDailySummary(): DailySummary {
    const triggerCountByCriterion: Record<string, number> = {
      edge_evaporation: 0,
      model_confidence: 0,
      time_decay: 0,
      risk_budget: 0,
      liquidity_deterioration: 0,
      profit_capture: 0,
    };

    let fixedTriggerCount = 0;
    let modelTriggerCount = 0;
    let cumulativePnlDelta = new Decimal(0);

    for (const comp of this.comparisons) {
      if (comp.fixedResult.triggered) fixedTriggerCount++;
      if (comp.modelResult.triggered) modelTriggerCount++;

      // Count criterion triggers
      for (const criterion of comp.modelResult.criteria) {
        if (criterion.triggered) {
          triggerCountByCriterion[criterion.criterion] =
            (triggerCountByCriterion[criterion.criterion] ?? 0) + 1;
        }
      }

      // P&L delta: model P&L minus fixed P&L (positive = model advantage)
      cumulativePnlDelta = cumulativePnlDelta.plus(
        comp.modelResult.currentPnl.minus(comp.fixedResult.currentPnl),
      );
    }

    return {
      totalComparisons: this.comparisons.length,
      fixedTriggerCount,
      modelTriggerCount,
      triggerCountByCriterion,
      cumulativePnlDelta,
    };
  }

  /** Reset daily accumulation (called on day boundary). */
  resetDailySummary(): void {
    this.comparisons = [];
    this.closedEntries = [];
  }

  /** Emit ShadowDailySummaryEvent via EventEmitter2. Runs at midnight UTC and resets daily buffer. */
  @Cron('0 0 * * *')
  emitDailySummary(): void {
    const summary = this.generateDailySummary();
    this.eventEmitter.emit(
      EVENT_NAMES.SHADOW_DAILY_SUMMARY,
      new ShadowDailySummaryEvent(
        new Date().toISOString().split('T')[0]!,
        summary.totalComparisons,
        summary.fixedTriggerCount,
        summary.modelTriggerCount,
        summary.triggerCountByCriterion,
        summary.cumulativePnlDelta.toFixed(8),
      ),
    );

    this.logger.log({
      message: 'Shadow daily summary emitted',
      data: {
        totalComparisons: summary.totalComparisons,
        fixedTriggerCount: summary.fixedTriggerCount,
        modelTriggerCount: summary.modelTriggerCount,
      },
    });

    // Reset daily accumulation after emission
    this.resetDailySummary();
  }
}
