import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { HttpException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { RiskOverrideController } from './risk-override.controller';
import { RISK_MANAGER_TOKEN } from './risk-management.constants';
import { RISK_ERROR_CODES } from '../../common/errors/risk-limit-error';
import { CLUSTER_CLASSIFIER_TOKEN } from '../../common/interfaces/cluster-classifier.interface';
import { AuthTokenGuard } from '../../common/guards/auth-token.guard';
import { FinancialDecimal } from '../../common/utils/financial-math';
import { createMockRiskManager } from '../../test/mock-factories.js';
import { CorrelationTrackerService } from './correlation-tracker.service';
import { asClusterId } from '../../common/types/branded.type';

describe('RiskOverrideController', () => {
  let controller: RiskOverrideController;
  const mockRiskManager = createMockRiskManager();
  const mockClusterClassifier = {
    classifyMatch: vi.fn(),
    getOrCreateCluster: vi.fn(),
    reassignCluster: vi.fn(),
  };
  const mockCorrelationTracker = {
    getClusterExposures: vi.fn().mockReturnValue([]),
    getAggregateExposurePct: vi.fn().mockReturnValue(new Decimal(0)),
    recalculateClusterExposure: vi.fn().mockResolvedValue(undefined),
  };
  const mockEventEmitter = { emit: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RiskOverrideController],
      providers: [
        { provide: RISK_MANAGER_TOKEN, useValue: mockRiskManager },
        { provide: CLUSTER_CLASSIFIER_TOKEN, useValue: mockClusterClassifier },
        {
          provide: CorrelationTrackerService,
          useValue: mockCorrelationTracker,
        },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        {
          provide: ConfigService,
          useValue: { get: () => 'test-token' },
        },
        AuthTokenGuard,
      ],
    }).compile();

    controller = module.get<RiskOverrideController>(RiskOverrideController);
  });

  it('should return 200 with standard wrapper on success', async () => {
    const decision = {
      approved: true,
      reason: 'Override approved by operator',
      maxPositionSizeUsd: new FinancialDecimal(300),
      currentOpenPairs: 5,
      overrideApplied: true,
      overrideRationale: 'High conviction opportunity',
    };
    mockRiskManager.processOverride.mockResolvedValue(decision);

    const result = await controller.override({
      opportunityId: 'opp-123',
      rationale: 'High conviction opportunity',
    });

    expect(result).toEqual({
      data: {
        approved: true,
        reason: 'Override approved by operator',
        maxPositionSizeUsd: '300',
        currentOpenPairs: 5,
        dailyPnl: undefined,
        overrideApplied: true,
        overrideRationale: 'High conviction opportunity',
      },
      timestamp: expect.any(String) as string,
    });
    expect(mockRiskManager.processOverride).toHaveBeenCalledWith(
      'opp-123',
      'High conviction opportunity',
    );
  });

  it('should return 403 when daily loss halt active', async () => {
    const decision = {
      approved: false,
      reason: 'Override denied: daily loss halt active',
      maxPositionSizeUsd: new FinancialDecimal(0),
      currentOpenPairs: 5,
    };
    mockRiskManager.processOverride.mockResolvedValue(decision);

    try {
      await controller.override({
        opportunityId: 'opp-123',
        rationale: 'High conviction opportunity',
      });
      expect.unreachable('Should have thrown HttpException');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const httpError = error as HttpException;
      expect(httpError.getStatus()).toBe(403);
      const response = httpError.getResponse() as Record<string, unknown>;
      expect(response).toEqual({
        error: {
          code: RISK_ERROR_CODES.OVERRIDE_DENIED_HALT_ACTIVE,
          message: 'Override denied: daily loss halt active',
          severity: 'critical',
        },
        timestamp: expect.any(String) as string,
      });
    }
  });

  it('should return 500 with error wrapper when processOverride throws unexpected error', async () => {
    mockRiskManager.processOverride.mockRejectedValue(
      new Error('Database connection lost'),
    );

    try {
      await controller.override({
        opportunityId: 'opp-123',
        rationale: 'High conviction opportunity',
      });
      expect.unreachable('Should have thrown HttpException');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const httpError = error as HttpException;
      expect(httpError.getStatus()).toBe(500);
      const response = httpError.getResponse() as Record<string, unknown>;
      expect(response).toEqual({
        error: {
          code: 4000,
          message: 'Internal error processing override',
          severity: 'critical',
        },
        timestamp: expect.any(String) as string,
      });
    }
  });

  describe('clusterOverride', () => {
    it('should reassign cluster and recalculate exposure', async () => {
      mockClusterClassifier.reassignCluster.mockResolvedValue({
        oldClusterId: asClusterId('old-cluster'),
        newClusterId: asClusterId('new-cluster'),
      });

      const result = await controller.clusterOverride({
        matchId: 'match-1',
        newClusterId: 'new-cluster',
        rationale: 'This belongs in a different cluster',
      });

      expect(result.data.oldClusterId).toBe('old-cluster');
      expect(result.data.newClusterId).toBe('new-cluster');
      expect(
        mockCorrelationTracker.recalculateClusterExposure,
      ).toHaveBeenCalledTimes(2);
      expect(mockEventEmitter.emit).toHaveBeenCalled();
    });

    it('should return 404 when match not found', async () => {
      const notFoundError = new Error('ContractMatch not found: match-1');
      Object.assign(notFoundError, { code: 4007 });
      mockClusterClassifier.reassignCluster.mockRejectedValue(notFoundError);

      await expect(
        controller.clusterOverride({
          matchId: 'match-1',
          newClusterId: 'cluster-id',
          rationale: 'This belongs in a different cluster',
        }),
      ).rejects.toThrow(HttpException);
    });
  });

  describe('listClusters', () => {
    it('should return cluster exposures', () => {
      mockCorrelationTracker.getClusterExposures.mockReturnValue([
        {
          clusterId: asClusterId('cluster-1'),
          clusterName: 'Economics',
          exposureUsd: new Decimal('500'),
          exposurePct: new Decimal('0.05'),
          pairCount: 3,
        },
      ]);

      const result = controller.listClusters();

      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.clusterName).toBe('Economics');
      expect(result.data[0]!.exposureUsd).toBe('500');
      expect(result.count).toBe(1);
    });

    it('should return empty list when no clusters', () => {
      mockCorrelationTracker.getClusterExposures.mockReturnValue([]);
      const result = controller.listClusters();
      expect(result.data).toEqual([]);
      expect(result.count).toBe(0);
    });
  });
});
