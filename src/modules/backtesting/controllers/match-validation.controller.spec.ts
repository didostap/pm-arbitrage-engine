import { describe, it, expect, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { MatchValidationController } from './match-validation.controller';
import { MatchValidationService } from '../validation/match-validation.service';
import { SystemHealthError } from '../../../common/errors/system-health-error';

function createMockValidationService() {
  return {
    isRunning: false,
    runValidation: vi.fn().mockResolvedValue({
      id: 1,
      correlationId: 'test-corr-id',
      confirmedCount: 5,
      ourOnlyCount: 3,
      externalOnlyCount: 2,
      conflictCount: 1,
    }),
    getReports: vi.fn().mockResolvedValue([]),
    getReport: vi.fn().mockResolvedValue(null),
  };
}

describe('MatchValidationController', () => {
  it('[P1] POST /api/backtesting/validation/run should return 202 with correlationId', async () => {
    const mockService = createMockValidationService();
    const module = await Test.createTestingModule({
      controllers: [MatchValidationController],
      providers: [{ provide: MatchValidationService, useValue: mockService }],
    }).compile();

    const controller = module.get(MatchValidationController);

    const result = controller.triggerValidation({
      includeSources: ['oddspipe', 'predexon'],
    } as any);

    expect(result).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'accepted',
          correlationId: expect.any(String),
        }),
        timestamp: expect.any(String),
      }),
    );

    // Verify correlationId is passed to runValidation
    expect(mockService.runValidation).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
    );
  });

  it('[P1] GET /api/backtesting/validation/reports should return paginated list ordered by runTimestamp desc', async () => {
    const reports = [
      { id: 2, runTimestamp: new Date('2026-03-27'), confirmedCount: 10 },
      { id: 1, runTimestamp: new Date('2026-03-26'), confirmedCount: 5 },
    ];
    const mockService = createMockValidationService();
    mockService.getReports = vi.fn().mockResolvedValue(reports);

    const module = await Test.createTestingModule({
      controllers: [MatchValidationController],
      providers: [{ provide: MatchValidationService, useValue: mockService }],
    }).compile();

    const controller = module.get(MatchValidationController);
    const result = await controller.getReports(1, 50);

    expect(result).toEqual(
      expect.objectContaining({
        data: reports,
        count: 2,
        timestamp: expect.any(String),
      }),
    );
  });

  it('[P1] GET /api/backtesting/validation/reports/:id should return full report with reportData', async () => {
    const report = {
      id: 1,
      correlationId: 'test-corr',
      reportData: [{ category: 'confirmed' }],
      confirmedCount: 1,
    };
    const mockService = createMockValidationService();
    mockService.getReport = vi.fn().mockResolvedValue(report);

    const module = await Test.createTestingModule({
      controllers: [MatchValidationController],
      providers: [{ provide: MatchValidationService, useValue: mockService }],
    }).compile();

    const controller = module.get(MatchValidationController);
    const result = await controller.getReport(1);

    expect(result).toEqual(
      expect.objectContaining({
        data: report,
        timestamp: expect.any(String),
      }),
    );
  });

  it('[P1] POST /api/backtesting/validation/run should throw SystemHealthError when already running', async () => {
    const mockService = createMockValidationService();
    mockService.isRunning = true;

    const module = await Test.createTestingModule({
      controllers: [MatchValidationController],
      providers: [{ provide: MatchValidationService, useValue: mockService }],
    }).compile();

    const controller = module.get(MatchValidationController);

    expect(() =>
      controller.triggerValidation({ includeSources: [] } as any),
    ).toThrow(SystemHealthError);
  });

  it('[P20] GET /api/backtesting/validation/reports/:id should throw SystemHealthError when report not found', async () => {
    const mockService = createMockValidationService();
    mockService.getReport = vi.fn().mockResolvedValue(null);

    const module = await Test.createTestingModule({
      controllers: [MatchValidationController],
      providers: [{ provide: MatchValidationService, useValue: mockService }],
    }).compile();

    const controller = module.get(MatchValidationController);

    await expect(controller.getReport(999)).rejects.toThrow(SystemHealthError);
  });

  it('[P1] ValidationModule should compile with PredexonMatchingService, MatchValidationService, and OddsPipeService', async () => {
    const { PrismaService } = await import('../../../common/prisma.service');
    const { ConfigService } = await import('@nestjs/config');
    const { EventEmitter2 } = await import('@nestjs/event-emitter');
    const { OddsPipeService } = await import('../ingestion/oddspipe.service');
    const { PredexonMatchingService } =
      await import('../validation/predexon-matching.service');
    const { MatchValidationService } =
      await import('../validation/match-validation.service');

    const module = await Test.createTestingModule({
      controllers: [MatchValidationController],
      providers: [
        { provide: PrismaService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => '' } },
        { provide: EventEmitter2, useValue: { emit: vi.fn() } },
        { provide: OddsPipeService, useValue: { fetchMatchedPairs: vi.fn() } },
        PredexonMatchingService,
        MatchValidationService,
      ],
    }).compile();

    expect(module).toBeDefined();
    expect(module.get(MatchValidationService)).toBeDefined();
    expect(module.get(PredexonMatchingService)).toBeDefined();
    expect(module.get(MatchValidationController)).toBeDefined();
  });
});
