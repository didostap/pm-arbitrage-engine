/**
 * Story 10-5.2 AC1-5, AC8 — Settings CRUD service.
 *
 * Orchestrates: DB read/write → per-module hot-reload → audit log → event emission.
 * Follows the bankroll precedent (dashboard.service.ts:174-190).
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { EngineConfigRepository } from '../persistence/repositories/engine-config.repository.js';
import { AuditLogService } from '../modules/monitoring/audit-log.service.js';
import { EVENT_NAMES } from '../common/events/event-catalog.js';
import {
  ConfigSettingsUpdatedEvent,
  type ConfigFieldValue,
} from '../common/events/config.events.js';
import {
  SETTINGS_METADATA,
  SettingsGroup,
} from '../common/config/settings-metadata.js';
import { CONFIG_DEFAULTS } from '../common/config/config-defaults.js';
import { RESETTABLE_SETTINGS_KEYS } from '../common/config/settings-metadata.js';
import type { EffectiveConfig } from '../common/config/effective-config.types.js';
import { RISK_MANAGER_TOKEN } from '../modules/risk-management/risk-management.constants.js';
import { EXECUTION_ENGINE_TOKEN } from '../modules/execution/execution.constants.js';
import { TelegramAlertService } from '../modules/monitoring/telegram-alert.service.js';
import { ExitMonitorService } from '../modules/exit-management/exit-monitor.service.js';
import { DataIngestionService } from '../modules/data-ingestion/data-ingestion.service.js';
import { CandidateDiscoveryService } from '../modules/contract-matching/candidate-discovery.service.js';
import { ExternalPairIngestionService } from '../modules/contract-matching/external-pair-ingestion.service.js';
import { ResolutionPollerService } from '../modules/contract-matching/resolution-poller.service.js';
import { CalibrationService } from '../modules/contract-matching/calibration.service.js';
import { SchedulerService } from '../core/scheduler.service.js';
import { EdgeCalculatorService } from '../modules/arbitrage-detection/edge-calculator.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SettingEntry {
  key: string;
  currentValue: unknown;
  envDefault: unknown;
  dataType: string;
  description: string;
  group: string;
  label: string;
  min?: number;
  max?: number;
  options?: string[];
  unit?: string;
}

export type GroupedSettings = Record<string, SettingEntry[]>;

/** JSON-serializable record of field changes (compatible with Prisma InputJsonValue) */
type ChangedFieldsRecord = Record<
  string,
  { previous: ConfigFieldValue; current: ConfigFieldValue }
>;

/** Callback-based reload handler — receives fresh EffectiveConfig */
type ReloadHandler = (config: EffectiveConfig) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Hot-reload dispatch map: setting key → service tags
// ---------------------------------------------------------------------------

const SERVICE_RELOAD_MAP: Record<string, string[]> = {
  // Risk
  riskMaxPositionPct: ['risk'],
  riskMaxOpenPairs: ['risk'],
  riskDailyLossPct: ['risk'],
  riskClusterHardLimitPct: ['risk'],
  riskClusterSoftLimitPct: ['risk'],
  riskAggregateClusterLimitPct: ['risk'],
  clusterLlmTimeoutMs: ['risk'],

  // Telegram
  telegramSendTimeoutMs: ['telegram'],
  telegramMaxRetries: ['telegram'],
  telegramBufferMaxSize: ['telegram'],
  telegramCircuitBreakMs: ['telegram'],
  telegramTestAlertTimezone: ['telegram'],

  // Exit Monitor
  wsStalenessThresholdMs: ['exit-monitor'],
  exitMode: ['exit-monitor'],
  exitEdgeEvapMultiplier: ['exit-monitor'],
  exitConfidenceDropPct: ['exit-monitor'],
  exitTimeDecayHorizonH: ['exit-monitor'],
  exitTimeDecaySteepness: ['exit-monitor'],
  exitTimeDecayTrigger: ['exit-monitor'],
  exitRiskBudgetPct: ['exit-monitor'],
  exitRiskRankCutoff: ['exit-monitor'],
  exitMinDepth: ['exit-monitor'],
  exitDepthSlippageTolerance: ['exit-monitor'],
  exitMaxChunkSize: ['exit-monitor'],
  exitProfitCaptureRatio: ['exit-monitor'],

  // Detection
  detectionMinEdgeThreshold: ['detection'],
  detectionMinFillRatio: ['detection'],
  depthEdgeScalingFactor: ['detection'],
  maxDynamicEdgeThreshold: ['detection'],

  // Execution
  executionMinFillRatio: ['execution'],
  dualLegMinDepthRatio: ['execution'],
  adaptiveSequencingEnabled: ['execution'],
  adaptiveSequencingLatencyThresholdMs: ['execution'],
  polymarketOrderPollTimeoutMs: ['execution'],
  polymarketOrderPollIntervalMs: ['execution'],

  // Data Ingestion
  kalshiPollingConcurrency: ['data-ingestion'],
  polymarketPollingConcurrency: ['data-ingestion'],

  // Cron schedules → individual service cron hot-reload
  discoveryCronExpression: ['discovery-cron'],
  resolutionPollerCronExpression: ['resolution-cron'],
  calibrationCronExpression: ['calibration-cron'],
  telegramTestAlertCron: ['telegram', 'telegram-cron'],

  // Polling interval → SchedulerService
  pollingIntervalMs: ['polling-interval'],

  // Trading Window → SchedulerService
  tradingWindowStartUtc: ['trading-window'],
  tradingWindowEndUtc: ['trading-window'],
};

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);

  /** Cleanup: .delete() on unsubscribe, .clear() on shutdown */
  /** Callback-based reload handlers, registered lazily via ModuleRef in onModuleInit */
  private readonly reloadHandlers = new Map<string, ReloadHandler>();

  constructor(
    private readonly engineConfigRepository: EngineConfigRepository,
    private readonly auditLogService: AuditLogService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    this.registerAllHandlers();
  }

  /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
  /** Resolve services via ModuleRef and register callback-based reload handlers. */
  private registerAllHandlers(): void {
    // Standard reloadConfig services
    this.tryRegisterHandler('risk', RISK_MANAGER_TOKEN, (svc) =>
      svc.reloadConfig(),
    );
    this.tryRegisterHandler('telegram', TelegramAlertService, (svc, cfg) =>
      svc.reloadConfig(cfg),
    );
    this.tryRegisterHandler('exit-monitor', ExitMonitorService, (svc, cfg) =>
      svc.reloadConfig({
        wsStalenessThresholdMs: cfg.wsStalenessThresholdMs,
        exitMode: cfg.exitMode,
        exitEdgeEvapMultiplier: cfg.exitEdgeEvapMultiplier,
        exitConfidenceDropPct: cfg.exitConfidenceDropPct,
        exitTimeDecayHorizonH: cfg.exitTimeDecayHorizonH,
        exitTimeDecaySteepness: cfg.exitTimeDecaySteepness,
        exitTimeDecayTrigger: cfg.exitTimeDecayTrigger,
        exitRiskBudgetPct: cfg.exitRiskBudgetPct,
        exitRiskRankCutoff: cfg.exitRiskRankCutoff,
        exitMinDepth: cfg.exitMinDepth,
        exitDepthSlippageTolerance: cfg.exitDepthSlippageTolerance,
        exitMaxChunkSize: cfg.exitMaxChunkSize,
        exitProfitCaptureRatio: cfg.exitProfitCaptureRatio,
      }),
    );
    this.tryRegisterHandler('detection', EdgeCalculatorService, (svc, cfg) =>
      svc.reloadConfig({
        minEdgeThreshold: cfg.detectionMinEdgeThreshold,
        detectionMinFillRatio: cfg.detectionMinFillRatio,
        depthEdgeScalingFactor: cfg.depthEdgeScalingFactor,
        maxDynamicEdgeThreshold: cfg.maxDynamicEdgeThreshold,
      }),
    );
    this.tryRegisterHandler('execution', EXECUTION_ENGINE_TOKEN, (svc, cfg) =>
      svc.reloadConfig({
        minFillRatio: cfg.executionMinFillRatio,
        dualLegMinDepthRatio: cfg.dualLegMinDepthRatio,
      }),
    );
    this.tryRegisterHandler(
      'data-ingestion',
      DataIngestionService,
      (svc, cfg) =>
        svc.reloadConfig({
          kalshiConcurrency: cfg.kalshiPollingConcurrency,
          polymarketPollingConcurrency: cfg.polymarketPollingConcurrency,
        }),
    );

    // Cron services
    this.tryRegisterHandler(
      'discovery-cron',
      CandidateDiscoveryService,
      (svc, cfg) => svc.reloadCron(cfg.discoveryCronExpression),
    );
    this.tryRegisterHandler(
      'resolution-cron',
      ResolutionPollerService,
      (svc, cfg) => svc.reloadCron(cfg.resolutionPollerCronExpression),
    );
    this.tryRegisterHandler(
      'calibration-cron',
      CalibrationService,
      (svc, cfg) => svc.reloadCron(cfg.calibrationCronExpression),
    );
    this.tryRegisterHandler(
      'external-pair-ingestion-cron',
      ExternalPairIngestionService,
      (svc, cfg) => svc.reloadCron(cfg.externalPairIngestionCronExpression),
    );

    // Polling interval
    this.tryRegisterHandler('polling-interval', SchedulerService, (svc, cfg) =>
      svc.reloadPollingInterval(cfg.pollingIntervalMs),
    );

    // Trading window
    this.tryRegisterHandler('trading-window', SchedulerService, (svc, cfg) =>
      svc.reloadTradingWindow({
        tradingWindowStartUtc: cfg.tradingWindowStartUtc,
        tradingWindowEndUtc: cfg.tradingWindowEndUtc,
      }),
    );
  }

  private tryRegisterHandler(
    tag: string,

    token: string | (new (...args: any[]) => any),

    handlerFactory: (svc: any, cfg: EffectiveConfig) => Promise<void> | void,
  ): void {
    try {
      const svc = this.moduleRef.get(token, { strict: false });
      this.reloadHandlers.set(tag, (cfg) => handlerFactory(svc, cfg));
      this.logger.log({
        message: `Registered reload handler for tag: ${tag}`,
      });
    } catch {
      this.logger.warn({
        message: `Reload handler not registered for ${tag}: service not found in DI container`,
      });
    }
  }
  /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */

  // =========================================================================
  // AC 1: GET — returns all settings grouped by 15 sections
  // =========================================================================

  async getSettings(): Promise<GroupedSettings> {
    const effective = await this.getEffective();
    return this.buildGroupedResponse(effective);
  }

  // =========================================================================
  // AC 2: PATCH — validate, update DB, hot-reload, emit, audit
  // =========================================================================

  async updateSettings(
    dto: Record<string, unknown>,
    updatedBy: string = 'dashboard',
  ): Promise<GroupedSettings> {
    // 1. Snapshot previous config
    const previous = await this.getEffective();

    // 2. Persist to DB
    await this.engineConfigRepository.upsert(
      dto as Parameters<EngineConfigRepository['upsert']>[0],
    );

    // 3. Read back effective config (reflects the update)
    const current = await this.getEffective();

    // 4. Compute changed fields
    const changedFields = this.computeChangedFields(previous, current, dto);

    // 5. Hot-reload affected services (errors logged, never rollback)
    await this.dispatchReloads(Object.keys(dto));

    // 6. Audit log + emit event only if something actually changed
    if (Object.keys(changedFields).length > 0) {
      await this.createAuditLog(
        EVENT_NAMES.CONFIG_SETTINGS_UPDATED,
        changedFields,
        updatedBy,
      );
      this.safeEmitSettingsEvent(changedFields, updatedBy);
    }

    return this.buildGroupedResponse(current);
  }

  // =========================================================================
  // AC 3: POST reset — set columns to NULL, hot-reload, emit, audit
  // =========================================================================

  async resetSettings(
    keys: string[],
    updatedBy: string = 'dashboard',
  ): Promise<GroupedSettings> {
    // Determine which keys to reset
    const keysToReset =
      keys.length === 0 ? [...RESETTABLE_SETTINGS_KEYS] : keys;

    // 1. Snapshot previous config
    const previous = await this.getEffective();

    // 2. Build null fields
    const nullFields: Record<string, null> = {};
    for (const key of keysToReset) {
      nullFields[key] = null;
    }

    // 3. Persist nulls to DB
    await this.engineConfigRepository.upsert(
      nullFields as unknown as Parameters<EngineConfigRepository['upsert']>[0],
    );

    // 4. Read back effective config
    const current = await this.getEffective();

    // 5. Compute changed fields
    const changedFields = this.computeChangedFields(
      previous,
      current,
      nullFields,
    );

    // 6. Hot-reload affected services
    await this.dispatchReloads(keysToReset);

    // 7. Audit log + emit event only if something actually changed
    if (Object.keys(changedFields).length > 0) {
      await this.createAuditLog(
        EVENT_NAMES.CONFIG_SETTINGS_RESET,
        changedFields,
        updatedBy,
      );
      this.safeEmitSettingsEvent(changedFields, updatedBy);
    }

    return this.buildGroupedResponse(current);
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private async getEffective(): Promise<EffectiveConfig> {
    const envFallback = this.buildEnvFallback();
    return this.engineConfigRepository.getEffectiveConfig(envFallback);
  }

  /** Build env fallback from current ConfigService values */
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

  /** Build grouped response from effective config + metadata */
  private buildGroupedResponse(effective: EffectiveConfig): GroupedSettings {
    const groups: GroupedSettings = {};

    // Initialize all 15 groups (including placeholder Paper Trading)
    for (const group of Object.values(SettingsGroup)) {
      groups[group] = [];
    }

    // Populate from metadata (excludes paperBankrollUsd which isn't in CONFIG_DEFAULTS)
    for (const [key, meta] of Object.entries(SETTINGS_METADATA)) {
      // Skip bankrollUsd — it has its own endpoint
      if (key === 'bankrollUsd') continue;

      const configKey = key as keyof EffectiveConfig;
      const entry: SettingEntry = {
        key,
        currentValue: effective[configKey],
        envDefault: meta.envDefault,
        dataType: meta.type,
        description: meta.description,
        group: meta.group,
        label: meta.label,
      };

      if (meta.min !== undefined) entry.min = meta.min;
      if (meta.max !== undefined) entry.max = meta.max;
      if (meta.options) entry.options = meta.options;
      if (meta.unit) entry.unit = meta.unit;

      const groupEntries = groups[meta.group];
      if (groupEntries) {
        groupEntries.push(entry);
      }
    }

    return groups;
  }

  /** Compute which fields actually changed between previous and current config */
  private computeChangedFields(
    previous: EffectiveConfig,
    current: EffectiveConfig,
    requestedKeys: Record<string, unknown>,
  ): ChangedFieldsRecord {
    const changed: ChangedFieldsRecord = {};

    for (const key of Object.keys(requestedKeys)) {
      const configKey = key as keyof EffectiveConfig;
      const prev = previous[configKey];
      const curr = current[configKey];
      if (String(prev) !== String(curr)) {
        changed[key] = { previous: prev ?? null, current: curr ?? null };
      }
    }

    return changed;
  }

  /** Dispatch reload handlers to affected services. Errors are logged, never thrown. */
  private async dispatchReloads(changedKeys: string[]): Promise<void> {
    // Collect unique service tags
    const tags = new Set<string>();
    for (const key of changedKeys) {
      const serviceTags = SERVICE_RELOAD_MAP[key];
      if (serviceTags) {
        for (const tag of serviceTags) {
          tags.add(tag);
        }
      }
    }

    if (tags.size === 0) return;

    // Read fresh config once for all handlers
    const config = await this.getEffective();

    // Reload each affected service
    for (const tag of tags) {
      const handler = this.reloadHandlers.get(tag);
      if (!handler) continue;

      try {
        await handler(config);
        this.logger.log(`Hot-reload completed for service tag: ${tag}`);
      } catch (error) {
        this.logger.error({
          message: `Hot-reload failed for service tag: ${tag}`,
          data: {
            tag,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  /** Emit settings event safely — never block the HTTP response */
  private safeEmitSettingsEvent(
    changedFields: ChangedFieldsRecord,
    updatedBy: string,
  ): void {
    try {
      this.eventEmitter.emit(
        EVENT_NAMES.CONFIG_SETTINGS_UPDATED,
        new ConfigSettingsUpdatedEvent(changedFields, updatedBy),
      );
    } catch (error) {
      this.logger.error({
        message: 'Failed to emit ConfigSettingsUpdatedEvent',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  /** Create audit log entry for settings changes */
  private async createAuditLog(
    eventType: string,
    changedFields: ChangedFieldsRecord,
    updatedBy: string,
  ): Promise<void> {
    try {
      await this.auditLogService.append({
        eventType,
        module: 'dashboard',
        details: { changedFields, updatedBy },
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to create audit log for settings change',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}
