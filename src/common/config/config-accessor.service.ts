/**
 * Story 10-5.2 AC6 Task 7 — ConfigAccessor.
 *
 * Singleton service that caches the fully-resolved EffectiveConfig in memory.
 * Cache invalidated on ConfigSettingsUpdatedEvent via @OnEvent handler.
 * Used by per-call services instead of raw ConfigService.get().
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { EngineConfigRepository } from '../../persistence/repositories/engine-config.repository.js';
import { EVENT_NAMES } from '../events/event-catalog.js';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../errors/system-health-error.js';
import { CONFIG_DEFAULTS } from './config-defaults.js';
import type { EffectiveConfig } from './effective-config.types.js';

@Injectable()
export class ConfigAccessor implements OnModuleInit {
  private readonly logger = new Logger(ConfigAccessor.name);
  private cache: EffectiveConfig | null = null;

  constructor(
    private readonly engineConfigRepository: EngineConfigRepository,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.logger.log({ message: 'ConfigAccessor initialized' });
  }

  /** Get the cached EffectiveConfig. Falls back to refresh if cache is empty. */
  async get(): Promise<EffectiveConfig> {
    if (!this.cache) {
      try {
        await this.refresh();
      } catch (error) {
        throw new SystemHealthError(
          SYSTEM_HEALTH_ERROR_CODES.DATABASE_FAILURE,
          `ConfigAccessor: failed to load EffectiveConfig from DB — ${error instanceof Error ? error.message : String(error)}`,
          'critical',
          'ConfigAccessor',
        );
      }
    }
    if (!this.cache) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.DATABASE_FAILURE,
        'ConfigAccessor: failed to load EffectiveConfig from DB',
        'critical',
        'ConfigAccessor',
      );
    }
    return this.cache;
  }

  /** Get a single config field value. */
  async getField<K extends keyof EffectiveConfig>(
    key: K,
  ): Promise<EffectiveConfig[K]> {
    const config = await this.get();
    return config[key];
  }

  /** Invalidate cache and re-fetch from DB on settings change event. */
  @OnEvent(EVENT_NAMES.CONFIG_SETTINGS_UPDATED)
  async handleSettingsUpdated(): Promise<void> {
    await this.refresh();
    this.logger.log({
      message: 'ConfigAccessor cache refreshed after settings update',
    });
  }

  /** Also invalidate on bankroll update for completeness. */
  @OnEvent(EVENT_NAMES.CONFIG_BANKROLL_UPDATED)
  async handleBankrollUpdated(): Promise<void> {
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const envFallback = this.buildEnvFallback();
    this.cache =
      await this.engineConfigRepository.getEffectiveConfig(envFallback);
  }

  private buildEnvFallback(): Partial<EffectiveConfig> {
    const fallback: Record<string, unknown> = {};
    for (const [field, entry] of Object.entries(CONFIG_DEFAULTS)) {
      const envValue = this.configService.get<unknown>(entry.envKey);
      if (envValue !== undefined) {
        fallback[field] = envValue;
      }
    }
    return fallback as Partial<EffectiveConfig>;
  }
}
