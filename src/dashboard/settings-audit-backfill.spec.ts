/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import { DashboardCapitalService } from './dashboard-capital.service';
import type { IRiskManager } from '../common/interfaces/risk-manager.interface';
import { EngineConfigRepository } from '../persistence/repositories/engine-config.repository';
import { EVENT_NAMES } from '../common/events/event-catalog';

// ─── Mock Factories ─────────────────────────────────────────────────────────

function createMockRiskManager() {
  return {
    getBankrollConfig: vi.fn().mockResolvedValue({
      bankrollUsd: '10000',
      paperBankrollUsd: null,
      updatedAt: new Date().toISOString(),
    }),
    getBankrollUsd: vi.fn().mockReturnValue(new Decimal('10000')),
    reloadBankroll: vi.fn().mockResolvedValue(undefined),
  } as unknown as IRiskManager;
}

function createMockEventEmitter() {
  return {
    emit: vi.fn(),
  };
}

function createMockEngineConfigRepository() {
  return {
    upsertBankroll: vi.fn().mockResolvedValue({
      id: 'cfg-1',
      singletonKey: 'default',
      bankrollUsd: { toString: () => '15000' },
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  } as unknown as EngineConfigRepository;
}

function createMockAuditLogService() {
  return {
    append: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── AC 8: Bankroll Audit Backfill ────────────────────────────────────

describe('DashboardCapitalService — bankroll audit backfill (AC 8)', () => {
  let service: DashboardCapitalService;
  let riskManager: ReturnType<typeof createMockRiskManager>;
  let auditLogService: ReturnType<typeof createMockAuditLogService>;

  beforeEach(() => {
    riskManager = createMockRiskManager();
    const eventEmitter = createMockEventEmitter();
    const engineConfigRepo = createMockEngineConfigRepository();
    auditLogService = createMockAuditLogService();

    service = new DashboardCapitalService(
      riskManager,
      eventEmitter as any,
      engineConfigRepo,
      auditLogService as any,
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
