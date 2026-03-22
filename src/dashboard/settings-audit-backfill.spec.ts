/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { DashboardService } from './dashboard.service.js';
import { PrismaService } from '../common/prisma.service.js';
import { PositionRepository } from '../persistence/repositories/position.repository.js';
import { PositionEnrichmentService } from './position-enrichment.service.js';
import type { IRiskManager } from '../common/interfaces/risk-manager.interface.js';
import { EngineConfigRepository } from '../persistence/repositories/engine-config.repository.js';
import { EVENT_NAMES } from '../common/events/event-catalog.js';

// ─── Mock Factories ─────────────────────────────────────────────────────────

function createMockPrisma() {
  return {
    platformHealthLog: { findMany: vi.fn() },
    openPosition: {
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      aggregate: vi.fn(),
    },
    order: { count: vi.fn(), findMany: vi.fn() },
    auditLog: {
      findMany: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
    },
    riskState: { findMany: vi.fn() },
  } as unknown as PrismaService;
}

function createMockPositionRepository() {
  return {
    findManyWithFilters: vi.fn(),
  } as unknown as PositionRepository;
}

function createMockConfigService() {
  return {
    get: vi.fn((key: string, defaultValue?: string) => {
      const config: Record<string, string> = {
        PLATFORM_MODE_KALSHI: 'paper',
        PLATFORM_MODE_POLYMARKET: 'paper',
      };
      return config[key] ?? defaultValue;
    }),
  } as unknown as ConfigService;
}

function createMockEnrichmentService() {
  return {
    enrich: vi.fn(),
  } as unknown as PositionEnrichmentService;
}

function createMockEventEmitter() {
  return {
    emit: vi.fn(),
    emitAsync: vi.fn(),
  } as unknown as EventEmitter2;
}

function createMockRiskManager() {
  return {
    getBankrollConfig: vi.fn().mockResolvedValue({
      bankrollUsd: '10000',
      paperBankrollUsd: null,
      updatedAt: new Date().toISOString(),
    }),
    getBankrollUsd: vi.fn().mockReturnValue(new Decimal('10000')),
    reloadBankroll: vi.fn().mockResolvedValue(undefined),
    isTradingHalted: vi.fn().mockReturnValue(false),
    getActiveHaltReasons: vi.fn().mockReturnValue([]),
  } as unknown as IRiskManager;
}

function createMockEngineConfigRepository() {
  return {
    get: vi.fn().mockResolvedValue(null),
    upsertBankroll: vi.fn().mockResolvedValue({
      id: 'cfg-1',
      singletonKey: 'default',
      bankrollUsd: { toString: () => '15000' },
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  } as unknown as EngineConfigRepository;
}

function createMockDataIngestionService() {
  return {
    getActiveSubscriptionCount: vi.fn().mockReturnValue(0),
  };
}

function createMockDivergenceService() {
  return {
    getDivergenceStatus: vi.fn().mockReturnValue('normal'),
  };
}

function createMockPlatformHealthService() {
  return {
    getWsLastMessageTimestamp: vi.fn().mockReturnValue(null),
  };
}

function createMockShadowComparisonService() {
  return {
    getLatestComparison: vi.fn().mockReturnValue(null),
  };
}

// ─── AC 8: Bankroll Audit Backfill ────────────────────────────────────

function createMockAuditLogService() {
  return {
    append: vi.fn().mockResolvedValue(undefined),
  };
}

describe('DashboardService — bankroll audit backfill (AC 8)', () => {
  let service: DashboardService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let riskManager: ReturnType<typeof createMockRiskManager>;
  let auditLogService: ReturnType<typeof createMockAuditLogService>;

  beforeEach(() => {
    prisma = createMockPrisma();
    const eventEmitter = createMockEventEmitter();
    riskManager = createMockRiskManager();
    const engineConfigRepo = createMockEngineConfigRepository();
    auditLogService = createMockAuditLogService();

    service = new DashboardService(
      prisma,
      createMockConfigService(),
      createMockEnrichmentService(),
      createMockPositionRepository(),
      eventEmitter,
      riskManager,
      engineConfigRepo as unknown as EngineConfigRepository,
      createMockDataIngestionService() as unknown as import('../modules/data-ingestion/data-ingestion.service.js').DataIngestionService,
      createMockDivergenceService() as unknown as import('../modules/data-ingestion/data-divergence.service.js').DataDivergenceService,
      createMockPlatformHealthService() as unknown as import('../modules/data-ingestion/platform-health.service.js').PlatformHealthService,
      createMockShadowComparisonService() as unknown as import('../modules/exit-management/shadow-comparison.service.js').ShadowComparisonService,
      auditLogService as unknown as import('../modules/monitoring/audit-log.service.js').AuditLogService,
    );

    (prisma.riskState.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      [],
    );
  });

  it('[P1] updateBankroll() creates audit log with eventType CONFIG_BANKROLL_UPDATED', async () => {
    (riskManager.getBankrollConfig as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        bankrollUsd: '10000',
        updatedAt: '2026-03-22T10:00:00.000Z',
      })
      .mockResolvedValueOnce({
        bankrollUsd: '15000',
        updatedAt: '2026-03-22T11:00:00.000Z',
      });

    await service.updateBankroll('15000');

    expect(auditLogService.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: EVENT_NAMES.CONFIG_BANKROLL_UPDATED,
      }),
    );
  });

  it('[P1] audit log details contain previousValue, newValue, updatedBy', async () => {
    (riskManager.getBankrollConfig as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        bankrollUsd: '10000',
        updatedAt: '2026-03-22T10:00:00.000Z',
      })
      .mockResolvedValueOnce({
        bankrollUsd: '20000',
        updatedAt: '2026-03-22T12:00:00.000Z',
      });

    await service.updateBankroll('20000');

    expect(auditLogService.append).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          previousValue: '10000',
          newValue: '20000',
          updatedBy: 'dashboard',
        }),
      }),
    );
  });
});
