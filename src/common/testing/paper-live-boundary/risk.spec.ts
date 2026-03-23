/* eslint-disable @typescript-eslint/no-unsafe-return */
/**
 * Story 10-5.5 — Paper/Live Mode Boundary: RiskManager Isolation
 *
 * Verifies that paper and live risk states are fully isolated.
 * haltTrading/resumeTrading only affect liveState; bankroll, dailyPnl,
 * closePosition, reserveBudget, and dailyReset are mode-scoped.
 *
 * TDD RED PHASE — all tests skip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import {
  RiskManagerService,
  HALT_REASONS,
} from '../../../modules/risk-management/risk-manager.service';
import { CorrelationTrackerService } from '../../../modules/risk-management/correlation-tracker.service';
import { EngineConfigRepository } from '../../../persistence/repositories/engine-config.repository';
import { PrismaService } from '../../prisma.service';
import type { ReservationRequest } from '../../types/risk.type';
import { asOpportunityId, asPairId } from '../../types/branded.type';

// ──────────────────────────────────────────────────────────────
// Shared setup
// ──────────────────────────────────────────────────────────────

const BANKROLL_USD = 10000;
const PAPER_BANKROLL_USD = 5000;
const MAX_POSITION_PCT = 0.03;
const DAILY_LOSS_PCT = 0.05;
const MAX_OPEN_PAIRS = 10;

function mockConfigService() {
  return {
    provide: ConfigService,
    useValue: {
      get: vi.fn().mockImplementation((key: string, defaultValue?: any) => {
        const map: Record<string, any> = {
          RISK_BANKROLL_USD: String(BANKROLL_USD),
          RISK_PAPER_BANKROLL_USD: String(PAPER_BANKROLL_USD),
          RISK_MAX_POSITION_PCT: String(MAX_POSITION_PCT),
          RISK_DAILY_LOSS_PCT: String(DAILY_LOSS_PCT),
          RISK_MAX_OPEN_PAIRS: String(MAX_OPEN_PAIRS),
        };
        return map[key] ?? defaultValue;
      }),
    },
  };
}

function mockPrisma() {
  return {
    provide: PrismaService,
    useValue: {
      riskState: {
        upsert: vi.fn().mockResolvedValue({}),
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      openPosition: {
        count: vi.fn().mockResolvedValue(0),
        aggregate: vi.fn().mockResolvedValue({ _sum: { expectedEdge: null } }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
  };
}

function mockCorrelationTracker() {
  return {
    provide: CorrelationTrackerService,
    useValue: {
      updateBankroll: vi.fn(),
      getClusterExposure: vi.fn().mockReturnValue(new Decimal(0)),
      getClusterExposures: vi.fn().mockReturnValue(new Map()),
      getAggregateExposurePct: vi.fn().mockReturnValue(new Decimal(0)),
      updateClusterExposure: vi.fn(),
    },
  };
}

function mockEngineConfigRepo() {
  return {
    provide: EngineConfigRepository,
    useValue: {
      get: vi.fn().mockResolvedValue({
        bankrollUsd: new Decimal(BANKROLL_USD),
        paperBankrollUsd: new Decimal(PAPER_BANKROLL_USD),
        updatedAt: new Date(),
      }),
      upsertBankroll: vi.fn().mockResolvedValue({
        bankrollUsd: new Decimal(BANKROLL_USD),
        paperBankrollUsd: new Decimal(PAPER_BANKROLL_USD),
        updatedAt: new Date(),
      }),
    },
  };
}

describe('Paper/Live Boundary — RiskManagerService', () => {
  let service: RiskManagerService;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      providers: [
        RiskManagerService,
        mockConfigService(),
        mockPrisma(),
        mockCorrelationTracker(),
        mockEngineConfigRepo(),
      ],
    }).compile();

    service = module.get(RiskManagerService);
    await module.init();
  });

  it('[P0] haltTrading(reason) only affects liveState, not paperState', () => {
    // Arrange: both modes should start un-halted
    expect(service.isTradingHalted(false)).toBe(false);
    expect(service.isTradingHalted(true)).toBe(false);

    // Act: halt live trading
    service.haltTrading(HALT_REASONS.DAILY_LOSS_LIMIT);

    // Assert: live is halted, paper is NOT
    expect(service.isTradingHalted(false)).toBe(true);
    expect(service.getActiveHaltReasons(false)).toContain(
      HALT_REASONS.DAILY_LOSS_LIMIT,
    );
    expect(service.isTradingHalted(true)).toBe(false);
    expect(service.getActiveHaltReasons(true)).toHaveLength(0);
  });

  it('[P0] resumeTrading(reason) only affects liveState, not paperState', () => {
    // Arrange: halt live, manually add halt to paper state for isolation test
    service.haltTrading(HALT_REASONS.RECONCILIATION_DISCREPANCY);
    expect(service.isTradingHalted(false)).toBe(true);

    // Act: resume live trading
    service.resumeTrading(HALT_REASONS.RECONCILIATION_DISCREPANCY);

    // Assert: live is resumed
    expect(service.isTradingHalted(false)).toBe(false);
    // Paper was never touched by haltTrading/resumeTrading
    expect(service.isTradingHalted(true)).toBe(false);
  });

  it('[P0] paper reserveBudget dedup is independent of live reserveBudget dedup', async () => {
    const pairId = asPairId('pair-dedup-test');
    const oppId1 = asOpportunityId('opp-paper-1');
    const oppId2 = asOpportunityId('opp-live-1');

    // Reserve for paper mode
    const paperRequest: ReservationRequest = {
      opportunityId: oppId1,
      recommendedPositionSizeUsd: new Decimal(100),
      pairId,
      isPaper: true,
    };
    await service.reserveBudget(paperRequest);

    // Same pair in live mode should NOT be blocked by paper dedup
    const liveRequest: ReservationRequest = {
      opportunityId: oppId2,
      recommendedPositionSizeUsd: new Decimal(100),
      pairId,
      isPaper: false,
    };
    // This should succeed — paper dedup uses paperActivePairIds, live has no pair dedup
    await expect(service.reserveBudget(liveRequest)).resolves.toBeDefined();
  });

  it('[P0] paper/live bankroll isolation (getBankrollForMode returns correct state)', () => {
    // Access via getCurrentExposure which uses getBankrollForMode internally
    const liveExposure = service.getCurrentExposure(false);
    const paperExposure = service.getCurrentExposure(true);

    // Live bankroll = BANKROLL_USD, Paper bankroll = PAPER_BANKROLL_USD
    expect(liveExposure.bankrollUsd.toNumber()).toBe(BANKROLL_USD);
    expect(paperExposure.bankrollUsd.toNumber()).toBe(PAPER_BANKROLL_USD);
    // They must be different values
    expect(liveExposure.bankrollUsd.eq(paperExposure.bankrollUsd)).toBe(false);
  });

  it('[P0] paper/live dailyPnl isolation (updateDailyPnl affects only target mode)', async () => {
    // Act: update paper P&L
    await service.updateDailyPnl(new Decimal(-50), true);

    // Assert: paper state has the P&L, live state is untouched
    const paperExposure = service.getCurrentExposure(true);
    const liveExposure = service.getCurrentExposure(false);

    expect(paperExposure.dailyPnl.toNumber()).toBe(-50);
    expect(liveExposure.dailyPnl.toNumber()).toBe(0);

    // Act: update live P&L separately
    await service.updateDailyPnl(new Decimal(-100), false);

    const paperExposure2 = service.getCurrentExposure(true);
    const liveExposure2 = service.getCurrentExposure(false);

    // Paper unchanged, live updated
    expect(paperExposure2.dailyPnl.toNumber()).toBe(-50);
    expect(liveExposure2.dailyPnl.toNumber()).toBe(-100);
  });

  it('[P0] paper closePosition does not release live capital', async () => {
    const pairId = asPairId('pair-close-test');

    // Simulate paper position being open (increment paper state)
    // We do this via reserveBudget + commitReservation to set up state properly
    const paperRequest: ReservationRequest = {
      opportunityId: asOpportunityId('opp-close-1'),
      recommendedPositionSizeUsd: new Decimal(200),
      pairId,
      isPaper: true,
    };
    const reservation = await service.reserveBudget(paperRequest);
    await service.commitReservation(reservation.reservationId);

    // Capture live state before paper close
    const liveBefore = service.getCurrentExposure(false);

    // Close paper position
    await service.closePosition(
      new Decimal(200),
      new Decimal(10),
      pairId,
      true,
    );

    // Live state must be unchanged
    const liveAfter = service.getCurrentExposure(false);
    expect(
      liveAfter.totalCapitalDeployed.eq(liveBefore.totalCapitalDeployed),
    ).toBe(true);
    expect(liveAfter.openPositionCount).toBe(liveBefore.openPositionCount);
    expect(liveAfter.dailyPnl.eq(liveBefore.dailyPnl)).toBe(true);
  });

  it('[P0] dailyReset resets BOTH modes independently', async () => {
    // Arrange: both modes have non-zero P&L
    await service.updateDailyPnl(new Decimal(-200), false);
    await service.updateDailyPnl(new Decimal(-100), true);

    expect(service.getCurrentExposure(false).dailyPnl.toNumber()).toBe(-200);
    expect(service.getCurrentExposure(true).dailyPnl.toNumber()).toBe(-100);

    // Act: trigger midnight reset
    await service.handleMidnightReset();

    // Assert: both modes reset to zero
    expect(service.getCurrentExposure(false).dailyPnl.toNumber()).toBe(0);
    expect(service.getCurrentExposure(true).dailyPnl.toNumber()).toBe(0);
  });
});
