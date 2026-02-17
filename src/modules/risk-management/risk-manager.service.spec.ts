/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Decimal from 'decimal.js';
import { RiskManagerService } from './risk-manager.service';
import { PrismaService } from '../../common/prisma.service';
import { EVENT_NAMES } from '../../common/events';
import { RiskLimitError, RISK_ERROR_CODES } from '../../common/errors';
import { FinancialDecimal } from '../../common/utils/financial-math';
import { PlatformId, NormalizedOrderBook } from '../../common/types';
import { EnrichedOpportunity } from '../arbitrage-detection/types/enriched-opportunity.type';
import { ContractPairConfig } from '../contract-matching/types';

function makePair(overrides?: Partial<ContractPairConfig>): ContractPairConfig {
  return {
    polymarketContractId: 'poly-1',
    kalshiContractId: 'kalshi-1',
    eventDescription: 'Test event',
    operatorVerificationTimestamp: new Date(),
    primaryLeg: 'kalshi',
    ...overrides,
  };
}

function makeOrderBook(
  platformId: PlatformId,
  contractId: string,
): NormalizedOrderBook {
  return {
    platformId,
    contractId,
    bids: [{ price: 0.5, quantity: 100 }],
    asks: [{ price: 0.55, quantity: 100 }],
    timestamp: new Date(),
  };
}

function makeEnrichedOpportunity(
  overrides?: Partial<EnrichedOpportunity>,
): EnrichedOpportunity {
  const pair = makePair();
  return {
    dislocation: {
      pairConfig: pair,
      buyPlatformId: PlatformId.POLYMARKET,
      sellPlatformId: PlatformId.KALSHI,
      buyPrice: new FinancialDecimal(0.52),
      sellPrice: new FinancialDecimal(0.45),
      grossEdge: new FinancialDecimal(0.07),
      buyOrderBook: makeOrderBook(
        PlatformId.POLYMARKET,
        pair.polymarketContractId,
      ),
      sellOrderBook: makeOrderBook(PlatformId.KALSHI, pair.kalshiContractId),
      detectedAt: new Date(),
    },
    netEdge: new FinancialDecimal(0.05),
    grossEdge: new FinancialDecimal(0.07),
    feeBreakdown: {
      buyFeeCost: new FinancialDecimal(0.01),
      sellFeeCost: new FinancialDecimal(0.005),
      gasFraction: new FinancialDecimal(0.001),
      totalCosts: new FinancialDecimal(0.016),
      buyFeeSchedule: {
        platformId: PlatformId.POLYMARKET,
        makerFeePercent: 0,
        takerFeePercent: 0.02,
        description: 'Polymarket fees',
      },
      sellFeeSchedule: {
        platformId: PlatformId.KALSHI,
        makerFeePercent: 0,
        takerFeePercent: 0.01,
        description: 'Kalshi fees',
      },
    },
    liquidityDepth: {
      buyBestAskSize: 100,
      sellBestAskSize: 100,
      buyBestBidSize: 100,
      sellBestBidSize: 100,
    },
    recommendedPositionSize: null,
    enrichedAt: new Date(),
    ...overrides,
  };
}

describe('RiskManagerService', () => {
  let service: RiskManagerService;
  let mockConfigService: Record<string, unknown>;
  let mockEventEmitter: { emit: ReturnType<typeof vi.fn> };
  let mockPrisma: {
    riskState: {
      findFirst: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
  };

  const defaultConfig: Record<string, number> = {
    RISK_BANKROLL_USD: 10000,
    RISK_MAX_POSITION_PCT: 0.03,
    RISK_MAX_OPEN_PAIRS: 10,
  };

  function createMockConfigService(
    overrides?: Record<string, number | undefined>,
  ) {
    const config = { ...defaultConfig, ...overrides };
    return {
      get: vi.fn((key: string, defaultValue?: number) => {
        return config[key] ?? defaultValue;
      }),
    };
  }

  beforeEach(async () => {
    mockConfigService = createMockConfigService();
    mockEventEmitter = { emit: vi.fn() };
    mockPrisma = {
      riskState: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RiskManagerService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<RiskManagerService>(RiskManagerService);
    await service.onModuleInit();
  });

  describe('config validation', () => {
    it('should reject negative bankroll', async () => {
      const module = await Test.createTestingModule({
        providers: [
          RiskManagerService,
          {
            provide: ConfigService,
            useValue: createMockConfigService({ RISK_BANKROLL_USD: -100 }),
          },
          { provide: EventEmitter2, useValue: mockEventEmitter },
          { provide: PrismaService, useValue: mockPrisma },
        ],
      }).compile();
      const svc = module.get<RiskManagerService>(RiskManagerService);
      await expect(svc.onModuleInit()).rejects.toThrow(
        'RISK_BANKROLL_USD must be a positive number',
      );
    });

    it('should reject position pct > 1.0', async () => {
      const module = await Test.createTestingModule({
        providers: [
          RiskManagerService,
          {
            provide: ConfigService,
            useValue: createMockConfigService({ RISK_MAX_POSITION_PCT: 1.5 }),
          },
          { provide: EventEmitter2, useValue: mockEventEmitter },
          { provide: PrismaService, useValue: mockPrisma },
        ],
      }).compile();
      const svc = module.get<RiskManagerService>(RiskManagerService);
      await expect(svc.onModuleInit()).rejects.toThrow(
        'RISK_MAX_POSITION_PCT must be between 0 and 1',
      );
    });

    it('should reject non-positive max pairs', async () => {
      const module = await Test.createTestingModule({
        providers: [
          RiskManagerService,
          {
            provide: ConfigService,
            useValue: createMockConfigService({ RISK_MAX_OPEN_PAIRS: 0 }),
          },
          { provide: EventEmitter2, useValue: mockEventEmitter },
          { provide: PrismaService, useValue: mockPrisma },
        ],
      }).compile();
      const svc = module.get<RiskManagerService>(RiskManagerService);
      await expect(svc.onModuleInit()).rejects.toThrow(
        'RISK_MAX_OPEN_PAIRS must be a positive integer',
      );
    });
  });

  describe('validatePosition', () => {
    it('should approve opportunity when under all limits', async () => {
      const decision = await service.validatePosition(
        makeEnrichedOpportunity(),
      );
      expect(decision.approved).toBe(true);
      expect(decision.reason).toBe('Position within risk limits');
    });

    it('should reject opportunity when max open pairs reached', async () => {
      (service as any).openPositionCount = 10;
      const decision = await service.validatePosition(
        makeEnrichedOpportunity(),
      );
      expect(decision.approved).toBe(false);
      expect(decision.reason).toContain('Max open pairs limit reached');
    });

    it('should calculate position size as bankroll * maxPositionPct', async () => {
      const decision = await service.validatePosition(
        makeEnrichedOpportunity(),
      );
      // 10000 * 0.03 = 300
      expect(decision.maxPositionSizeUsd.toNumber()).toBe(300);
    });

    it('should emit LimitApproachedEvent when open pairs at 80% of max', async () => {
      (service as any).openPositionCount = 8; // 80% of 10
      await service.validatePosition(makeEnrichedOpportunity());
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.LIMIT_APPROACHED,
        expect.objectContaining({
          limitType: 'max_open_pairs',
          currentValue: 8,
          threshold: 10,
          percentUsed: 80,
        }),
      );
    });

    it('should NOT emit LimitApproachedEvent when below 80%', async () => {
      (service as any).openPositionCount = 7; // 70% of 10
      await service.validatePosition(makeEnrichedOpportunity());
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should handle zero bankroll gracefully (rejects via config validation)', async () => {
      const module = await Test.createTestingModule({
        providers: [
          RiskManagerService,
          {
            provide: ConfigService,
            useValue: createMockConfigService({ RISK_BANKROLL_USD: 0 }),
          },
          { provide: EventEmitter2, useValue: mockEventEmitter },
          { provide: PrismaService, useValue: mockPrisma },
        ],
      }).compile();
      const svc = module.get<RiskManagerService>(RiskManagerService);
      await expect(svc.onModuleInit()).rejects.toThrow(
        'RISK_BANKROLL_USD must be a positive number',
      );
    });

    it('should use Decimal.js for position size calculation', async () => {
      const decision = await service.validatePosition(
        makeEnrichedOpportunity(),
      );
      expect(decision.maxPositionSizeUsd).toBeInstanceOf(Decimal);
    });

    it('should log rejection with current count and limit', async () => {
      (service as any).openPositionCount = 10;
      const logSpy = vi.spyOn(service['logger'], 'warn');
      await service.validatePosition(makeEnrichedOpportunity());
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Opportunity rejected: max open pairs exceeded',
          data: expect.objectContaining({
            currentOpenPairs: 10,
            maxOpenPairs: 10,
          }),
        }),
      );
    });
  });

  describe('database persistence', () => {
    it('should upsert risk state to database on initialization', () => {
      // findFirst returned null in beforeEach, so persistState was called
      expect(mockPrisma.riskState.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { singletonKey: 'default' },
          create: expect.objectContaining({
            singletonKey: 'default',
            openPositionCount: 0,
          }),
        }),
      );
    });

    it('should restore state from database when row exists', async () => {
      const existingState = {
        id: 'test-id',
        singletonKey: 'default',
        dailyPnl: new Decimal(0),
        openPositionCount: 5,
        lastResetTimestamp: null,
        totalCapitalDeployed: new Decimal('1500.00000000'),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockPrisma.riskState.findFirst.mockResolvedValue(existingState);

      const module = await Test.createTestingModule({
        providers: [
          RiskManagerService,
          { provide: ConfigService, useValue: createMockConfigService() },
          { provide: EventEmitter2, useValue: mockEventEmitter },
          { provide: PrismaService, useValue: mockPrisma },
        ],
      }).compile();
      const svc = module.get<RiskManagerService>(RiskManagerService);
      await svc.onModuleInit();

      expect(svc.getOpenPositionCount()).toBe(5);
      expect(svc.getCurrentExposure().totalCapitalDeployed.toNumber()).toBe(
        1500,
      );
    });
  });

  describe('getCurrentExposure', () => {
    it('should return correct risk exposure snapshot', () => {
      const exposure = service.getCurrentExposure();
      expect(exposure.openPairCount).toBe(0);
      expect(exposure.bankrollUsd.toNumber()).toBe(10000);
      expect(exposure.totalCapitalDeployed.toNumber()).toBe(0);
      expect(exposure.availableCapital.toNumber()).toBe(10000);
    });
  });

  describe('getOpenPositionCount', () => {
    it('should return current open pair count', () => {
      expect(service.getOpenPositionCount()).toBe(0);
    });
  });

  describe('RiskLimitError', () => {
    it('should have correct code, limitType, currentValue, threshold', () => {
      const error = new RiskLimitError(
        RISK_ERROR_CODES.MAX_OPEN_PAIRS_EXCEEDED,
        'Max open pairs exceeded',
        'warning',
        'max_open_pairs',
        10,
        10,
      );
      expect(error.code).toBe(3002);
      expect(error.limitType).toBe('max_open_pairs');
      expect(error.currentValue).toBe(10);
      expect(error.threshold).toBe(10);
      expect(error.name).toBe('RiskLimitError');
    });
  });
});
