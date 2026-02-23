import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createPublicClient, http } from 'viem';
import { polygon } from 'viem/chains';
import Decimal from 'decimal.js';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { PlatformGasUpdatedEvent } from '../../common/events/platform.events';
import { PlatformApiError } from '../../common/errors/platform-api-error';
import { ConfigValidationError } from '../../common/errors/config-validation-error';
import { PlatformId } from '../../common/types/platform.type';
import { POLYMARKET_ERROR_CODES } from './polymarket-error-codes';

const CACHE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

interface CachedValue<T> {
  value: T;
  updatedAt: number;
}

@Injectable()
export class GasEstimationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GasEstimationService.name);
  private readonly publicClient;
  private readonly bufferMultiplier: Decimal;
  private readonly gasUnits: Decimal;
  private readonly polPriceFallbackUsd: string;
  private readonly staticFallbackUsd: number;
  private readonly pollIntervalMs: number;

  private cachedGasPrice: CachedValue<bigint> | null = null;
  private cachedPolPriceUsd: CachedValue<string> | null = null;
  private lastEstimateUsd: Decimal;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    const bufferPercent = this.configService.get<number>(
      'GAS_BUFFER_PERCENT',
      20,
    );
    this.bufferMultiplier = new Decimal(1).plus(
      new Decimal(bufferPercent).div(100),
    );
    this.gasUnits = new Decimal(
      this.configService.get<number>('POLYMARKET_SETTLEMENT_GAS_UNITS', 150000),
    );
    this.polPriceFallbackUsd = this.configService.get<string>(
      'GAS_POL_PRICE_FALLBACK_USD',
      '0.40',
    );
    this.staticFallbackUsd = this.configService.get<number>(
      'DETECTION_GAS_ESTIMATE_USD',
      0.3,
    );
    this.pollIntervalMs = this.configService.get<number>(
      'GAS_POLL_INTERVAL_MS',
      30000,
    );

    // Validate config before creating any resources
    const validationErrors: string[] = [];
    if (this.bufferMultiplier.lessThanOrEqualTo(0)) {
      validationErrors.push(
        'GAS_BUFFER_PERCENT must result in positive multiplier',
      );
    }
    if (this.gasUnits.lessThanOrEqualTo(0)) {
      validationErrors.push('POLYMARKET_SETTLEMENT_GAS_UNITS must be positive');
    }
    if (this.pollIntervalMs <= 0) {
      validationErrors.push('GAS_POLL_INTERVAL_MS must be positive');
    }
    if (validationErrors.length > 0) {
      throw new ConfigValidationError(
        'GasEstimationService config invalid',
        validationErrors,
      );
    }

    // Create viem client after validation — no resource leak on config error
    const rpcUrl = this.configService.get<string>(
      'POLYMARKET_RPC_URL',
      'https://polygon-rpc.com',
    );
    this.publicClient = createPublicClient({
      chain: polygon,
      transport: http(rpcUrl),
    });

    this.lastEstimateUsd = new Decimal(this.staticFallbackUsd);
  }

  async onModuleInit(): Promise<void> {
    await this.poll();
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  onModuleDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Returns current gas estimate in USD with buffer applied.
   * Fallback chain: cached dynamic → static config. Never throws.
   */
  getGasEstimateUsd(): Decimal {
    const now = Date.now();
    const gasPrice = this.getFreshCachedValue(this.cachedGasPrice, now);
    const polPriceUsd = this.getFreshCachedValue(this.cachedPolPriceUsd, now);

    // If we have both cached values, compute dynamic estimate
    if (gasPrice !== null && polPriceUsd !== null) {
      return this.computeGasEstimate(gasPrice, polPriceUsd);
    }

    // If we have gas price but no POL price, use fallback POL price
    if (gasPrice !== null) {
      return this.computeGasEstimate(gasPrice, this.polPriceFallbackUsd);
    }

    // No cached gas price → static fallback
    return new Decimal(this.staticFallbackUsd);
  }

  /**
   * Single poll cycle: fetch gas price + POL/USD in parallel.
   * Exposed for testing; called by interval in production.
   */
  async poll(): Promise<void> {
    const [gasResult, polResult] = await Promise.allSettled([
      this.fetchGasPrice(),
      this.fetchPolPriceUsd(),
    ]);

    if (gasResult.status === 'fulfilled' && gasResult.value !== null) {
      this.cachedGasPrice = {
        value: gasResult.value,
        updatedAt: Date.now(),
      };
    } else if (gasResult.status === 'rejected') {
      const error = new PlatformApiError(
        POLYMARKET_ERROR_CODES.GAS_ESTIMATION_FAILED,
        `Gas price fetch failed: ${String(gasResult.reason)}`,
        PlatformId.POLYMARKET,
        'warning',
        undefined,
        { source: 'rpc' },
      );
      this.logger.warn({
        message: error.message,
        code: error.code,
        severity: error.severity,
      });
    }

    if (polResult.status === 'fulfilled' && polResult.value !== null) {
      this.cachedPolPriceUsd = {
        value: polResult.value,
        updatedAt: Date.now(),
      };
    } else if (polResult.status === 'rejected') {
      const error = new PlatformApiError(
        POLYMARKET_ERROR_CODES.GAS_ESTIMATION_FAILED,
        `POL/USD price fetch failed: ${String(polResult.reason)}`,
        PlatformId.POLYMARKET,
        'warning',
        undefined,
        { source: 'coingecko' },
      );
      this.logger.warn({
        message: error.message,
        code: error.code,
        severity: error.severity,
      });
    }

    // Check for significant change and emit event
    const newEstimate = this.getGasEstimateUsd();
    if (!this.lastEstimateUsd.isZero()) {
      const changePct = newEstimate
        .minus(this.lastEstimateUsd)
        .abs()
        .div(this.lastEstimateUsd)
        .mul(100);

      if (changePct.greaterThan(10)) {
        this.eventEmitter.emit(
          EVENT_NAMES.PLATFORM_GAS_UPDATED,
          new PlatformGasUpdatedEvent(
            this.lastEstimateUsd.toFixed(8),
            newEstimate.toFixed(8),
            changePct.toFixed(2),
          ),
        );
      }
    }
    this.lastEstimateUsd = newEstimate;
  }

  private computeGasEstimate(
    gasPriceWei: bigint,
    polPriceUsd: string,
  ): Decimal {
    const gasPriceDecimal = new Decimal(gasPriceWei.toString());
    const polPrice = new Decimal(polPriceUsd);
    const oneEth = new Decimal(10).pow(18);

    return gasPriceDecimal
      .mul(this.gasUnits)
      .mul(polPrice)
      .div(oneEth)
      .mul(this.bufferMultiplier);
  }

  private getFreshCachedValue<T>(
    cached: CachedValue<T> | null,
    now: number,
  ): T | null {
    if (cached === null) return null;
    if (now - cached.updatedAt > CACHE_MAX_AGE_MS) return null;
    return cached.value;
  }

  private async fetchGasPrice(): Promise<bigint> {
    return this.publicClient.getGasPrice();
  }

  private async fetchPolPriceUsd(): Promise<string> {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=polygon-ecosystem-token&vs_currencies=usd',
      { signal: AbortSignal.timeout(5000) },
    );

    if (!response.ok) {
      throw new Error(`CoinGecko HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      'polygon-ecosystem-token': { usd: number };
    };
    return String(data['polygon-ecosystem-token'].usd);
  }
}
