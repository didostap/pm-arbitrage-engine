import { describe, it, expect, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import { PlatformId } from '../../common/types/platform.type';
import { EXECUTION_ERROR_CODES } from '../../common/errors/execution-error';
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

describe('ExecutionService — sizing logic', () => {
  let ctx: ExecutionTestContext;
  let service: ExecutionTestContext['service'];
  let kalshiConnector: ReturnType<typeof createMockPlatformConnector>;
  let polymarketConnector: ReturnType<typeof createMockPlatformConnector>;
  let positionRepo: ExecutionTestContext['positionRepo'];

  beforeEach(async () => {
    ctx = await createExecutionTestContext();
    service = ctx.service;
    kalshiConnector = ctx.kalshiConnector;
    polymarketConnector = ctx.polymarketConnector;
    positionRepo = ctx.positionRepo;
  });

  describe('depth-aware sizing', () => {
    it('should execute at full ideal size when depth is sufficient', async () => {
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
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 111 }),
      );
      expect(result.actualCapitalUsed).toBeDefined();
    });

    it('should cap primary to available depth and equalize both legs', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 100 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
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
        buyFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        sellFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      };

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(true);
      expect(result.partialFill).toBe(false);
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 100 }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 100 }),
      );
      expect(result.actualCapitalUsed).toBeDefined();
      const expected = new Decimal(100)
        .mul('0.45')
        .plus(new Decimal(100).mul('0.45'));
      expect(result.actualCapitalUsed!.toNumber()).toBeCloseTo(
        expected.toNumber(),
        2,
      );
    });

    it('should reject when primary depth below threshold', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 10 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );

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
      expect(result.actualCapitalUsed).toBeUndefined();
    });

    it('should reject cleanly when secondary depth below threshold (pre-submission)', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
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
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
      );
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should compute secondary ideal size with collateral-aware formula', async () => {
      const opp = makeOpportunity({
        buyPrice: new Decimal('0.10'),
        sellPrice: new Decimal('0.90'),
        netEdge: new Decimal('0.08'),
      });
      const enriched = opp.opportunity as EnrichedOpportunity;
      enriched.feeBreakdown = {
        buyFeeCost: new Decimal('0.01'),
        sellFeeCost: new Decimal('0.01'),
        gasFraction: new Decimal('0.001'),
        totalCosts: new Decimal('0.021'),
        buyFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        sellFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      };
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.1, quantity: 2000 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue({
        ...makePolymarketOrderBook(),
        bids: [{ price: 0.9, quantity: 300 }],
      });
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(true);
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 300 }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 300 }),
      );
    });

    it('should equalize asymmetric depth to smaller leg', async () => {
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
        gasFraction: new Decimal('0.002'),
        totalCosts: new Decimal('0.022'),
        buyFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        sellFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
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

    it('should reject when ideal size is 0 (tiny reservation, high combined divisor)', async () => {
      const opp = makeOpportunity({
        buyPrice: new Decimal('0.99'),
        sellPrice: new Decimal('0.01'),
      });
      const reservation = {
        ...makeReservation(),
        reservedCapitalUsd: new Decimal('0.5'),
      };

      const result = await service.execute(opp, reservation);

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.GENERIC_EXECUTION_FAILURE,
      );
      expect(result.error?.message).toContain('Ideal position size is 0');
    });

    it('should reject cleanly when combined divisor is non-positive (pre-submission)', async () => {
      const opp = makeOpportunity({
        buyPrice: new Decimal('0.50'),
        sellPrice: new Decimal('5.00'),
      });
      const reservation = {
        ...makeReservation(),
        reservedCapitalUsd: new Decimal('1'),
      };

      const result = await service.execute(opp, reservation);

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(result.error?.message).toContain(
        'Non-positive combined collateral divisor',
      );
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should pass edge re-validation when size reduced but edge still above threshold', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 111 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
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
        buyFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        sellFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      };

      const result = await service.execute(opp, makeReservation());
      expect(result.success).toBe(true);
    });

    it('should reject cleanly with EDGE_ERODED_BY_SIZE when gas fraction quadruples (pre-submission)', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 56 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );

      const opp = makeOpportunity({ netEdge: new Decimal('0.015') });
      const enriched = opp.opportunity as EnrichedOpportunity;
      enriched.feeBreakdown = {
        buyFeeCost: new Decimal('0.01'),
        sellFeeCost: new Decimal('0.01'),
        gasFraction: new Decimal('0.01'),
        totalCosts: new Decimal('0.03'),
        buyFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        sellFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      };

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.EDGE_ERODED_BY_SIZE,
      );
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should skip edge re-validation when no size was capped', async () => {
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
    });

    it('should reject cleanly when gasFraction is missing during edge re-validation (pre-submission)', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 100 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should not leak capital on failure after depth cap', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 100 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );

      const reservation = makeReservation();
      const originalCapital = reservation.reservedCapitalUsd.toString();

      const result = await service.execute(makeOpportunity(), reservation);

      expect(result.success).toBe(false);
      expect(reservation.reservedCapitalUsd.toString()).toBe(originalCapital);
      expect(result.actualCapitalUsed).toBeUndefined();
    });

    it('should return collateral-aware actualCapitalUsed reflecting both legs on success', async () => {
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
      const expected = new Decimal(111)
        .mul('0.45')
        .plus(new Decimal(111).mul('0.45'));
      expect(result.actualCapitalUsed!.toNumber()).toBeCloseTo(
        expected.toNumber(),
        2,
      );
    });
  });

  describe('equal leg sizing (collateral-aware + equalization)', () => {
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

    it('should use collateral-aware formula for sell legs: floor(budget / (1 - price))', async () => {
      setupHappyPath();
      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 111 }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 111 }),
      );
    });

    it('should produce different sell sizes than buy-only formula', async () => {
      const opp = makeOpportunity({
        buyPrice: new Decimal('0.17'),
        sellPrice: new Decimal('0.21'),
        buyPlatformId: PlatformId.KALSHI,
        sellPlatformId: PlatformId.POLYMARKET,
        netEdge: new Decimal('0.08'),
      });
      const enriched = opp.opportunity as EnrichedOpportunity;
      enriched.feeBreakdown = {
        buyFeeCost: new Decimal('0.01'),
        sellFeeCost: new Decimal('0.01'),
        gasFraction: new Decimal('0.001'),
        totalCosts: new Decimal('0.021'),
        buyFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        sellFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      };
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.17, quantity: 1000 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue({
        ...makePolymarketOrderBook(),
        bids: [{ price: 0.21, quantity: 1000 }],
      });
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(true);
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 104 }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 104 }),
      );
    });

    it('should equalize to smaller leg when depths differ asymmetrically', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 90 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue({
        ...makePolymarketOrderBook(),
        bids: [{ price: 0.55, quantity: 70 }],
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
        gasFraction: new Decimal('0.002'),
        totalCosts: new Decimal('0.022'),
        buyFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        sellFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      };

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(true);
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 70 }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 70 }),
      );
    });

    it('should persist position with equal sizes for both legs', async () => {
      setupHappyPath();
      await service.execute(makeOpportunity(), makeReservation());

      const positionData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      const sizes = positionData.sizes as {
        kalshi: string;
        polymarket: string;
      };
      expect(sizes.kalshi).toBe(sizes.polymarket);
    });

    it('should compute actualCapitalUsed with collateral-aware formula', async () => {
      setupHappyPath();
      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
      const expected = new Decimal(111)
        .mul('0.45')
        .plus(new Decimal(111).mul('0.45'));
      expect(result.actualCapitalUsed!.toNumber()).toBeCloseTo(
        expected.toNumber(),
        2,
      );
    });

    it('should check both depths BEFORE submitting any orders', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
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
    });

    it('should reject cleanly when idealCount is 0 (tiny reservation, pre-submission)', async () => {
      const opp = makeOpportunity({
        buyPrice: new Decimal('0.99'),
        sellPrice: new Decimal('0.01'),
      });
      const reservation = {
        ...makeReservation(),
        reservedCapitalUsd: new Decimal('0.5'),
      };

      const result = await service.execute(opp, reservation);

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(result.error?.message).toContain('Ideal position size is 0');
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should reject when edge eroded at equalized size (pre-submission)', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 56 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );

      const opp = makeOpportunity({ netEdge: new Decimal('0.015') });
      const enriched = opp.opportunity as EnrichedOpportunity;
      enriched.feeBreakdown = {
        buyFeeCost: new Decimal('0.01'),
        sellFeeCost: new Decimal('0.01'),
        gasFraction: new Decimal('0.01'),
        totalCosts: new Decimal('0.03'),
        buyFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        sellFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      };

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.EDGE_ERODED_BY_SIZE,
      );
    });

    it('should guarantee profit under YES outcome with equal sizes', async () => {
      setupHappyPath();
      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
      const kalshiCall = kalshiConnector.submitOrder.mock.calls[0]?.[0] as {
        quantity: number;
      };
      const pmCall = polymarketConnector.submitOrder.mock.calls[0]?.[0] as {
        quantity: number;
      };
      const legSize = kalshiCall.quantity;
      expect(legSize).toBe(pmCall.quantity);

      const buyPrice = new Decimal('0.45');
      const sellPrice = new Decimal('0.55');
      const yesProfit = new Decimal(1)
        .minus(buyPrice)
        .mul(legSize)
        .minus(new Decimal(1).minus(sellPrice).mul(legSize));
      expect(yesProfit.toNumber()).toBeGreaterThan(0);
    });

    it('should guarantee profit under NO outcome with equal sizes', async () => {
      setupHappyPath();
      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
      const kalshiCall = kalshiConnector.submitOrder.mock.calls[0]?.[0] as {
        quantity: number;
      };
      const pmCall = polymarketConnector.submitOrder.mock.calls[0]?.[0] as {
        quantity: number;
      };
      const legSize = kalshiCall.quantity;
      expect(legSize).toBe(pmCall.quantity);

      const buyPrice = new Decimal('0.45');
      const sellPrice = new Decimal('0.55');
      const noProfit = sellPrice.mul(legSize).minus(buyPrice.mul(legSize));
      expect(noProfit.toNumber()).toBeGreaterThan(0);
    });

    it('should not change equalization when both legs have identical ideal sizes and depth', async () => {
      setupHappyPath();
      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 111 }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 111 }),
      );
    });

    it('should handle single-leg when primary fills but secondary submission fails', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockRejectedValue(
        new Error('Network timeout'),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(true);
      expect(result.positionId).toBeDefined();
    });

    it('should handle single-leg when primary fills but secondary is rejected', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET, { status: 'rejected' }),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(true);
    });

    it('should reject when combined divisor is non-positive (sell price > 1.0)', async () => {
      const opp = makeOpportunity({
        buyPrice: new Decimal('0.50'),
        sellPrice: new Decimal('1.50'),
      });

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.GENERIC_EXECUTION_FAILURE,
      );
      expect(result.error?.message).toContain(
        'Non-positive combined collateral divisor',
      );
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should reject when primary sell makes combined divisor negative', async () => {
      const opp = makeOpportunity({
        buyPrice: new Decimal('0.50'),
        sellPrice: new Decimal('1.50'),
        buyPlatformId: PlatformId.POLYMARKET,
        sellPlatformId: PlatformId.KALSHI,
      });

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(result.error?.message).toContain(
        'Non-positive combined collateral divisor',
      );
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    // NOTE: LEG_SIZE_MISMATCH runtime invariant (targetSize !== secondarySize) is
    // unreachable by construction — equalization sets both to equalizedSize 3 lines
    // above the check. It exists as a regression safety net. The positive path
    // (sizes ARE equal) is implicitly verified by every successful execution test.
  });
});
