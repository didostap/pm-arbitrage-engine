import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { SingleLegResolutionController } from './single-leg-resolution.controller';
import { SingleLegResolutionService } from './single-leg-resolution.service';
import { AuthTokenGuard } from '../../common/guards/auth-token.guard';
import {
  ExecutionError,
  EXECUTION_ERROR_CODES,
} from '../../common/errors/execution-error';

describe('SingleLegResolutionController', () => {
  let controller: SingleLegResolutionController;
  let resolutionService: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    resolutionService = {
      retryLeg: vi.fn(),
      closeLeg: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SingleLegResolutionController],
      providers: [
        { provide: SingleLegResolutionService, useValue: resolutionService },
        { provide: ConfigService, useValue: { get: () => 'test-token' } },
        AuthTokenGuard,
      ],
    }).compile();

    controller = module.get(SingleLegResolutionController);
  });

  describe('retryLeg', () => {
    it('should return success response with data wrapper', async () => {
      const result = { success: true, orderId: 'order-1', newEdge: 0.06 };
      resolutionService.retryLeg.mockResolvedValue(result);

      const response = await controller.retryLeg('pos-1', { price: 0.55 });

      expect(response.data).toEqual(result);
      expect(response.timestamp).toBeDefined();
      expect(resolutionService.retryLeg).toHaveBeenCalledWith('pos-1', 0.55);
    });

    it('should return 409 when position state is invalid', async () => {
      resolutionService.retryLeg.mockRejectedValue(
        new ExecutionError(
          EXECUTION_ERROR_CODES.INVALID_POSITION_STATE,
          'Position is not in single-leg exposed state',
          'warning',
        ),
      );

      try {
        await controller.retryLeg('pos-1', { price: 0.55 });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        const httpError = error as HttpException;
        expect(httpError.getStatus()).toBe(409);
        const body = httpError.getResponse() as Record<string, unknown>;
        expect((body.error as Record<string, unknown>).code).toBe(
          EXECUTION_ERROR_CODES.INVALID_POSITION_STATE,
        );
      }
    });

    it('should return 502 when platform connector fails', async () => {
      resolutionService.retryLeg.mockRejectedValue(
        new ExecutionError(
          EXECUTION_ERROR_CODES.RETRY_FAILED,
          'API timeout',
          'error',
        ),
      );

      try {
        await controller.retryLeg('pos-1', { price: 0.55 });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(502);
      }
    });

    it('should return 500 for unexpected errors', async () => {
      resolutionService.retryLeg.mockRejectedValue(new Error('Unexpected'));

      try {
        await controller.retryLeg('pos-1', { price: 0.55 });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(500);
      }
    });
  });

  describe('closeLeg', () => {
    it('should return success response with data wrapper', async () => {
      const result = {
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-5.50',
      };
      resolutionService.closeLeg.mockResolvedValue(result);

      const response = await controller.closeLeg('pos-1', {
        rationale: 'Cut losses',
      });

      expect(response.data).toEqual(result);
      expect(response.timestamp).toBeDefined();
      expect(resolutionService.closeLeg).toHaveBeenCalledWith(
        'pos-1',
        'Cut losses',
      );
    });

    it('should accept empty body (rationale optional)', async () => {
      resolutionService.closeLeg.mockResolvedValue({ success: true });

      const response = await controller.closeLeg('pos-1', {});

      expect(response.data.success).toBe(true);
      expect(resolutionService.closeLeg).toHaveBeenCalledWith(
        'pos-1',
        undefined,
      );
    });

    it('should return 409 when position state is invalid', async () => {
      resolutionService.closeLeg.mockRejectedValue(
        new ExecutionError(
          EXECUTION_ERROR_CODES.INVALID_POSITION_STATE,
          'Position is not in single-leg exposed state',
          'warning',
        ),
      );

      try {
        await controller.closeLeg('pos-1', {});
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(409);
      }
    });

    it('should return 422 when order book empty (close failed with warning severity)', async () => {
      resolutionService.closeLeg.mockRejectedValue(
        new ExecutionError(
          EXECUTION_ERROR_CODES.CLOSE_FAILED,
          'Cannot determine close price: order book has no bids',
          'warning',
        ),
      );

      try {
        await controller.closeLeg('pos-1', {});
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(422);
      }
    });

    it('should return 502 when platform submission fails (close failed with error severity)', async () => {
      resolutionService.closeLeg.mockRejectedValue(
        new ExecutionError(
          EXECUTION_ERROR_CODES.CLOSE_FAILED,
          'Close leg submission failed: Platform unavailable',
          'error',
        ),
      );

      try {
        await controller.closeLeg('pos-1', {});
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(502);
      }
    });
  });
});
