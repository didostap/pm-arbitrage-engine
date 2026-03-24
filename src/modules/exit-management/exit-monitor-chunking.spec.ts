/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
/**
 * Story 10-7-5: Exit Execution Chunking & Polymarket Liquidity Handling
 *
 * Tests for depth-matched chunking loop in executeExit().
 * Uses createExitMonitorTestModule() from test helpers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import {
  createExitMonitorTestModule,
  createMockPosition,
  setupOrderCreateMock,
  type ExitMonitorTestContext,
} from './exit-monitor.test-helpers';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { asOrderId } from '../../common/types/branded.type';
import { PlatformId } from '../../common/types/platform.type';

/**
 * Helper: set up order book mocks for both connectors.
 * Returns a function that tracks call counts to simulate depth changes.
 */
function setupDepthMocks(
  ctx: ExitMonitorTestContext,
  kalshiDepths: number[],
  polyDepths: number[],
  kalshiClosePrice = 0.66,
  polyClosePrice = 0.62,
): void {
  // Kalshi entry=buy → close=sell → consumes bids. Place bids at close price.
  let kalshiCallCount = 0;
  ctx.kalshiConnector.getOrderBook.mockImplementation(() => {
    const depth =
      kalshiDepths[Math.min(kalshiCallCount++, kalshiDepths.length - 1)]!;
    return Promise.resolve({
      platformId: PlatformId.KALSHI,
      contractId: 'kalshi-contract-1',
      bids: [{ price: kalshiClosePrice, quantity: depth }],
      asks: [{ price: kalshiClosePrice, quantity: depth }],
      timestamp: new Date(),
    });
  });

  // Polymarket entry=sell → close=buy → consumes asks. Place asks at close price.
  let polyCallCount = 0;
  ctx.polymarketConnector.getOrderBook.mockImplementation(() => {
    const depth = polyDepths[Math.min(polyCallCount++, polyDepths.length - 1)]!;
    return Promise.resolve({
      platformId: PlatformId.POLYMARKET,
      contractId: 'poly-contract-1',
      bids: [{ price: polyClosePrice, quantity: depth }],
      asks: [{ price: polyClosePrice, quantity: depth }],
      timestamp: new Date(),
    });
  });
}

/**
 * Helper: set up submitOrder mocks that return filled at requested size.
 */
function setupSubmitMocks(ctx: ExitMonitorTestContext): void {
  ctx.kalshiConnector.submitOrder.mockImplementation(
    (params: { quantity: number; price: number }) =>
      Promise.resolve({
        orderId: asOrderId(`kalshi-exit-${Date.now()}-${Math.random()}`),
        status: 'filled',
        filledPrice: params.price,
        filledQuantity: params.quantity,
        timestamp: new Date(),
      }),
  );

  ctx.polymarketConnector.submitOrder.mockImplementation(
    (params: { quantity: number; price: number }) =>
      Promise.resolve({
        orderId: asOrderId(`poly-exit-${Date.now()}-${Math.random()}`),
        status: 'filled',
        filledPrice: params.price,
        filledQuantity: params.quantity,
        timestamp: new Date(),
      }),
  );
}

/** Default threshold eval result for exit triggers */
const exitEvalResult = {
  triggered: true,
  type: 'edge_evaporation' as const,
  currentEdge: new Decimal('0.005'),
  currentPnl: new Decimal('0.10'),
  capturedEdgePercent: new Decimal('16.7'),
};

describe('ExitMonitorService — Chunking (Story 10-7-5)', () => {
  let ctx: ExitMonitorTestContext;

  beforeEach(async () => {
    ctx = await createExitMonitorTestModule();
    setupOrderCreateMock(ctx.orderRepository);
    setupSubmitMocks(ctx);
  });

  // ─── Task 5.1: Multi-chunk when position > depth ───
  describe('AC-1: Depth-matched chunking', () => {
    it('should submit multiple chunks when position size exceeds both-leg depth (exitMaxChunkSize=0)', async () => {
      // 50-contract position, 20-contract depth on both sides
      const position = createMockPosition({
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.62'),
          size: new Decimal('50'),
          fillPrice: new Decimal('0.62'),
          fillSize: new Decimal('50'),
          status: 'FILLED',
        },
        polymarketOrder: {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          price: new Decimal('0.65'),
          size: new Decimal('50'),
          fillPrice: new Decimal('0.65'),
          fillSize: new Decimal('50'),
          status: 'FILLED',
        },
      });

      ctx.positionRepository.findByIdWithOrders!.mockResolvedValue(position);

      // Depth is 20 each time → chunks of 20, 20, 10
      setupDepthMocks(ctx, [20, 20, 20], [20, 20, 20]);

      // Invoke private executeExit via the public evaluateAllPositions flow
      // We need to trigger executeExit. Use the service's internal method access.
      const service = ctx.service as any;
      await service.executeExit(
        position,
        exitEvalResult,
        new Decimal('0.66'), // kalshiClosePrice
        new Decimal('0.62'), // polymarketClosePrice
        false, // isPaper
        false, // mixedMode
      );

      // 3 chunks: 20 + 20 + 10 = 50
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenCalledTimes(3);
      expect(ctx.polymarketConnector.submitOrder).toHaveBeenCalledTimes(3);

      // Verify chunk sizes
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ quantity: 20 }),
      );
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ quantity: 20 }),
      );
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ quantity: 10 }),
      );

      // Full exit → closePosition called
      expect(ctx.positionRepository.closePosition).toHaveBeenCalledTimes(1);
    });

    // ─── Task 5.2: Single chunk when depth >= position ───
    it('should submit single chunk when depth >= position size (backward-compatible)', async () => {
      const position = createMockPosition();
      ctx.positionRepository.findByIdWithOrders!.mockResolvedValue(position);

      // 500 depth both sides, 100 position → single chunk
      setupDepthMocks(ctx, [500], [500]);
      const service = ctx.service as any;
      await service.executeExit(
        position,
        exitEvalResult,
        new Decimal('0.66'),
        new Decimal('0.62'),
        false,
        false,
      );

      expect(ctx.kalshiConnector.submitOrder).toHaveBeenCalledTimes(1);
      expect(ctx.polymarketConnector.submitOrder).toHaveBeenCalledTimes(1);
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 100 }),
      );
      expect(ctx.positionRepository.closePosition).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Task 6: Chunk-level single-leg exposure (AC-3) ───
  describe('AC-3: Chunk-level single-leg exposure', () => {
    it('should call handlePartialExit with chunk-level size when secondary fails on chunk 2', async () => {
      // 50-contract position, 20-contract depth
      const position = createMockPosition({
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.62'),
          size: new Decimal('50'),
          fillPrice: new Decimal('0.62'),
          fillSize: new Decimal('50'),
          status: 'FILLED',
        },
        polymarketOrder: {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          price: new Decimal('0.65'),
          size: new Decimal('50'),
          fillPrice: new Decimal('0.65'),
          fillSize: new Decimal('50'),
          status: 'FILLED',
        },
      });
      ctx.positionRepository.findByIdWithOrders!.mockResolvedValue(position);
      setupDepthMocks(ctx, [20, 20, 20], [20, 20, 20]);

      // Chunk 1: both legs succeed. Chunk 2: primary succeeds, secondary fails.
      let kalshiCallCount = 0;
      ctx.kalshiConnector.submitOrder.mockImplementation(
        (params: { quantity: number; price: number }) => {
          kalshiCallCount++;
          return Promise.resolve({
            orderId: asOrderId(`kalshi-exit-${kalshiCallCount}`),
            status: 'filled' as const,
            filledPrice: params.price,
            filledQuantity: params.quantity,
            timestamp: new Date(),
          });
        },
      );

      let polyCallCount = 0;
      ctx.polymarketConnector.submitOrder.mockImplementation(
        (params: { quantity: number; price: number }) => {
          polyCallCount++;
          if (polyCallCount === 2) {
            return Promise.reject(new Error('Polymarket API timeout'));
          }
          return Promise.resolve({
            orderId: asOrderId(`poly-exit-${polyCallCount}`),
            status: 'filled' as const,
            filledPrice: params.price,
            filledQuantity: params.quantity,
            timestamp: new Date(),
          });
        },
      );

      const service = ctx.service as any;
      await service.executeExit(
        position,
        exitEvalResult,
        new Decimal('0.66'),
        new Decimal('0.62'),
        false,
        false,
      );

      // Chunk 1 succeeded (20 contracts), chunk 2 secondary failed
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenCalledTimes(2);
      expect(ctx.polymarketConnector.submitOrder).toHaveBeenCalledTimes(2);

      // D1: handlePartialExit skips updateStatus when chunksCompleted > 0
      expect(ctx.positionRepository.updateStatus).not.toHaveBeenCalled();
      // Post-loop handles status+PnL for completed chunks
      expect(
        ctx.positionRepository.updateStatusWithAccumulatedPnl,
      ).toHaveBeenCalledWith(
        position.positionId,
        'EXIT_PARTIAL',
        expect.any(Decimal),
        expect.any(Decimal),
      );
      // Verify the SINGLE_LEG_EXPOSURE event's failedLeg.attemptedSize = chunk size (20)
      const singleLegCall = ctx.eventEmitter.emit.mock.calls.find(
        (c: unknown[]) => c[0] === EVENT_NAMES.SINGLE_LEG_EXPOSURE,
      );
      expect(singleLegCall).toBeDefined();

      expect(singleLegCall![1].failedLeg.attemptedSize).toBe(20);
    });

    it('should limit exposure to chunk size when secondary fails on chunk 1', async () => {
      const position = createMockPosition();
      ctx.positionRepository.findByIdWithOrders!.mockResolvedValue(position);
      setupDepthMocks(ctx, [500], [500]);

      // Secondary fails immediately on first chunk
      ctx.polymarketConnector.submitOrder.mockRejectedValue(
        new Error('Polymarket connection failed'),
      );

      const service = ctx.service as any;
      await service.executeExit(
        position,
        exitEvalResult,
        new Decimal('0.66'),
        new Decimal('0.62'),
        false,
        false,
      );

      // Only 1 submit per leg (primary succeeded, secondary failed)
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenCalledTimes(1);
      expect(ctx.polymarketConnector.submitOrder).toHaveBeenCalledTimes(1);

      // D1: handlePartialExit SHOULD call updateStatus (chunksCompleted=0, first chunk)
      expect(ctx.positionRepository.updateStatus).toHaveBeenCalledWith(
        position.positionId,
        'EXIT_PARTIAL',
      );
      // No post-loop PnL update (chunksCompleted=0 → early return)
      expect(
        ctx.positionRepository.updateStatusWithAccumulatedPnl,
      ).not.toHaveBeenCalled();
      const singleLegCall = ctx.eventEmitter.emit.mock.calls.find(
        (c: unknown[]) => c[0] === EVENT_NAMES.SINGLE_LEG_EXPOSURE,
      );
      expect(singleLegCall).toBeDefined();

      expect(singleLegCall![1].failedLeg.attemptedSize).toBe(100);
    });

    it('should not call handlePartialExit when primary leg fails', async () => {
      const position = createMockPosition();
      ctx.positionRepository.findByIdWithOrders!.mockResolvedValue(position);
      setupDepthMocks(ctx, [500], [500]);

      // Primary leg fails
      ctx.kalshiConnector.submitOrder.mockRejectedValue(
        new Error('Kalshi API down'),
      );

      const service = ctx.service as any;
      await service.executeExit(
        position,
        exitEvalResult,
        new Decimal('0.66'),
        new Decimal('0.62'),
        false,
        false,
      );

      // No handlePartialExit — no single-leg exposure since primary didn't fill
      expect(ctx.positionRepository.updateStatus).not.toHaveBeenCalled();
      expect(ctx.positionRepository.closePosition).not.toHaveBeenCalled();
      expect(
        ctx.positionRepository.updateStatusWithAccumulatedPnl,
      ).not.toHaveBeenCalled();
      // No events emitted for single-leg exposure
      const singleLegCall = ctx.eventEmitter.emit.mock.calls.find(
        (c: unknown[]) => c[0] === EVENT_NAMES.SINGLE_LEG_EXPOSURE,
      );
      expect(singleLegCall).toBeUndefined();
    });
  });

  // ─── Task 7: Residual continuation and PnL accumulation (AC-2) ───
  describe('AC-2: Residual tracking and PnL accumulation', () => {
    it('should accumulate PnL across 3 successful chunks and call closePosition', async () => {
      // 60-contract position, 20-contract depth → 3 chunks of 20
      const position = createMockPosition({
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.62'),
          size: new Decimal('60'),
          fillPrice: new Decimal('0.62'),
          fillSize: new Decimal('60'),
          status: 'FILLED',
        },
        polymarketOrder: {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          price: new Decimal('0.65'),
          size: new Decimal('60'),
          fillPrice: new Decimal('0.65'),
          fillSize: new Decimal('60'),
          status: 'FILLED',
        },
      });
      ctx.positionRepository.findByIdWithOrders!.mockResolvedValue(position);
      setupDepthMocks(ctx, [20, 20, 20], [20, 20, 20]);

      const service = ctx.service as any;
      await service.executeExit(
        position,
        exitEvalResult,
        new Decimal('0.66'),
        new Decimal('0.62'),
        false,
        false,
      );

      // 3 chunks: 20 + 20 + 20 = 60 → full exit
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenCalledTimes(3);
      expect(ctx.polymarketConnector.submitOrder).toHaveBeenCalledTimes(3);
      expect(ctx.positionRepository.closePosition).toHaveBeenCalledTimes(1);

      // Verify accumulated PnL is passed (Decimal, not zero)
      const closeCall = ctx.positionRepository.closePosition.mock.calls[0]!;
      const accPnl = closeCall[1] as Decimal;
      expect(accPnl).toBeInstanceOf(Decimal);
      // PnL = 3 chunks × per-chunk PnL. Each chunk: kalshi (0.66-0.62)×20=0.8, poly (0.65-0.62)×20=0.6, minus fees
      expect(accPnl.toNumber()).not.toBe(0);
    });

    it('should call updateStatusWithAccumulatedPnl for partial chunked exit (2 of 3 chunks)', async () => {
      // 60-contract position, depth drops to 0 after chunk 2
      const position = createMockPosition({
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.62'),
          size: new Decimal('60'),
          fillPrice: new Decimal('0.62'),
          fillSize: new Decimal('60'),
          status: 'FILLED',
        },
        polymarketOrder: {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          price: new Decimal('0.65'),
          size: new Decimal('60'),
          fillPrice: new Decimal('0.65'),
          fillSize: new Decimal('60'),
          status: 'FILLED',
        },
      });
      ctx.positionRepository.findByIdWithOrders!.mockResolvedValue(position);

      // Depth: 20, 20, then 0 (exhausted)
      setupDepthMocks(ctx, [20, 20, 0], [20, 20, 0]);

      const service = ctx.service as any;
      await service.executeExit(
        position,
        exitEvalResult,
        new Decimal('0.66'),
        new Decimal('0.62'),
        false,
        false,
      );

      // 2 chunks completed, then depth exhausted
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenCalledTimes(2);
      expect(ctx.polymarketConnector.submitOrder).toHaveBeenCalledTimes(2);

      // Partial exit → updateStatusWithAccumulatedPnl
      expect(
        ctx.positionRepository.updateStatusWithAccumulatedPnl,
      ).toHaveBeenCalledWith(
        position.positionId,
        'EXIT_PARTIAL',
        expect.any(Decimal),
        expect.any(Decimal),
      );
      expect(ctx.positionRepository.closePosition).not.toHaveBeenCalled();
    });

    it('should respect residual sizes from prior partial exit', async () => {
      // EXIT_PARTIAL position: entry=100, prior exit=60, residual=40
      const position = createMockPosition({
        status: 'EXIT_PARTIAL',
        realizedPnl: new Decimal('1.50'),
      });
      ctx.positionRepository.findByIdWithOrders!.mockResolvedValue(position);
      setupDepthMocks(ctx, [500], [500]);

      const service = ctx.service as any;
      // Pass effective sizes as residual (40 each)
      await service.executeExit(
        position,
        exitEvalResult,
        new Decimal('0.66'),
        new Decimal('0.62'),
        false,
        false,
        new Decimal('40'), // kalshiEffectiveSize
        new Decimal('40'), // polymarketEffectiveSize
      );

      // Single chunk of 40 (min of depth=500, remaining=40)
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenCalledTimes(1);
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 40 }),
      );

      // Full exit of remaining → closePosition with accumulated PnL (existing + chunk)
      expect(ctx.positionRepository.closePosition).toHaveBeenCalledTimes(1);
      const closeCall = ctx.positionRepository.closePosition.mock.calls[0]!;
      const accPnl = closeCall[1] as Decimal;
      // accumulatedPnl = existingPnl(1.50) + chunkPnl
      expect(accPnl.toNumber()).toBeGreaterThan(1.5);
    });
  });

  // ─── Task 8: Backward compatibility and config (AC-4) ───
  describe('AC-4: Config and backward compatibility', () => {
    it('should behave identically to pre-story when exitMaxChunkSize=0 and depth >= position', async () => {
      const position = createMockPosition();
      ctx.positionRepository.findByIdWithOrders!.mockResolvedValue(position);
      setupDepthMocks(ctx, [500], [500]);

      const service = ctx.service as any;
      await service.executeExit(
        position,
        exitEvalResult,
        new Decimal('0.66'),
        new Decimal('0.62'),
        false,
        false,
      );

      // Single chunk, full exit — identical to pre-story behavior
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenCalledTimes(1);
      expect(ctx.polymarketConnector.submitOrder).toHaveBeenCalledTimes(1);
      expect(ctx.positionRepository.closePosition).toHaveBeenCalledTimes(1);
    });

    it('should cap each chunk to exitMaxChunkSize when set', async () => {
      const position = createMockPosition({
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.62'),
          size: new Decimal('25'),
          fillPrice: new Decimal('0.62'),
          fillSize: new Decimal('25'),
          status: 'FILLED',
        },
        polymarketOrder: {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          price: new Decimal('0.65'),
          size: new Decimal('25'),
          fillPrice: new Decimal('0.65'),
          fillSize: new Decimal('25'),
          status: 'FILLED',
        },
      });
      ctx.positionRepository.findByIdWithOrders!.mockResolvedValue(position);
      setupDepthMocks(ctx, [500, 500, 500], [500, 500, 500]);

      // Set exitMaxChunkSize = 10 via reloadConfig
      (ctx.service as any).exitMaxChunkSize = 10;

      const service = ctx.service as any;
      await service.executeExit(
        position,
        exitEvalResult,
        new Decimal('0.66'),
        new Decimal('0.62'),
        false,
        false,
      );

      // 25-contract position, depth=500, exitMaxChunkSize=10 → 3 chunks (10+10+5)
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenCalledTimes(3);
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ quantity: 10 }),
      );
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ quantity: 10 }),
      );
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ quantity: 5 }),
      );
    });

    it('should use new exitMaxChunkSize after hot-reload', () => {
      const service = ctx.service as any;

      // Initial value
      expect(service.exitMaxChunkSize).toBe(0);

      // Simulate hot-reload
      service.reloadConfig({ exitMaxChunkSize: 15 });
      expect(service.exitMaxChunkSize).toBe(15);

      // Change again
      service.reloadConfig({ exitMaxChunkSize: 0 });
      expect(service.exitMaxChunkSize).toBe(0);
    });
  });

  // ─── Task 9: Depth fetch per chunk (AC-1) ───
  describe('AC-1: Fresh depth per chunk', () => {
    it('should use smaller chunk when depth decreases between chunks', async () => {
      const position = createMockPosition({
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.62'),
          size: new Decimal('50'),
          fillPrice: new Decimal('0.62'),
          fillSize: new Decimal('50'),
          status: 'FILLED',
        },
        polymarketOrder: {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          price: new Decimal('0.65'),
          size: new Decimal('50'),
          fillPrice: new Decimal('0.65'),
          fillSize: new Decimal('50'),
          status: 'FILLED',
        },
      });
      ctx.positionRepository.findByIdWithOrders!.mockResolvedValue(position);

      // Decreasing depth: 30, 15, then enough for remainder
      setupDepthMocks(ctx, [30, 15, 500], [30, 15, 500]);

      const service = ctx.service as any;
      await service.executeExit(
        position,
        exitEvalResult,
        new Decimal('0.66'),
        new Decimal('0.62'),
        false,
        false,
      );

      // Chunk 1: 30, Chunk 2: 15, Chunk 3: 5 (remaining)
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenCalledTimes(3);
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ quantity: 30 }),
      );
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ quantity: 15 }),
      );
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ quantity: 5 }),
      );
    });

    it('should stop chunking when depth drops to zero and transition to EXIT_PARTIAL', async () => {
      const position = createMockPosition({
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.62'),
          size: new Decimal('50'),
          fillPrice: new Decimal('0.62'),
          fillSize: new Decimal('50'),
          status: 'FILLED',
        },
        polymarketOrder: {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          price: new Decimal('0.65'),
          size: new Decimal('50'),
          fillPrice: new Decimal('0.65'),
          fillSize: new Decimal('50'),
          status: 'FILLED',
        },
      });
      ctx.positionRepository.findByIdWithOrders!.mockResolvedValue(position);

      // Depth: 20 for first chunk, then 0
      setupDepthMocks(ctx, [20, 0], [20, 0]);

      const service = ctx.service as any;
      await service.executeExit(
        position,
        exitEvalResult,
        new Decimal('0.66'),
        new Decimal('0.62'),
        false,
        false,
      );

      // Only 1 chunk completed (20 of 50)
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenCalledTimes(1);
      expect(ctx.polymarketConnector.submitOrder).toHaveBeenCalledTimes(1);

      // Partial exit with accumulated PnL from 1 chunk
      expect(
        ctx.positionRepository.updateStatusWithAccumulatedPnl,
      ).toHaveBeenCalledWith(
        position.positionId,
        'EXIT_PARTIAL',
        expect.any(Decimal),
        expect.any(Decimal),
      );
      expect(ctx.positionRepository.closePosition).not.toHaveBeenCalled();
    });
  });

  // ─── D2: Depth fetch failure breaks loop ───
  describe('D2: Depth fetch failure breaks loop', () => {
    it('should break loop and persist partial PnL when depth fetch fails mid-chunking', async () => {
      // 50-contract position, chunk 1 succeeds (depth=20), chunk 2 depth fetch fails
      const position = createMockPosition({
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.62'),
          size: new Decimal('50'),
          fillPrice: new Decimal('0.62'),
          fillSize: new Decimal('50'),
          status: 'FILLED',
        },
        polymarketOrder: {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          price: new Decimal('0.65'),
          size: new Decimal('50'),
          fillPrice: new Decimal('0.65'),
          fillSize: new Decimal('50'),
          status: 'FILLED',
        },
      });
      ctx.positionRepository.findByIdWithOrders!.mockResolvedValue(position);

      // Kalshi: chunk 1 depth OK, chunk 2 depth fetch throws
      let kalshiDepthCall = 0;
      ctx.kalshiConnector.getOrderBook.mockImplementation(() => {
        kalshiDepthCall++;
        if (kalshiDepthCall === 2) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve({
          platformId: PlatformId.KALSHI,
          contractId: 'kalshi-contract-1',
          bids: [{ price: 0.66, quantity: 20 }],
          asks: [{ price: 0.68, quantity: 20 }],
          timestamp: new Date(),
        });
      });

      // Polymarket: always available
      ctx.polymarketConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: 'poly-contract-1',
        bids: [{ price: 0.62, quantity: 500 }],
        asks: [{ price: 0.62, quantity: 500 }],
        timestamp: new Date(),
      });

      const service = ctx.service as any;
      await service.executeExit(
        position,
        exitEvalResult,
        new Decimal('0.66'),
        new Decimal('0.62'),
        false,
        false,
      );

      // 1 chunk completed, then depth fetch failed → break
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenCalledTimes(1);
      expect(ctx.polymarketConnector.submitOrder).toHaveBeenCalledTimes(1);

      // Partial exit with PnL from 1 chunk
      expect(
        ctx.positionRepository.updateStatusWithAccumulatedPnl,
      ).toHaveBeenCalledWith(
        position.positionId,
        'EXIT_PARTIAL',
        expect.any(Decimal),
        expect.any(Decimal),
      );
      expect(ctx.positionRepository.closePosition).not.toHaveBeenCalled();
    });
  });

  // ─── P1: Zero fill size guard ───
  describe('P1: Zero fill size guard', () => {
    it('should break loop when platform returns partial with zero filledQuantity', async () => {
      const position = createMockPosition({
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.62'),
          size: new Decimal('50'),
          fillPrice: new Decimal('0.62'),
          fillSize: new Decimal('50'),
          status: 'FILLED',
        },
        polymarketOrder: {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          price: new Decimal('0.65'),
          size: new Decimal('50'),
          fillPrice: new Decimal('0.65'),
          fillSize: new Decimal('50'),
          status: 'FILLED',
        },
      });
      ctx.positionRepository.findByIdWithOrders!.mockResolvedValue(position);
      setupDepthMocks(ctx, [20, 20], [20, 20]);

      // Both legs return 'partial' with filledQuantity=0
      ctx.kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('k-exit-1'),
        status: 'partial',
        filledPrice: 0.66,
        filledQuantity: 0,
        timestamp: new Date(),
      });
      ctx.polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('p-exit-1'),
        status: 'partial',
        filledPrice: 0.62,
        filledQuantity: 0,
        timestamp: new Date(),
      });

      const service = ctx.service as any;
      await service.executeExit(
        position,
        exitEvalResult,
        new Decimal('0.66'),
        new Decimal('0.62'),
        false,
        false,
      );

      // Should only attempt 1 iteration, not loop 50 times
      expect(ctx.kalshiConnector.submitOrder).toHaveBeenCalledTimes(1);
      expect(ctx.polymarketConnector.submitOrder).toHaveBeenCalledTimes(1);
      // No chunks completed (zero fill) → returns early
      expect(ctx.positionRepository.closePosition).not.toHaveBeenCalled();
      expect(
        ctx.positionRepository.updateStatusWithAccumulatedPnl,
      ).not.toHaveBeenCalled();
    });
  });

  // ─── BS1/D3: Event emission with chunksCompleted ───
  describe('BS1/D3: Chunked exit events', () => {
    it('should emit EXIT_PARTIAL_CHUNKED with chunksCompleted and isPartial=true for partial exit', async () => {
      // 60-contract position, depth 20 → 2 chunks then exhausted
      const position = createMockPosition({
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.62'),
          size: new Decimal('60'),
          fillPrice: new Decimal('0.62'),
          fillSize: new Decimal('60'),
          status: 'FILLED',
        },
        polymarketOrder: {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          price: new Decimal('0.65'),
          size: new Decimal('60'),
          fillPrice: new Decimal('0.65'),
          fillSize: new Decimal('60'),
          status: 'FILLED',
        },
      });
      ctx.positionRepository.findByIdWithOrders!.mockResolvedValue(position);
      setupDepthMocks(ctx, [20, 20, 0], [20, 20, 0]);

      const service = ctx.service as any;
      await service.executeExit(
        position,
        exitEvalResult,
        new Decimal('0.66'),
        new Decimal('0.62'),
        false,
        false,
      );

      const partialCall = ctx.eventEmitter.emit.mock.calls.find(
        (c: unknown[]) => c[0] === EVENT_NAMES.EXIT_PARTIAL_CHUNKED,
      );
      expect(partialCall).toBeDefined();
      expect(partialCall![1]).toEqual(
        expect.objectContaining({
          positionId: position.positionId,
          chunksCompleted: 2,
          isPartial: true,
        }),
      );
    });

    it('should emit EXIT_TRIGGERED with chunksCompleted and isPartial=false for full exit', async () => {
      // 60-contract position, 20-contract depth → 3 chunks fully exit
      const position = createMockPosition({
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.62'),
          size: new Decimal('60'),
          fillPrice: new Decimal('0.62'),
          fillSize: new Decimal('60'),
          status: 'FILLED',
        },
        polymarketOrder: {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          price: new Decimal('0.65'),
          size: new Decimal('60'),
          fillPrice: new Decimal('0.65'),
          fillSize: new Decimal('60'),
          status: 'FILLED',
        },
      });
      ctx.positionRepository.findByIdWithOrders!.mockResolvedValue(position);
      setupDepthMocks(ctx, [20, 20, 20], [20, 20, 20]);

      const service = ctx.service as any;
      await service.executeExit(
        position,
        exitEvalResult,
        new Decimal('0.66'),
        new Decimal('0.62'),
        false,
        false,
      );

      const exitCall = ctx.eventEmitter.emit.mock.calls.find(
        (c: unknown[]) => c[0] === EVENT_NAMES.EXIT_TRIGGERED,
      );
      expect(exitCall).toBeDefined();
      expect(exitCall![1]).toEqual(
        expect.objectContaining({
          positionId: position.positionId,
          chunksCompleted: 3,
          isPartial: false,
        }),
      );
    });
  });
});
