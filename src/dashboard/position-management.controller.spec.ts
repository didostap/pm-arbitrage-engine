import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { PositionManagementController } from './position-management.controller';
import { POSITION_CLOSE_SERVICE_TOKEN } from '../common/interfaces/position-close-service.interface';
import { AuthTokenGuard } from '../common/guards/auth-token.guard';

describe('PositionManagementController', () => {
  let controller: PositionManagementController;
  let closeService: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    closeService = {
      closePosition: vi.fn(),
      closeAllPositions: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PositionManagementController],
      providers: [
        { provide: POSITION_CLOSE_SERVICE_TOKEN, useValue: closeService },
      ],
    })
      .overrideGuard(AuthTokenGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<PositionManagementController>(
      PositionManagementController,
    );
  });

  it('should return success response when close succeeds', async () => {
    closeService.closePosition!.mockResolvedValue({
      success: true,
      realizedPnl: '0.01500000',
    });

    const result = await controller.closePosition('pos-1', {});

    expect(result.data).toEqual({
      success: true,
      realizedPnl: '0.01500000',
    });
    expect(result.timestamp).toBeDefined();
    expect(closeService.closePosition).toHaveBeenCalledWith('pos-1', undefined);
  });

  it('should pass rationale to service when provided', async () => {
    closeService.closePosition!.mockResolvedValue({
      success: true,
      realizedPnl: '0.01000000',
    });

    await controller.closePosition('pos-1', { rationale: 'Market reversal' });

    expect(closeService.closePosition).toHaveBeenCalledWith(
      'pos-1',
      'Market reversal',
    );
  });

  it('should return 422 when position is not closeable', async () => {
    closeService.closePosition!.mockResolvedValue({
      success: false,
      error: 'Position is not in a closeable state (current: CLOSED)',
    });

    try {
      await controller.closePosition('pos-1', {});
      expect.fail('Should have thrown');
    } catch (error: unknown) {
      const httpError = error as {
        getStatus: () => number;
        getResponse: () => Record<string, unknown>;
      };
      expect(httpError.getStatus()).toBe(422);
      const response = httpError.getResponse();
      expect(response).toHaveProperty('error');
    }
  });

  it('should return 404 when position not found', async () => {
    closeService.closePosition!.mockResolvedValue({
      success: false,
      error: 'Position not found',
      errorCode: 'NOT_FOUND',
    });

    try {
      await controller.closePosition('nonexistent', {});
      expect.fail('Should have thrown');
    } catch (error: unknown) {
      const httpError = error as { getStatus: () => number };
      expect(httpError.getStatus()).toBe(404);
    }
  });

  describe('closeAll', () => {
    it('should return 202 with batchId', async () => {
      closeService.closeAllPositions!.mockResolvedValue({
        batchId: 'batch-abc-123',
      });

      const result = await controller.closeAll({});

      expect(result.data).toEqual({ batchId: 'batch-abc-123' });
      expect(result.timestamp).toBeDefined();
      expect(closeService.closeAllPositions).toHaveBeenCalledWith(undefined);
    });

    it('should pass rationale to service', async () => {
      closeService.closeAllPositions!.mockResolvedValue({
        batchId: 'batch-def-456',
      });

      await controller.closeAll({ rationale: 'Emergency exit' });

      expect(closeService.closeAllPositions).toHaveBeenCalledWith(
        'Emergency exit',
      );
    });
  });
});
