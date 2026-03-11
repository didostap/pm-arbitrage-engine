import { Logger } from '@nestjs/common';

export interface RateLimitTier {
  read: number;
  write: number;
}

export const RATE_LIMIT_TIERS: Record<string, RateLimitTier> = {
  BASIC: { read: 20, write: 10 },
  ADVANCED: { read: 30, write: 30 },
  PREMIER: { read: 100, write: 100 },
  PRIME: { read: 400, write: 400 },
};

const SAFETY_BUFFER = 0.8; // Use only 80% of published limit
const ALERT_THRESHOLD = 0.7; // Alert at 70% utilization
const BURST_MULTIPLIER = 1.5; // Burst bucket = 1.5× sustained rate

/**
 * Dual-bucket token bucket rate limiter.
 * Enforces separate read/write rate limits with 20% safety buffer
 * and 70% utilization alerts.
 */
export class RateLimiter {
  private readonly logger: Logger;
  private readTokens: number;
  private writeTokens: number;
  private lastRefill: number;

  constructor(
    private readonly maxReadTokens: number,
    private readonly maxWriteTokens: number,
    private readonly readRefillRatePerSec: number,
    private readonly writeRefillRatePerSec: number,
    logger?: Logger,
  ) {
    this.logger = logger ?? new Logger(RateLimiter.name);
    this.readTokens = maxReadTokens;
    this.writeTokens = maxWriteTokens;
    this.lastRefill = Date.now();
  }

  /**
   * Create a rate limiter from a tier name with safety buffer applied.
   */
  static fromTier(tier: string, logger?: Logger): RateLimiter {
    const tierConfig = RATE_LIMIT_TIERS[tier];
    if (!tierConfig) {
      throw new Error(`Unknown rate limit tier: ${tier}`);
    }
    return RateLimiter.fromLimits(tierConfig.read, tierConfig.write, logger);
  }

  /**
   * Create a rate limiter from raw per-second limits.
   * Bucket size = ceil(limit × BURST_MULTIPLIER), refill rate = limit × SAFETY_BUFFER.
   */
  static fromLimits(
    readLimit: number,
    writeLimit: number,
    logger?: Logger,
  ): RateLimiter {
    if (readLimit <= 0 || writeLimit <= 0) {
      throw new Error(
        `Invalid rate limits: readLimit=${readLimit}, writeLimit=${writeLimit} (must be positive)`,
      );
    }
    const readBurst = Math.ceil(readLimit * BURST_MULTIPLIER);
    const writeBurst = Math.ceil(writeLimit * BURST_MULTIPLIER);
    const readSustained = readLimit * SAFETY_BUFFER;
    const writeSustained = writeLimit * SAFETY_BUFFER;

    const limiter = new RateLimiter(
      readBurst,
      writeBurst,
      readSustained,
      writeSustained,
      logger,
    );

    limiter.logger.log({
      message: 'Rate limiter configured',
      data: { readBurst, writeBurst, readSustained, writeSustained },
    });

    return limiter;
  }

  async acquireRead(): Promise<void> {
    this.refill();
    await this.waitIfNeeded(this.readTokens, this.readRefillRatePerSec);
    this.readTokens--;
    this.checkUtilization('read', this.readTokens, this.maxReadTokens);
  }

  async acquireWrite(): Promise<void> {
    this.refill();
    await this.waitIfNeeded(this.writeTokens, this.writeRefillRatePerSec);
    this.writeTokens--;
    this.checkUtilization('write', this.writeTokens, this.maxWriteTokens);
  }

  getUtilization(): { read: number; write: number } {
    this.refill();
    return {
      read: (1 - this.readTokens / this.maxReadTokens) * 100,
      write: (1 - this.writeTokens / this.maxWriteTokens) * 100,
    };
  }

  private checkUtilization(
    type: 'read' | 'write',
    tokens: number,
    maxTokens: number,
  ): void {
    const utilization = 1 - tokens / maxTokens;
    if (utilization >= ALERT_THRESHOLD) {
      this.logger.warn({
        message: 'Rate limit utilization high',
        module: 'connector',
        type,
        utilization: `${(utilization * 100).toFixed(1)}%`,
        tokensRemaining: tokens,
      });
    }
  }

  private async waitIfNeeded(
    tokens: number,
    refillRate: number,
  ): Promise<void> {
    if (tokens < 1) {
      const waitMs = (1 / refillRate) * 1000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.refill();
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const readToAdd = elapsed * this.readRefillRatePerSec;
    const writeToAdd = elapsed * this.writeRefillRatePerSec;

    if (readToAdd >= 0.01 || writeToAdd >= 0.01) {
      this.readTokens = Math.min(
        this.maxReadTokens,
        this.readTokens + readToAdd,
      );
      this.writeTokens = Math.min(
        this.maxWriteTokens,
        this.writeTokens + writeToAdd,
      );
      this.lastRefill = now;
    }
  }
}
