import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { StressTestController } from './stress-test.controller';
import { StressTestService } from './stress-test.service';
import { PrismaService } from '../../common/prisma.service';
import { AuthTokenGuard } from '../../common/guards/auth-token.guard';
import { FinancialDecimal } from '../../common/utils/financial-math';
import type { StressTestResult } from '../../common/types/risk.type';

describe('StressTestController', () => {
  let controller: StressTestController;
  let mockStressTestService: {
    runSimulation: ReturnType<typeof vi.fn>;
  };
  let mockPrisma: {
    stressTestRun: { findFirst: ReturnType<typeof vi.fn> };
  };

  function makeResult(
    overrides: Partial<StressTestResult> = {},
  ): StressTestResult {
    return {
      numScenarios: 1050,
      numPositions: 3,
      bankrollUsd: new FinancialDecimal('10000'),
      var95: new FinancialDecimal('150.50'),
      var99: new FinancialDecimal('280.75'),
      worstCaseLoss: new FinancialDecimal('450.00'),
      drawdown15PctProbability: new FinancialDecimal('0.02'),
      drawdown20PctProbability: new FinancialDecimal('0.01'),
      drawdown25PctProbability: new FinancialDecimal('0.005'),
      alertEmitted: false,
      suggestions: [],
      scenarioDetails: {
        percentiles: { p5: '-150.50', p95: '120.30' },
        syntheticResults: [
          { name: 'correlation-1-stress', portfolioPnl: '-300.00' },
        ],
        volatilities: [
          {
            contractId: 'c1',
            platform: 'POLYMARKET',
            vol: '0.030000',
            source: 'default',
          },
        ],
      },
      ...overrides,
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();

    mockStressTestService = {
      runSimulation: vi.fn().mockResolvedValue(makeResult()),
    };

    mockPrisma = {
      stressTestRun: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [StressTestController],
      providers: [
        { provide: StressTestService, useValue: mockStressTestService },
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
        {
          provide: ConfigService,
          useValue: { get: () => 'test-token' },
        },
        AuthTokenGuard,
      ],
    }).compile();

    controller = module.get<StressTestController>(StressTestController);
  });

  describe('POST /api/risk/stress-test', () => {
    it('should trigger simulation and return results', async () => {
      const response = await controller.triggerStressTest();

      expect(mockStressTestService.runSimulation).toHaveBeenCalledWith(
        'operator',
      );
      expect(response.data.numScenarios).toBe(1050);
      expect(response.data.var95).toBe('150.50000000');
      expect(response.timestamp).toBeDefined();
    });

    it('should return standard response wrapper format', async () => {
      const response = await controller.triggerStressTest();

      expect(response).toHaveProperty('data');
      expect(response).toHaveProperty('timestamp');
      expect(typeof response.timestamp).toBe('string');
    });
  });

  describe('GET /api/risk/stress-test/latest', () => {
    it('should return most recent StressTestRun', async () => {
      mockPrisma.stressTestRun.findFirst.mockResolvedValue({
        id: 'run-1',
        timestamp: new Date('2026-03-13T00:00:00Z'),
        numScenarios: 1050,
        numPositions: 3,
        bankrollUsd: new Decimal('10000'),
        var95: new Decimal('150.50'),
        var99: new Decimal('280.75'),
        worstCaseLoss: new Decimal('450'),
        drawdown15PctProbability: new Decimal('0.02'),
        drawdown20PctProbability: new Decimal('0.01'),
        drawdown25PctProbability: new Decimal('0.005'),
        alertEmitted: false,
        suggestions: [],
        scenarioDetails: {
          percentiles: { p5: '-150.50' },
          syntheticResults: [],
          volatilities: [],
        },
        triggeredBy: 'operator',
        createdAt: new Date(),
      });

      const response = await controller.getLatestResult();

      expect(response.data.numScenarios).toBe(1050);
      expect(response.data.var95).toBe('150.5');
      expect(response.timestamp).toBeDefined();
    });

    it('should return 404 when no runs exist', async () => {
      mockPrisma.stressTestRun.findFirst.mockResolvedValue(null);

      await expect(controller.getLatestResult()).rejects.toThrow(HttpException);
      try {
        await controller.getLatestResult();
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(404);
      }
    });
  });

  describe('auth guard', () => {
    it('should have auth guard applied via UseGuards decorator', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        StressTestController,
      ) as unknown[];
      expect(guards).toBeDefined();
      expect(guards).toContain(AuthTokenGuard);
    });
  });
});
