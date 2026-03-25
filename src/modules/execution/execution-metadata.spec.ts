/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import { PlatformId } from '../../common/types/platform.type';
import { EXECUTION_ERROR_CODES } from '../../common/errors/execution-error';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { createMockPlatformConnector } from '../../test/mock-factories.js';
import type { EnrichedOpportunity } from '../arbitrage-detection/types/enriched-opportunity.type';
import {
  makeKalshiOrderBook,
  makePolymarketOrderBook,
  makeOpportunity,
  makeReservation,
  makeFilledOrder,
  createExecutionTestContext,
  type ExecutionTestContext,
} from './execution-test.helpers';

describe('ExecutionService — metadata, events & subsystem', () => {
  let ctx: ExecutionTestContext;
  let service: ExecutionTestContext['service'];
  let kalshiConnector: ReturnType<typeof createMockPlatformConnector>;
  let polymarketConnector: ReturnType<typeof createMockPlatformConnector>;
  let eventEmitter: ExecutionTestContext['eventEmitter'];
  let positionRepo: ExecutionTestContext['positionRepo'];
  let platformHealthService: ExecutionTestContext['platformHealthService'];

  beforeEach(async () => {
    ctx = await createExecutionTestContext();
    service = ctx.service;
    kalshiConnector = ctx.kalshiConnector;
    polymarketConnector = ctx.polymarketConnector;
    eventEmitter = ctx.eventEmitter;
    positionRepo = ctx.positionRepo;
    platformHealthService = ctx.platformHealthService;
  });

  describe('OrderFilledEvent enrichment (Story 10.1 CF-4)', () => {
    function setupHappyPathForCF4() {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );
    }

    it('should include takerFeeRate and gasEstimate in OrderFilledEvent', async () => {
      setupHappyPathForCF4();

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);

      const filledCalls = eventEmitter.emit.mock.calls.filter(
        (c: unknown[]) => c[0] === EVENT_NAMES.ORDER_FILLED,
      );
      expect(filledCalls.length).toBeGreaterThanOrEqual(2);

      for (const call of filledCalls) {
        const event = call[1] as {
          takerFeeRate?: string;
          gasEstimate?: string | null;
        };
        expect(event.takerFeeRate).toBeDefined();
        expect(event.takerFeeRate).toMatch(/^\d+(\.\d+)?$/);
        if (event.gasEstimate !== null && event.gasEstimate !== undefined) {
          expect(event.gasEstimate).toMatch(/^\d+(\.\d+)?$/);
        }
      }
    });
  });

  describe('execution metadata persistence (Story 10.4)', () => {
    function setupHappyPath() {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );
    }

    function getPersistedMetadata(): Record<string, unknown> {
      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      return JSON.parse(JSON.stringify(posData.executionMetadata)) as Record<
        string,
        unknown
      >;
    }

    it('[P0] should persist execution metadata as JSON on OpenPosition record', async () => {
      kalshiConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: new Date(Date.now() - 5000),
      });
      polymarketConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: new Date(Date.now() - 8000),
      });
      setupHappyPath();

      await service.execute(makeOpportunity(), makeReservation());

      expect(positionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          executionMetadata: expect.objectContaining({
            sequencingReason: expect.any(String),
            kalshiDataSource: expect.any(String),
            polymarketDataSource: expect.any(String),
          }),
        }),
      );
    });

    it('[P0] should include all required fields in persisted execution metadata', async () => {
      kalshiConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: new Date(),
      });
      polymarketConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: new Date(),
      });
      setupHappyPath();

      await service.execute(makeOpportunity(), makeReservation());

      const metadata = getPersistedMetadata();
      expect(metadata).toBeDefined();
      expect(metadata.primaryLeg).toBeDefined();
      expect(metadata.sequencingReason).toBeDefined();
      expect(metadata.kalshiLatencyMs).toBeDefined();
      expect(metadata.polymarketLatencyMs).toBeDefined();
      expect(metadata.kalshiDataSource).toBeDefined();
      expect(metadata.polymarketDataSource).toBeDefined();
      expect(metadata.idealCount).toBeDefined();
      expect(metadata.matchedCount).toBeDefined();
      expect(metadata.divergenceDetected).toBeDefined();
    });

    it('[P1] should set matchedCount to equalizedSize in single-leg-exposure metadata', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      // Secondary leg fails → triggers single-leg exposure
      polymarketConnector.submitOrder.mockRejectedValue(
        new Error('Secondary rejected'),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(true);

      // The position created by handleSingleLeg should carry the correct matchedCount
      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(posData).toBeDefined();
      const metadata = posData.executionMetadata as Record<string, unknown>;
      expect(metadata).toBeDefined();
      // matchedCount should be the equalizedSize, NOT 0
      expect(metadata.matchedCount).toBeGreaterThan(0);
    });

    it('[P1] should handle null latency values gracefully in persisted metadata', async () => {
      setupHappyPath();

      await service.execute(makeOpportunity(), makeReservation());

      const metadata = getPersistedMetadata();
      expect(metadata).toBeDefined();
      expect(metadata.kalshiLatencyMs).toBeNull();
      expect(metadata.polymarketLatencyMs).toBeNull();
      expect(metadata.sequencingReason).toBe('static_config');
    });
  });

  describe('internal subsystem verification (Story 10.4)', () => {
    it('[P0] should submit orders that actually reach the connector mock (subsystem verification)', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      await service.execute(makeOpportunity(), makeReservation());

      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          contractId: expect.any(String),
          side: expect.stringMatching(/^(buy|sell)$/),
          quantity: expect.any(Number),
          price: expect.any(Number),
          type: 'limit',
        }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          contractId: expect.any(String),
          side: expect.stringMatching(/^(buy|sell)$/),
          quantity: expect.any(Number),
          price: expect.any(Number),
          type: 'limit',
        }),
      );
    });

    it('[P0] should call getOrderBookFreshness on both connectors during execution', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      await service.execute(makeOpportunity(), makeReservation());

      expect(kalshiConnector.getOrderBookFreshness).toHaveBeenCalled();
      expect(polymarketConnector.getOrderBookFreshness).toHaveBeenCalled();
    });

    it('[P1] should query platformHealthService for both platforms during sequencing decision', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      await service.execute(makeOpportunity(), makeReservation());

      expect(platformHealthService.getPlatformHealth).toHaveBeenCalledWith(
        PlatformId.KALSHI,
      );
      expect(platformHealthService.getPlatformHealth).toHaveBeenCalledWith(
        PlatformId.POLYMARKET,
      );
    });
  });

  describe('paper-live-boundary (Story 10.4)', () => {
    it('[P0] should apply adaptive sequencing identically in paper mode', async () => {
      platformHealthService.getPlatformHealth.mockImplementation(
        (pid: PlatformId) => ({
          platformId: pid,
          status: 'healthy',
          latencyMs: pid === PlatformId.KALSHI ? 100 : 500,
          lastHeartbeat: new Date(),
          mode: 'paper',
        }),
      );
      kalshiConnector.getHealth.mockReturnValue({
        platformId: PlatformId.KALSHI,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });
      polymarketConnector.getHealth.mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 400,
        mode: 'paper',
      });
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      await service.execute(
        makeOpportunity({ pairConfig: { primaryLeg: 'polymarket' } }),
        makeReservation(),
      );

      const kalshiCallOrder =
        kalshiConnector.submitOrder.mock.invocationCallOrder[0];
      const pmCallOrder =
        polymarketConnector.submitOrder.mock.invocationCallOrder[0];
      expect(kalshiCallOrder).toBeLessThan(pmCallOrder!);
    });

    it('[P0] should apply adaptive sequencing identically in live mode', async () => {
      platformHealthService.getPlatformHealth.mockImplementation(
        (pid: PlatformId) => ({
          platformId: pid,
          status: 'healthy',
          latencyMs: pid === PlatformId.KALSHI ? 100 : 500,
          lastHeartbeat: new Date(),
          mode: 'live',
        }),
      );
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      await service.execute(
        makeOpportunity({ pairConfig: { primaryLeg: 'polymarket' } }),
        makeReservation(),
      );

      const kalshiCallOrder =
        kalshiConnector.submitOrder.mock.invocationCallOrder[0];
      const pmCallOrder =
        polymarketConnector.submitOrder.mock.invocationCallOrder[0];
      expect(kalshiCallOrder).toBeLessThan(pmCallOrder!);
    });

    it('[P0] should compute identical unified sizing in paper and live modes', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      kalshiConnector.getHealth.mockReturnValue({
        platformId: PlatformId.KALSHI,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });

      await service.execute(makeOpportunity(), makeReservation());

      const paperQty = (
        kalshiConnector.submitOrder.mock.calls[0]![0] as { quantity: number }
      ).quantity;

      kalshiConnector.submitOrder.mockClear();
      polymarketConnector.submitOrder.mockClear();
      kalshiConnector.getHealth.mockReturnValue({
        platformId: PlatformId.KALSHI,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'live',
      });
      polymarketConnector.getHealth.mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 100,
      });
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      await service.execute(makeOpportunity(), makeReservation());

      const liveQty = (
        kalshiConnector.submitOrder.mock.calls[0]![0] as { quantity: number }
      ).quantity;

      expect(paperQty).toBe(liveQty);
    });
  });

  describe('close-side price capture (6.5.5i)', () => {
    function setupCloseSideHappyPath() {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );
    }

    it('should persist entry close prices from close-side order books', async () => {
      setupCloseSideHappyPath();
      await service.execute(makeOpportunity(), makeReservation());

      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(posData.entryClosePriceKalshi).toBeCloseTo(0.44, 4);
      expect(posData.entryClosePricePolymarket).toBeCloseTo(0.56, 4);
    });

    it('should persist entry fee rates at close prices', async () => {
      setupCloseSideHappyPath();
      await service.execute(makeOpportunity(), makeReservation());

      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(posData.entryKalshiFeeRate).toBeCloseTo(0.02, 4);
      expect(posData.entryPolymarketFeeRate).toBeCloseTo(0.02, 4);
    });

    it('should fall back to fill price when close-side book is empty', async () => {
      kalshiConnector.getOrderBook
        .mockResolvedValueOnce(makeKalshiOrderBook())
        .mockResolvedValueOnce(makeKalshiOrderBook())
        .mockResolvedValue({ ...makeKalshiOrderBook(), bids: [] });
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI, { filledPrice: 0.45 }),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET, { filledPrice: 0.55 }),
      );

      await service.execute(makeOpportunity(), makeReservation());

      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(posData.entryClosePriceKalshi).toBeCloseTo(0.45, 4);
    });

    it('should fall back to fill prices when order book fetch fails', async () => {
      kalshiConnector.getOrderBook
        .mockResolvedValueOnce(makeKalshiOrderBook())
        .mockResolvedValueOnce(makeKalshiOrderBook())
        .mockRejectedValue(new Error('Network timeout'));
      polymarketConnector.getOrderBook
        .mockResolvedValueOnce(makePolymarketOrderBook())
        .mockResolvedValueOnce(makePolymarketOrderBook())
        .mockRejectedValue(new Error('Rate limited'));
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI, { filledPrice: 0.45 }),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET, { filledPrice: 0.55 }),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(posData.entryClosePriceKalshi).toBeCloseTo(0.45, 4);
      expect(posData.entryClosePricePolymarket).toBeCloseTo(0.55, 4);
    });

    it('should compute fee rates at close prices not fill prices', async () => {
      kalshiConnector.getFeeSchedule.mockReturnValue({
        platformId: PlatformId.KALSHI,
        makerFeePercent: 0,
        takerFeePercent: 7.0,
        description: 'Kalshi dynamic fee schedule',
        takerFeeForPrice: (price: number) => {
          return Math.min(0.07, 0.02 + 0.1 * Math.abs(price - 0.5));
        },
      });
      setupCloseSideHappyPath();
      await service.execute(makeOpportunity(), makeReservation());

      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(posData.entryKalshiFeeRate).toBeCloseTo(0.026, 4);
    });

    it('should capture all four fields on position record', async () => {
      setupCloseSideHappyPath();
      await service.execute(makeOpportunity(), makeReservation());

      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(posData).toHaveProperty('entryClosePriceKalshi');
      expect(posData).toHaveProperty('entryClosePricePolymarket');
      expect(posData).toHaveProperty('entryKalshiFeeRate');
      expect(posData).toHaveProperty('entryPolymarketFeeRate');
      expect(typeof posData.entryClosePriceKalshi).toBe('number');
      expect(typeof posData.entryClosePricePolymarket).toBe('number');
      expect(typeof posData.entryKalshiFeeRate).toBe('number');
      expect(typeof posData.entryPolymarketFeeRate).toBe('number');
    });
  });

  describe('unified sizing formula (Story 10.4)', () => {
    it('[P0] should compute idealCount as floor(reservedCapital / (primaryDivisor + secondaryDivisor))', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
      const expectedIdealCount = new Decimal('100')
        .div(new Decimal('0.45').plus(new Decimal('0.45')))
        .floor()
        .toNumber();
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: expectedIdealCount }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: expectedIdealCount }),
      );
    });

    it('[P0] should guarantee total capital across both legs is within reserved budget', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      const reservation = makeReservation();
      const result = await service.execute(makeOpportunity(), reservation);

      expect(result.success).toBe(true);
      const submittedQty = (
        kalshiConnector.submitOrder.mock.calls[0]![0] as { quantity: number }
      ).quantity;
      const totalCapital = new Decimal(submittedQty).mul(
        new Decimal('0.45').plus(new Decimal('0.45')),
      );
      expect(totalCapital.lte(reservation.reservedCapitalUsd)).toBe(true);
    });

    it('[P0] should apply depth cap from BOTH legs and use matchedCount = min(primaryCapped, secondaryCapped)', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 80 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue({
        ...makePolymarketOrderBook(),
        bids: [{ price: 0.55, quantity: 60 }],
      });
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      const opp = makeOpportunity({ netEdge: new Decimal('0.08') });
      const enriched = opp.opportunity as EnrichedOpportunity;
      enriched.feeBreakdown = {
        buyFeeCost: new Decimal('0.01'),
        sellFeeCost: new Decimal('0.01'),
        gasFraction: new Decimal('0.001'),
        totalCosts: new Decimal('0.021'),
        buyFeeSchedule: {} as any,
        sellFeeSchedule: {} as any,
      };

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(true);
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 60 }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 60 }),
      );
    });

    it('[P0] should trigger edge re-validation when matchedCount < idealCount', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 56 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );

      const opp = makeOpportunity({ netEdge: new Decimal('0.0081') });
      const enriched = opp.opportunity as EnrichedOpportunity;
      enriched.feeBreakdown = {
        buyFeeCost: new Decimal('0.01'),
        sellFeeCost: new Decimal('0.01'),
        gasFraction: new Decimal('0.04'),
        totalCosts: new Decimal('0.06'),
        buyFeeSchedule: {} as any,
        sellFeeSchedule: {} as any,
      };

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.EDGE_ERODED_BY_SIZE,
      );
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('[P1] should reject when combinedDivisor is <= 0', async () => {
      const opp = makeOpportunity({
        buyPrice: new Decimal('0.00'),
        sellPrice: new Decimal('1.00'),
      });

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.GENERIC_EXECUTION_FAILURE,
      );
    });

    it('[P1] should reject when matchedCount falls below min-fill-ratio * idealCount', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 10 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue({
        ...makePolymarketOrderBook(),
        bids: [{ price: 0.55, quantity: 10 }],
      });

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
      );
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('[P1] should produce identical contract counts on both legs (equalization regression)', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
      const primaryQty = (
        kalshiConnector.submitOrder.mock.calls[0]![0] as { quantity: number }
      ).quantity;
      const secondaryQty = (
        polymarketConnector.submitOrder.mock.calls[0]![0] as {
          quantity: number;
        }
      ).quantity;
      expect(primaryQty).toBe(secondaryQty);
    });

    it('[P0] should use actualCapitalUsed = matchedCount * (primaryDivisor + secondaryDivisor)', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
      expect(result.actualCapitalUsed).toBeDefined();
      const submittedQty = (
        kalshiConnector.submitOrder.mock.calls[0]![0] as { quantity: number }
      ).quantity;
      const expectedCapital = new Decimal(submittedQty).mul(
        new Decimal('0.45').plus(new Decimal('0.45')),
      );
      expect(result.actualCapitalUsed!.toNumber()).toBeCloseTo(
        expectedCapital.toNumber(),
        2,
      );
    });
  });

  describe('clean reservation release with unified sizing (Story 10.4)', () => {
    it('[P0] should release budget reservation cleanly when pre-flight depth rejection occurs', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 5 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue({
        ...makePolymarketOrderBook(),
        bids: [{ price: 0.55, quantity: 5 }],
      });

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
      expect(polymarketConnector.submitOrder).not.toHaveBeenCalled();
      expect(positionRepo.create).not.toHaveBeenCalled();
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
      );
    });
  });
});
