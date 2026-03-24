/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { SettingsService } from './settings.service.js';
import { EngineConfigRepository } from '../persistence/repositories/engine-config.repository.js';
import { AuditLogService } from '../modules/monitoring/audit-log.service.js';
import type { EffectiveConfig } from '../common/config/effective-config.types.js';
import { CONFIG_DEFAULTS } from '../common/config/config-defaults.js';
import { RISK_MANAGER_TOKEN } from '../modules/risk-management/risk-management.constants.js';
import { TelegramAlertService } from '../modules/monitoring/telegram-alert.service.js';
import { ExitMonitorService } from '../modules/exit-management/exit-monitor.service.js';
import { EXECUTION_ENGINE_TOKEN } from '../modules/execution/execution.constants.js';
import { DataIngestionService } from '../modules/data-ingestion/data-ingestion.service.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function buildMockEffectiveConfig(
  overrides: Partial<EffectiveConfig> = {},
): EffectiveConfig {
  return {
    bankrollUsd: '10000',
    paperBankrollUsd: null,
    pollingIntervalMs: 30000,
    detectionMinEdgeThreshold: '0.008',
    detectionGasEstimateUsd: '0.30',
    detectionPositionSizeUsd: '300',
    minAnnualizedReturn: '0.15',
    gasBufferPercent: 20,
    gasPollIntervalMs: 30000,
    gasPolPriceFallbackUsd: '0.40',
    polymarketSettlementGasUnits: 150000,
    executionMinFillRatio: '0.25',
    riskMaxPositionPct: '0.03',
    riskMaxOpenPairs: 10,
    riskDailyLossPct: '0.05',
    clusterLlmTimeoutMs: 15000,
    riskClusterHardLimitPct: '0.15',
    riskClusterSoftLimitPct: '0.12',
    riskAggregateClusterLimitPct: '0.50',
    telegramTestAlertCron: '0 8 * * *',
    telegramTestAlertTimezone: 'UTC',
    telegramSendTimeoutMs: 2000,
    telegramMaxRetries: 3,
    telegramBufferMaxSize: 100,
    telegramCircuitBreakMs: 60000,
    csvEnabled: true,
    llmPrimaryProvider: 'gemini',
    llmPrimaryModel: 'gemini-2.5-flash',
    llmEscalationProvider: 'anthropic',
    llmEscalationModel: 'claude-haiku-4-5-20251001',
    llmEscalationMin: 60,
    llmEscalationMax: 84,
    llmAutoApproveThreshold: 85,
    llmMinReviewThreshold: 40,
    llmMaxTokens: 1024,
    llmTimeoutMs: 30000,
    discoveryEnabled: true,
    discoveryRunOnStartup: false,
    discoveryCronExpression: '0 0 8,20 * * *',
    discoveryPrefilterThreshold: '0.25',
    discoverySettlementWindowDays: 7,
    discoveryMaxCandidatesPerContract: 20,
    discoveryLlmConcurrency: 10,
    resolutionPollerEnabled: true,
    resolutionPollerCronExpression: '0 0 6 * * *',
    resolutionPollerBatchSize: 100,
    calibrationEnabled: true,
    calibrationCronExpression: '0 0 7 1 */3 *',
    orderbookStalenessThresholdMs: 90000,
    wsStalenessThresholdMs: 60000,
    kalshiPollingConcurrency: 10,
    polymarketPollingConcurrency: 5,
    auditLogRetentionDays: 7,
    stressTestScenarios: 1000,
    stressTestDefaultDailyVol: '0.03',
    stressTestMinSnapshots: 30,
    autoUnwindEnabled: false,
    autoUnwindDelayMs: 2000,
    autoUnwindMaxLossPct: 5,
    adaptiveSequencingEnabled: true,
    adaptiveSequencingLatencyThresholdMs: 200,
    polymarketOrderPollTimeoutMs: 5000,
    polymarketOrderPollIntervalMs: 500,
    exitMode: 'fixed',
    exitEdgeEvapMultiplier: -1.0,
    exitConfidenceDropPct: 20,
    exitTimeDecayHorizonH: 168,
    exitTimeDecaySteepness: 2.0,
    exitTimeDecayTrigger: 0.8,
    exitRiskBudgetPct: 85,
    exitRiskRankCutoff: 1,
    exitMinDepth: 5,
    exitProfitCaptureRatio: 0.5,
    depthEdgeScalingFactor: '10',
    maxDynamicEdgeThreshold: '0.05',
    pairCooldownMinutes: 30,
    pairMaxConcurrentPositions: 2,
    pairDiversityThreshold: 5,
    ...overrides,
  };
}

function createMockEngineConfigRepository() {
  return {
    get: vi.fn().mockResolvedValue(null),
    getEffectiveConfig: vi.fn().mockResolvedValue(buildMockEffectiveConfig()),
    upsert: vi.fn().mockResolvedValue({}),
    upsertBankroll: vi.fn(),
  } as unknown as EngineConfigRepository;
}

function createMockEventEmitter() {
  return {
    emit: vi.fn(),
    emitAsync: vi.fn(),
  } as unknown as EventEmitter2;
}

function createMockAuditLogService() {
  return {
    append: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogService;
}

function createMockConfigService() {
  return {
    get: vi.fn().mockReturnValue(undefined),
  } as unknown as ConfigService;
}

function createMockReloadableService(name: string) {
  return {
    reloadConfig: vi.fn().mockResolvedValue(undefined),
    name,
  };
}

const EXPECTED_GROUPS = [
  'Exit Strategy',
  'Risk Management',
  'Execution',
  'Auto-Unwind',
  'Detection & Edge',
  'Discovery',
  'LLM Scoring',
  'Resolution & Calibration',
  'Data Quality & Staleness',
  'Paper Trading',
  'Trading Engine',
  'Gas Estimation',
  'Telegram',
  'Logging & Compliance',
  'Stress Testing',
];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SettingsService', () => {
  let engineConfigRepository: ReturnType<
    typeof createMockEngineConfigRepository
  >;
  let eventEmitter: ReturnType<typeof createMockEventEmitter>;
  let auditLogService: ReturnType<typeof createMockAuditLogService>;
  let riskManagerService: ReturnType<typeof createMockReloadableService>;
  let telegramAlertService: ReturnType<typeof createMockReloadableService>;
  let exitMonitorService: ReturnType<typeof createMockReloadableService>;
  let executionService: ReturnType<typeof createMockReloadableService>;
  let dataIngestionService: ReturnType<typeof createMockReloadableService>;
  let service: SettingsService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    engineConfigRepository = createMockEngineConfigRepository();
    eventEmitter = createMockEventEmitter();
    auditLogService = createMockAuditLogService();
    riskManagerService = createMockReloadableService('RiskManagerService');
    telegramAlertService = createMockReloadableService('TelegramAlertService');
    exitMonitorService = createMockReloadableService('ExitMonitorService');
    executionService = createMockReloadableService('ExecutionService');
    dataIngestionService = createMockReloadableService('DataIngestionService');

    // Build mock ModuleRef that returns mock services for known tokens
    const serviceMap = new Map<unknown, unknown>();
    serviceMap.set(RISK_MANAGER_TOKEN, riskManagerService);
    serviceMap.set(TelegramAlertService, telegramAlertService);
    serviceMap.set(ExitMonitorService, exitMonitorService);
    serviceMap.set(EXECUTION_ENGINE_TOKEN, executionService);
    serviceMap.set(DataIngestionService, dataIngestionService);

    const mockModuleRef = {
      get: vi.fn((token: unknown) => {
        const svc = serviceMap.get(token);
        if (!svc)
          throw new Error(`Service not found for token: ${String(token)}`);
        return svc;
      }),
    } as unknown as ModuleRef;

    service = new SettingsService(
      engineConfigRepository as unknown as EngineConfigRepository,
      auditLogService as unknown as AuditLogService,
      eventEmitter as unknown as EventEmitter2,
      createMockConfigService(),
      mockModuleRef,
    );

    // Trigger handler registration (simulates onModuleInit)
    service.onModuleInit();
  });

  // ==========================================================================
  // AC 1: getSettings()
  // ==========================================================================

  describe('getSettings (AC 1)', () => {
    it('[P1] returns all settings grouped by 15 sections', async () => {
      const result = await service.getSettings();
      const groups = Object.keys(result);
      expect(groups).toHaveLength(15);
      expect(groups.sort()).toEqual([...EXPECTED_GROUPS].sort());
    });

    it('[P1] each setting includes key, currentValue, envDefault, dataType, description, group', async () => {
      const result = await service.getSettings();
      const allSettings = Object.values(result).flat();

      for (const setting of allSettings) {
        expect(setting).toHaveProperty('key');
        expect(setting).toHaveProperty('currentValue');
        expect(setting).toHaveProperty('envDefault');
        expect(setting).toHaveProperty('dataType');
        expect(setting).toHaveProperty('description');
        expect(setting).toHaveProperty('group');
      }

      // 80 settings (81 CONFIG_DEFAULTS minus bankrollUsd)
      expect(allSettings.length).toBe(80);
    });

    it('[P0] currentValue falls back to env default when DB column is NULL', async () => {
      const configWithDefault = buildMockEffectiveConfig({
        detectionMinEdgeThreshold:
          CONFIG_DEFAULTS.detectionMinEdgeThreshold.defaultValue,
      });
      (
        engineConfigRepository.getEffectiveConfig as ReturnType<typeof vi.fn>
      ).mockResolvedValue(configWithDefault);

      const result = await service.getSettings();
      const allSettings = Object.values(result).flat();
      const edgeSetting = allSettings.find(
        (s) => s.key === 'detectionMinEdgeThreshold',
      );

      expect(edgeSetting).toBeDefined();
      expect(edgeSetting!.currentValue).toBe('0.008');
      expect(edgeSetting!.envDefault).toBe('0.008');
    });
  });

  // ==========================================================================
  // AC 2: updateSettings()
  // ==========================================================================

  describe('updateSettings (AC 2)', () => {
    it('[P1] calls engineConfigRepository.upsert() with correct fields', async () => {
      const updatePayload = {
        riskMaxPositionPct: '0.05',
        riskMaxOpenPairs: 15,
      };

      await service.updateSettings(updatePayload, 'dashboard');

      expect(engineConfigRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          riskMaxPositionPct: '0.05',
          riskMaxOpenPairs: 15,
        }),
      );
    });

    it('[P1] returns full updated settings grouped by section', async () => {
      const updatedConfig = buildMockEffectiveConfig({
        riskMaxPositionPct: '0.05',
      });
      (engineConfigRepository.getEffectiveConfig as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(buildMockEffectiveConfig()) // snapshot before
        .mockResolvedValueOnce(updatedConfig); // after update

      const result = await service.updateSettings(
        { riskMaxPositionPct: '0.05' },
        'dashboard',
      );

      const groups = Object.keys(result);
      expect(groups).toHaveLength(15);

      const allSettings = Object.values(result).flat();
      const riskSetting = allSettings.find(
        (s) => s.key === 'riskMaxPositionPct',
      );
      expect(riskSetting!.currentValue).toBe('0.05');
    });

    it('[P1] updates multiple fields in single request', async () => {
      const multiUpdate = {
        telegramSendTimeoutMs: 5000,
        telegramMaxRetries: 5,
        telegramBufferMaxSize: 200,
      };

      await service.updateSettings(multiUpdate, 'dashboard');

      expect(engineConfigRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining(multiUpdate),
      );
      expect(engineConfigRepository.upsert).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // AC 3: resetSettings()
  // ==========================================================================

  describe('resetSettings (AC 3)', () => {
    it('[P1] sets specific keys to NULL via upsert', async () => {
      const keysToReset = ['telegramSendTimeoutMs', 'telegramMaxRetries'];

      await service.resetSettings(keysToReset, 'dashboard');

      expect(engineConfigRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          telegramSendTimeoutMs: null,
          telegramMaxRetries: null,
        }),
      );
    });

    it('[P1] resets all Category B keys when keys array is empty (excluding bankrollUsd)', async () => {
      await service.resetSettings([], 'dashboard');

      const upsertCall = (
        engineConfigRepository.upsert as ReturnType<typeof vi.fn>
      ).mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(upsertCall).toBeDefined();

      const configDefaultKeys = Object.keys(CONFIG_DEFAULTS);
      for (const key of configDefaultKeys) {
        if (key === 'bankrollUsd') {
          expect(upsertCall).not.toHaveProperty('bankrollUsd');
        } else {
          expect(upsertCall![key]).toBeNull();
        }
      }
    });

    it('[P1] returns new effective settings after reset', async () => {
      const defaultConfig = buildMockEffectiveConfig();
      (engineConfigRepository.getEffectiveConfig as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(
          buildMockEffectiveConfig({ telegramSendTimeoutMs: 5000 }),
        )
        .mockResolvedValueOnce(defaultConfig);

      const result = await service.resetSettings(
        ['telegramSendTimeoutMs'],
        'dashboard',
      );

      const allSettings = Object.values(result).flat();
      const telegramSetting = allSettings.find(
        (s) => s.key === 'telegramSendTimeoutMs',
      );
      expect(telegramSetting!.currentValue).toBe(2000);
    });
  });

  // ==========================================================================
  // AC 5: Hot-reload mechanism
  // ==========================================================================

  describe('hot-reload (AC 5)', () => {
    it('[P0] triggers reloadConfig() only on services whose settings changed', async () => {
      const riskUpdate = { riskMaxPositionPct: '0.05' };

      await service.updateSettings(riskUpdate, 'dashboard');

      expect(riskManagerService.reloadConfig).toHaveBeenCalledTimes(1);
      expect(telegramAlertService.reloadConfig).not.toHaveBeenCalled();
      expect(exitMonitorService.reloadConfig).not.toHaveBeenCalled();
      expect(executionService.reloadConfig).not.toHaveBeenCalled();
      expect(dataIngestionService.reloadConfig).not.toHaveBeenCalled();
    });

    it('[P1] emits ConfigSettingsUpdatedEvent with changedFields, previous/current values, updatedBy', async () => {
      const previousConfig = buildMockEffectiveConfig();
      const updatedConfig = buildMockEffectiveConfig({
        riskMaxPositionPct: '0.05',
        riskMaxOpenPairs: 15,
      });
      (engineConfigRepository.getEffectiveConfig as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(previousConfig)
        .mockResolvedValueOnce(updatedConfig);

      await service.updateSettings(
        { riskMaxPositionPct: '0.05', riskMaxOpenPairs: 15 },
        'dashboard',
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'config.settings.updated',
        expect.objectContaining({
          changedFields: expect.objectContaining({
            riskMaxPositionPct: { previous: '0.03', current: '0.05' },
            riskMaxOpenPairs: { previous: 10, current: 15 },
          }),
          updatedBy: 'dashboard',
        }),
      );
    });

    it('[P0] if service reloadConfig() throws, error is logged but DB update NOT rolled back', async () => {
      riskManagerService.reloadConfig = vi
        .fn()
        .mockRejectedValue(new Error('Reload failed'));

      const previousConfig = buildMockEffectiveConfig();
      const updatedConfig = buildMockEffectiveConfig({
        riskMaxPositionPct: '0.05',
      });
      (engineConfigRepository.getEffectiveConfig as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(previousConfig)
        .mockResolvedValueOnce(updatedConfig);

      const updatePayload = { riskMaxPositionPct: '0.05' };

      await expect(
        service.updateSettings(updatePayload, 'dashboard'),
      ).resolves.toBeDefined();

      expect(engineConfigRepository.upsert).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalled();
      expect(Logger.prototype.error).toHaveBeenCalled();
    });

    it('[P1] deduplicates service reload calls when multiple keys map to same service', async () => {
      const multiRiskUpdate = {
        riskMaxPositionPct: '0.05',
        riskMaxOpenPairs: 15,
        riskDailyLossPct: '0.10',
      };

      await service.updateSettings(multiRiskUpdate, 'dashboard');

      expect(riskManagerService.reloadConfig).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // AC 8: Audit logging
  // ==========================================================================

  describe('audit logging (AC 8)', () => {
    it('[P1] PATCH creates audit log with eventType CONFIG_SETTINGS_UPDATED', async () => {
      const previousConfig = buildMockEffectiveConfig();
      const updatedConfig = buildMockEffectiveConfig({ riskMaxOpenPairs: 15 });
      (engineConfigRepository.getEffectiveConfig as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(previousConfig)
        .mockResolvedValueOnce(updatedConfig);

      await service.updateSettings({ riskMaxOpenPairs: 15 }, 'dashboard');

      expect(auditLogService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'config.settings.updated',
          module: 'dashboard',
        }),
      );
    });

    it('[P1] reset creates audit log with eventType CONFIG_SETTINGS_RESET', async () => {
      const previousConfig = buildMockEffectiveConfig({
        telegramSendTimeoutMs: 5000,
      });
      const resetConfig = buildMockEffectiveConfig({
        telegramSendTimeoutMs: 2000,
      });
      (engineConfigRepository.getEffectiveConfig as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(previousConfig)
        .mockResolvedValueOnce(resetConfig);

      await service.resetSettings(['telegramSendTimeoutMs'], 'dashboard');

      expect(auditLogService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'config.settings.reset',
          module: 'dashboard',
        }),
      );
    });

    it('[P1] audit log details contain changedFields with previous/current values', async () => {
      const previousConfig = buildMockEffectiveConfig();
      const updatedConfig = buildMockEffectiveConfig({
        executionMinFillRatio: '0.50',
      });
      (engineConfigRepository.getEffectiveConfig as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(previousConfig)
        .mockResolvedValueOnce(updatedConfig);

      await service.updateSettings(
        { executionMinFillRatio: '0.50' },
        'dashboard',
      );

      expect(auditLogService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            changedFields: expect.objectContaining({
              executionMinFillRatio: { previous: '0.25', current: '0.50' },
            }),
            updatedBy: 'dashboard',
          }),
        }),
      );
    });
  });
});
