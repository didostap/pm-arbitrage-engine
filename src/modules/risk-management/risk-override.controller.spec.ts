import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { RiskOverrideController } from './risk-override.controller';
import { RISK_MANAGER_TOKEN } from './risk-management.constants';
import { RISK_ERROR_CODES } from '../../common/errors/risk-limit-error';
import { AuthTokenGuard } from '../../common/guards/auth-token.guard';
import { FinancialDecimal } from '../../common/utils/financial-math';
import { createMockRiskManager } from '../../test/mock-factories.js';

describe('RiskOverrideController', () => {
  let controller: RiskOverrideController;
  const mockRiskManager = createMockRiskManager();

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RiskOverrideController],
      providers: [
        { provide: RISK_MANAGER_TOKEN, useValue: mockRiskManager },
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
      data: decision,
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
          severity: 'error',
        },
        timestamp: expect.any(String) as string,
      });
    }
  });
});
