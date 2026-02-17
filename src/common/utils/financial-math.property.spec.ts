// Disabled for test file: dynamic imports for DI-heavy service mocking produce unresolvable types

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FinancialMath, FinancialDecimal } from './financial-math';
import { FeeSchedule, PlatformId } from '../types/platform.type';
import { RiskManagerService } from '../../modules/risk-management/risk-manager.service';
import { PrismaService } from '../prisma.service';

// ── Arbitraries ──

const priceArb = fc
  .double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true })
  .map((v) => new FinancialDecimal(v));

const feeArb = fc.double({
  min: 0,
  max: 5,
  noNaN: true,
  noDefaultInfinity: true,
});

const gasArb = fc
  .double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true })
  .map((v) => new FinancialDecimal(v));

const positionSizeArb = fc
  .integer({ min: 10, max: 10000 })
  .map((v) => new FinancialDecimal(v));

const bankrollArb = fc
  .integer({ min: 1000, max: 1000000 })
  .map((v) => new FinancialDecimal(v));

const maxPositionPctArb = fc.double({
  min: 0.01,
  max: 0.1,
  noNaN: true,
  noDefaultInfinity: true,
});

function makeFeeSchedule(takerFeePercent: number): FeeSchedule {
  return {
    platformId: PlatformId.KALSHI,
    makerFeePercent: 0,
    takerFeePercent,
    description: 'test fee schedule',
  };
}

// ── Task 2: calculateGrossEdge properties ──

describe('FinancialMath.calculateGrossEdge property tests', () => {
  it('result is always a finite Decimal', { timeout: 30000 }, () => {
    fc.assert(
      fc.property(priceArb, priceArb, (buyPrice, sellPrice) => {
        const result = FinancialMath.calculateGrossEdge(buyPrice, sellPrice);
        expect(result.isFinite()).toBe(true);
        expect(result.isNaN()).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });

  it(
    'complementary pricing symmetry: grossEdge(buy, sell) === grossEdge(1 - sell, 1 - buy)',
    { timeout: 30000 },
    () => {
      fc.assert(
        fc.property(priceArb, priceArb, (buyPrice, sellPrice) => {
          const result1 = FinancialMath.calculateGrossEdge(buyPrice, sellPrice);
          const compBuy = new FinancialDecimal(1).minus(sellPrice);
          const compSell = new FinancialDecimal(1).minus(buyPrice);
          const result2 = FinancialMath.calculateGrossEdge(compBuy, compSell);
          expect(result1.toFixed(18)).toBe(result2.toFixed(18));
        }),
        { numRuns: 1000 },
      );
    },
  );

  it('boundary: grossEdge(0.5, 0.5) yields 0', () => {
    const result = FinancialMath.calculateGrossEdge(
      new FinancialDecimal(0.5),
      new FinancialDecimal(0.5),
    );
    expect(result.toNumber()).toBe(0);
  });

  it('result <= 1 (bounded by price range)', { timeout: 30000 }, () => {
    fc.assert(
      fc.property(priceArb, priceArb, (buyPrice, sellPrice) => {
        const result = FinancialMath.calculateGrossEdge(buyPrice, sellPrice);
        expect(result.lte(new FinancialDecimal(1))).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });
});

// ── Task 3: calculateNetEdge properties ──

describe('FinancialMath.calculateNetEdge property tests', () => {
  const grossEdgeArb = fc
    .double({ min: 0, max: 0.5, noNaN: true, noDefaultInfinity: true })
    .map((v) => new FinancialDecimal(v));

  it(
    'netEdge <= grossEdge always (fees and gas only subtract)',
    { timeout: 30000 },
    () => {
      fc.assert(
        fc.property(
          grossEdgeArb,
          priceArb,
          priceArb,
          feeArb,
          feeArb,
          gasArb,
          positionSizeArb,
          (grossEdge, buyPrice, sellPrice, buyFee, sellFee, gas, posSize) => {
            const netEdge = FinancialMath.calculateNetEdge(
              grossEdge,
              buyPrice,
              sellPrice,
              makeFeeSchedule(buyFee),
              makeFeeSchedule(sellFee),
              gas,
              posSize,
            );
            expect(netEdge.lte(grossEdge)).toBe(true);
          },
        ),
        { numRuns: 1000 },
      );
    },
  );

  it('result is always a finite Decimal', { timeout: 30000 }, () => {
    fc.assert(
      fc.property(
        grossEdgeArb,
        priceArb,
        priceArb,
        feeArb,
        feeArb,
        gasArb,
        positionSizeArb,
        (grossEdge, buyPrice, sellPrice, buyFee, sellFee, gas, posSize) => {
          const result = FinancialMath.calculateNetEdge(
            grossEdge,
            buyPrice,
            sellPrice,
            makeFeeSchedule(buyFee),
            makeFeeSchedule(sellFee),
            gas,
            posSize,
          );
          expect(result.isFinite()).toBe(true);
          expect(result.isNaN()).toBe(false);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it(
    'monotonicity: higher fees produce lower or equal netEdge',
    { timeout: 30000 },
    () => {
      fc.assert(
        fc.property(
          grossEdgeArb,
          priceArb,
          priceArb,
          feeArb,
          feeArb,
          feeArb,
          gasArb,
          positionSizeArb,
          (
            grossEdge,
            buyPrice,
            sellPrice,
            feeA,
            feeB,
            sellFee,
            gas,
            posSize,
          ) => {
            const lowFee = Math.min(feeA, feeB);
            const highFee = Math.max(feeA, feeB);
            const netLow = FinancialMath.calculateNetEdge(
              grossEdge,
              buyPrice,
              sellPrice,
              makeFeeSchedule(lowFee),
              makeFeeSchedule(sellFee),
              gas,
              posSize,
            );
            const netHigh = FinancialMath.calculateNetEdge(
              grossEdge,
              buyPrice,
              sellPrice,
              makeFeeSchedule(highFee),
              makeFeeSchedule(sellFee),
              gas,
              posSize,
            );
            expect(netLow.gte(netHigh)).toBe(true);
          },
        ),
        { numRuns: 1000 },
      );
    },
  );

  it(
    'monotonicity: higher gas produces lower or equal netEdge',
    { timeout: 30000 },
    () => {
      fc.assert(
        fc.property(
          grossEdgeArb,
          priceArb,
          priceArb,
          feeArb,
          feeArb,
          gasArb,
          gasArb,
          positionSizeArb,
          (
            grossEdge,
            buyPrice,
            sellPrice,
            buyFee,
            sellFee,
            gasA,
            gasB,
            posSize,
          ) => {
            const lowGas = gasA.lte(gasB) ? gasA : gasB;
            const highGas = gasA.gt(gasB) ? gasA : gasB;
            const netLow = FinancialMath.calculateNetEdge(
              grossEdge,
              buyPrice,
              sellPrice,
              makeFeeSchedule(buyFee),
              makeFeeSchedule(sellFee),
              lowGas,
              posSize,
            );
            const netHigh = FinancialMath.calculateNetEdge(
              grossEdge,
              buyPrice,
              sellPrice,
              makeFeeSchedule(buyFee),
              makeFeeSchedule(sellFee),
              highGas,
              posSize,
            );
            expect(netLow.gte(netHigh)).toBe(true);
          },
        ),
        { numRuns: 1000 },
      );
    },
  );
});

// ── Task 4: Composition chain end-to-end properties ──

describe('Composition chain end-to-end property tests', () => {
  it(
    'if grossEdge is computed, netEdge <= grossEdge',
    { timeout: 30000 },
    () => {
      fc.assert(
        fc.property(
          priceArb,
          priceArb,
          feeArb,
          feeArb,
          gasArb,
          positionSizeArb,
          (buyPrice, sellPrice, buyFee, sellFee, gas, posSize) => {
            const grossEdge = FinancialMath.calculateGrossEdge(
              buyPrice,
              sellPrice,
            );
            const netEdge = FinancialMath.calculateNetEdge(
              grossEdge,
              buyPrice,
              sellPrice,
              makeFeeSchedule(buyFee),
              makeFeeSchedule(sellFee),
              gas,
              posSize,
            );
            expect(netEdge.lte(grossEdge)).toBe(true);
          },
        ),
        { numRuns: 1000 },
      );
    },
  );

  it(
    'position sizing invariants: oracle formula produces finite, non-negative, bankroll-bounded results',
    { timeout: 30000 },
    () => {
      fc.assert(
        fc.property(
          positionSizeArb,
          bankrollArb,
          maxPositionPctArb,
          (recommendedSize, bankroll, maxPositionPct) => {
            // Oracle: inline the reserveBudget position sizing formula
            // from RiskManagerService.reserveBudget (risk-manager.service.ts:593-601)
            const maxPositionSizeUsd = bankroll.mul(
              new FinancialDecimal(maxPositionPct),
            );
            const reserveAmount = recommendedSize.lte(maxPositionSizeUsd)
              ? new FinancialDecimal(recommendedSize)
              : maxPositionSizeUsd;

            // Invariant 1: result is finite and not NaN
            expect(reserveAmount.isFinite()).toBe(true);
            expect(reserveAmount.isNaN()).toBe(false);
            // Invariant 2: no negative position sizes
            expect(reserveAmount.gte(new FinancialDecimal(0))).toBe(true);
            // Invariant 3: reserved capital never exceeds bankroll
            expect(reserveAmount.lte(bankroll)).toBe(true);
            // Invariant 4: reserve never exceeds the cap
            expect(reserveAmount.lte(maxPositionSizeUsd)).toBe(true);
            // Invariant 5: reserve never exceeds the recommended size
            expect(reserveAmount.lte(recommendedSize)).toBe(true);
          },
        ),
        { numRuns: 1000 },
      );
    },
  );

  it(
    'reserveBudget service matches oracle formula',
    { timeout: 60000 },
    async () => {
      // Generate deterministic sample inputs (not 1000 — DI is expensive)
      const samples = fc.sample(
        fc.tuple(positionSizeArb, bankrollArb, maxPositionPctArb),
        50,
      );

      for (const [recommendedSize, bankroll, maxPositionPct] of samples) {
        const bankrollNum = bankroll.toNumber();
        const maxPosPct = maxPositionPct;

        const mockPrisma = {
          riskState: {
            findFirst: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({}),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          riskOverrideLog: { create: vi.fn().mockResolvedValue({}) },
        };
        const mockConfig = {
          get: vi.fn((key: string, defaultValue?: number) => {
            const cfg: Record<string, number> = {
              RISK_BANKROLL_USD: bankrollNum,
              RISK_MAX_POSITION_PCT: maxPosPct,
              RISK_MAX_OPEN_PAIRS: 100,
              RISK_DAILY_LOSS_PCT: 1,
            };
            return cfg[key] ?? defaultValue;
          }),
        };

        const module = await Test.createTestingModule({
          providers: [
            RiskManagerService,
            { provide: ConfigService, useValue: mockConfig },
            { provide: EventEmitter2, useValue: { emit: vi.fn() } },
            { provide: PrismaService, useValue: mockPrisma },
          ],
        }).compile();

        const service = module.get<RiskManagerService>(RiskManagerService);
        await service.onModuleInit();

        const reservation = await service.reserveBudget({
          opportunityId: 'test-opp',
          recommendedPositionSizeUsd: recommendedSize,
          pairId: 'test-pair',
        });

        // Oracle
        const maxPositionSizeUsd = bankroll.mul(
          new FinancialDecimal(maxPositionPct),
        );
        const expected = recommendedSize.lte(maxPositionSizeUsd)
          ? new FinancialDecimal(recommendedSize)
          : maxPositionSizeUsd;

        expect(reservation.reservedCapitalUsd.toFixed(18)).toBe(
          expected.toFixed(18),
        );
      }
    },
  );
});
