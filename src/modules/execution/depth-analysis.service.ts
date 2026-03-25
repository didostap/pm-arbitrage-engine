import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import type { IPlatformConnector } from '../../common/interfaces/platform-connector.interface';
import type { PriceLevel } from '../../common/types/index';
import { PlatformId } from '../../common/types/platform.type';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../common/errors/system-health-error';
import { DepthCheckFailedEvent } from '../../common/events/execution.events';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { asContractId } from '../../common/types/branded.type';
import { DataDivergenceService } from '../data-ingestion/data-divergence.service';

export type DualLegDepthResult =
  | {
      passed: true;
      primaryDepth: number;
      secondaryDepth: number;
      minDepthRequired: number;
    }
  | {
      passed: false;
      primaryDepth: number;
      secondaryDepth: number;
      minDepthRequired: number;
      reason: string;
    };

export interface ValidateDualLegDepthParams {
  primaryConnector: IPlatformConnector;
  primaryContractId: string;
  primarySide: 'buy' | 'sell';
  primaryPrice: number;
  primaryPlatform: PlatformId;
  secondaryConnector: IPlatformConnector;
  secondaryContractId: string;
  secondarySide: 'buy' | 'sell';
  secondaryPrice: number;
  secondaryPlatform: PlatformId;
  idealCount: number;
}

@Injectable()
export class DepthAnalysisService {
  private readonly logger = new Logger(DepthAnalysisService.name);
  private dualLegMinDepthRatio: number;

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly dataDivergenceService: DataDivergenceService,
    private readonly configService: ConfigService,
  ) {
    this.dualLegMinDepthRatio = Number(
      this.configService.get<string>('DUAL_LEG_MIN_DEPTH_RATIO', '1.0'),
    );
    if (
      isNaN(this.dualLegMinDepthRatio) ||
      this.dualLegMinDepthRatio <= 0 ||
      this.dualLegMinDepthRatio > 1
    ) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.INVALID_CONFIGURATION,
        'Invalid DUAL_LEG_MIN_DEPTH_RATIO: must be >0 and ≤1',
        'error',
        'execution',
      );
    }
  }

  /** Reload dualLegMinDepthRatio from DB-backed config (called by parent ExecutionService) */
  reloadConfig(settings: { dualLegMinDepthRatio?: string }): void {
    if (settings.dualLegMinDepthRatio !== undefined) {
      const value = Number(settings.dualLegMinDepthRatio);
      if (!isNaN(value) && value > 0 && value <= 1) {
        this.dualLegMinDepthRatio = value;
      }
    }
    this.logger.log({
      message: 'DepthAnalysis config reloaded',
      data: {
        dualLegMinDepthRatio: this.dualLegMinDepthRatio,
      },
    });
  }

  /**
   * Query available depth at or better than targetPrice.
   * Returns 0 on API error (fail-closed) and emits DEPTH_CHECK_FAILED.
   */
  async getAvailableDepth(
    connector: IPlatformConnector,
    contractId: string,
    side: 'buy' | 'sell',
    targetPrice: number,
    platformId: PlatformId,
  ): Promise<number> {
    try {
      const book = await connector.getOrderBook(asContractId(contractId));
      const levels: PriceLevel[] = side === 'buy' ? book.asks : book.bids;

      let availableQty = new Decimal(0);
      for (const level of levels) {
        const priceOk =
          side === 'buy'
            ? level.price <= targetPrice
            : level.price >= targetPrice;
        if (priceOk) {
          availableQty = availableQty.plus(level.quantity);
        }
      }

      return availableQty.toNumber();
    } catch (error) {
      this.logger.warn({
        message: 'Depth query failed',
        module: 'execution',
        platform: platformId,
        contractId,
        side,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.eventEmitter.emit(
        EVENT_NAMES.DEPTH_CHECK_FAILED,
        new DepthCheckFailedEvent(
          platformId,
          asContractId(contractId),
          side,
          error instanceof Error ? error.constructor.name : 'Unknown',
          error instanceof Error ? error.message : String(error),
        ),
      );
      return 0;
    }
  }

  /** Classify WS data freshness for audit trail metadata. */
  classifyDataSource(
    lastWsUpdateAt: Date | null,
    now: Date,
    stalenessThresholdMs: number,
  ): string {
    if (lastWsUpdateAt === null) return 'polling';
    const age = now.getTime() - lastWsUpdateAt.getTime();
    return age >= stalenessThresholdMs ? 'stale_fallback' : 'websocket';
  }

  /**
   * Pre-trade dual-leg depth gate (Story 10-7-1).
   * Verifies BOTH platforms have sufficient depth before EITHER leg is submitted.
   * Returns fail-closed on API errors (getAvailableDepth returns 0).
   */
  async validateDualLegDepth(
    params: ValidateDualLegDepthParams,
  ): Promise<DualLegDepthResult> {
    const [primaryDepth, secondaryDepth] = await Promise.all([
      this.getAvailableDepth(
        params.primaryConnector,
        params.primaryContractId,
        params.primarySide,
        params.primaryPrice,
        params.primaryPlatform,
      ),
      this.getAvailableDepth(
        params.secondaryConnector,
        params.secondaryContractId,
        params.secondarySide,
        params.secondaryPrice,
        params.secondaryPlatform,
      ),
    ]);

    const minDepthRequired = Math.ceil(
      params.idealCount * this.dualLegMinDepthRatio,
    );

    if (primaryDepth < minDepthRequired || secondaryDepth < minDepthRequired) {
      this.logger.warn({
        message: 'Dual-leg depth gate rejected opportunity',
        module: 'execution',
        data: {
          idealCount: params.idealCount,
          minDepthRequired,
          primaryDepth,
          secondaryDepth,
          primaryPlatform: params.primaryPlatform,
          secondaryPlatform: params.secondaryPlatform,
          dualLegMinDepthRatio: this.dualLegMinDepthRatio,
        },
      });

      return {
        passed: false,
        primaryDepth,
        secondaryDepth,
        minDepthRequired,
        reason: `insufficient dual-leg depth: ${params.primaryPlatform}=${primaryDepth} ${params.secondaryPlatform}=${secondaryDepth} required=${minDepthRequired}`,
      };
    }

    return {
      passed: true,
      primaryDepth,
      secondaryDepth,
      minDepthRequired,
    };
  }

  /** Proxy divergence status from DataDivergenceService for execution metadata. */
  getDivergenceStatus(): {
    kalshi: string;
    polymarket: string;
    divergenceDetected: boolean;
  } {
    const kalshi = this.dataDivergenceService.getDivergenceStatus(
      PlatformId.KALSHI,
    );
    const polymarket = this.dataDivergenceService.getDivergenceStatus(
      PlatformId.POLYMARKET,
    );
    return {
      kalshi,
      polymarket,
      divergenceDetected: kalshi === 'divergent' || polymarket === 'divergent',
    };
  }
}
