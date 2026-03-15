import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataDivergenceService } from './data-divergence.service';
import { PlatformId } from '../../common/types/platform.type';
import { asContractId } from '../../common/types/branded.type';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { DataDivergenceEvent } from '../../common/events/platform.events';
import type { NormalizedOrderBook } from '../../common/types/normalized-order-book.type';

function makeBook(
  platformId: PlatformId,
  contractId: string,
  bestBid: number,
  bestAsk: number,
  timestamp: Date = new Date(),
): NormalizedOrderBook {
  return {
    platformId,
    contractId: asContractId(contractId),
    bids: bestBid > 0 ? [{ price: bestBid, quantity: 100 }] : [],
    asks: bestAsk > 0 ? [{ price: bestAsk, quantity: 100 }] : [],
    timestamp,
  };
}

describe('DataDivergenceService', () => {
  let service: DataDivergenceService;
  let mockEventEmitter: { emit: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    mockEventEmitter = { emit: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataDivergenceService,
        { provide: EventEmitter2, useValue: mockEventEmitter },
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn().mockImplementation((key: string, def: unknown) => {
              if (key === 'DIVERGENCE_PRICE_THRESHOLD') return 0.02;
              if (key === 'DIVERGENCE_STALENESS_THRESHOLD_MS') return 90000;
              return def;
            }),
          },
        },
      ],
    }).compile();

    service = module.get(DataDivergenceService);
  });

  it('should emit divergence event when price delta exceeds threshold', () => {
    const contractId = asContractId('TEST-C1');

    // Poll says bid=0.50, ask=0.55
    service.recordPollData(
      PlatformId.KALSHI,
      contractId,
      makeBook(PlatformId.KALSHI, 'TEST-C1', 0.5, 0.55),
    );
    // WS says bid=0.47, ask=0.52 — delta=0.03 > 0.02 threshold
    service.recordWsData(
      PlatformId.KALSHI,
      contractId,
      makeBook(PlatformId.KALSHI, 'TEST-C1', 0.47, 0.52),
    );

    const divergenceCalls = mockEventEmitter.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === EVENT_NAMES.DATA_DIVERGENCE,
    );
    expect(divergenceCalls).toHaveLength(1);
    expect(divergenceCalls[0]![1]).toBeInstanceOf(DataDivergenceEvent);
  });

  it('should emit divergence event when staleness delta exceeds threshold', () => {
    const contractId = asContractId('TEST-C2');
    const now = new Date();
    const stale = new Date(now.getTime() - 100000); // 100s ago

    service.recordPollData(
      PlatformId.KALSHI,
      contractId,
      makeBook(PlatformId.KALSHI, 'TEST-C2', 0.5, 0.55, now),
    );
    service.recordWsData(
      PlatformId.KALSHI,
      contractId,
      makeBook(PlatformId.KALSHI, 'TEST-C2', 0.5, 0.55, stale),
    );

    const divergenceCalls = mockEventEmitter.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === EVENT_NAMES.DATA_DIVERGENCE,
    );
    expect(divergenceCalls).toHaveLength(1);
  });

  it('should NOT emit event when below threshold', () => {
    const contractId = asContractId('TEST-C3');

    service.recordPollData(
      PlatformId.KALSHI,
      contractId,
      makeBook(PlatformId.KALSHI, 'TEST-C3', 0.5, 0.55),
    );
    service.recordWsData(
      PlatformId.KALSHI,
      contractId,
      makeBook(PlatformId.KALSHI, 'TEST-C3', 0.5, 0.55),
    );

    const divergenceCalls = mockEventEmitter.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === EVENT_NAMES.DATA_DIVERGENCE,
    );
    expect(divergenceCalls).toHaveLength(0);
  });

  it('should emit exactly once for sustained divergence (no repeated events)', () => {
    const contractId = asContractId('TEST-C4');

    service.recordPollData(
      PlatformId.KALSHI,
      contractId,
      makeBook(PlatformId.KALSHI, 'TEST-C4', 0.5, 0.55),
    );
    service.recordWsData(
      PlatformId.KALSHI,
      contractId,
      makeBook(PlatformId.KALSHI, 'TEST-C4', 0.47, 0.52),
    );
    // Update again with still-divergent data
    service.recordWsData(
      PlatformId.KALSHI,
      contractId,
      makeBook(PlatformId.KALSHI, 'TEST-C4', 0.46, 0.51),
    );

    const divergenceCalls = mockEventEmitter.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === EVENT_NAMES.DATA_DIVERGENCE,
    );
    expect(divergenceCalls).toHaveLength(1); // exactly once
  });

  it('should require BOTH deltas below threshold for recovery', () => {
    const contractId = asContractId('TEST-C5');
    const now = new Date();
    const stale = new Date(now.getTime() - 100000);

    // Diverge on staleness
    service.recordPollData(
      PlatformId.KALSHI,
      contractId,
      makeBook(PlatformId.KALSHI, 'TEST-C5', 0.5, 0.55, now),
    );
    service.recordWsData(
      PlatformId.KALSHI,
      contractId,
      makeBook(PlatformId.KALSHI, 'TEST-C5', 0.5, 0.55, stale),
    );

    expect(service.getDivergenceStatus(PlatformId.KALSHI)).toBe('divergent');

    // Fix staleness but add price divergence
    service.recordWsData(
      PlatformId.KALSHI,
      contractId,
      makeBook(PlatformId.KALSHI, 'TEST-C5', 0.47, 0.52, now),
    );

    // Still divergent (price delta > threshold)
    expect(service.getDivergenceStatus(PlatformId.KALSHI)).toBe('divergent');
  });

  it('should clear contract data on clearContractData', () => {
    const contractId = asContractId('TEST-CLEAR');

    service.recordPollData(
      PlatformId.KALSHI,
      contractId,
      makeBook(PlatformId.KALSHI, 'TEST-CLEAR', 0.5, 0.55),
    );
    service.recordWsData(
      PlatformId.KALSHI,
      contractId,
      makeBook(PlatformId.KALSHI, 'TEST-CLEAR', 0.47, 0.52),
    );

    expect(service.getDivergenceStatus(PlatformId.KALSHI)).toBe('divergent');

    service.clearContractData(PlatformId.KALSHI, contractId);

    expect(service.getDivergenceStatus(PlatformId.KALSHI)).toBe('normal');
  });

  it('should return normal when no divergence exists', () => {
    expect(service.getDivergenceStatus(PlatformId.KALSHI)).toBe('normal');
    expect(service.getDivergenceStatus(PlatformId.POLYMARKET)).toBe('normal');
  });

  it('should log recovery when divergence resolves (M7)', () => {
    const contractId = asContractId('TEST-RECOVERY-LOG');
    /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
    const logSpy = vi
      .spyOn((service as any).logger, 'log')
      .mockImplementation(() => {});

    // Create divergence
    service.recordPollData(
      PlatformId.KALSHI,
      contractId,
      makeBook(PlatformId.KALSHI, 'TEST-RECOVERY-LOG', 0.5, 0.55),
    );
    service.recordWsData(
      PlatformId.KALSHI,
      contractId,
      makeBook(PlatformId.KALSHI, 'TEST-RECOVERY-LOG', 0.47, 0.52),
    );

    expect(service.getDivergenceStatus(PlatformId.KALSHI)).toBe('divergent');

    // Resolve divergence
    service.recordWsData(
      PlatformId.KALSHI,
      contractId,
      makeBook(PlatformId.KALSHI, 'TEST-RECOVERY-LOG', 0.5, 0.55),
    );

    expect(service.getDivergenceStatus(PlatformId.KALSHI)).toBe('normal');

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Data divergence recovered',
        metadata: expect.objectContaining({
          platformId: PlatformId.KALSHI,
          contractId,
        }),
      }),
    );
    /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
    logSpy.mockRestore();
  });

  it('should track divergence independently per platform (M8)', () => {
    const kalshiContract = asContractId('KALSHI-CROSS');
    const polyContract = asContractId('POLY-CROSS');

    // Only Kalshi diverges
    service.recordPollData(
      PlatformId.KALSHI,
      kalshiContract,
      makeBook(PlatformId.KALSHI, 'KALSHI-CROSS', 0.5, 0.55),
    );
    service.recordWsData(
      PlatformId.KALSHI,
      kalshiContract,
      makeBook(PlatformId.KALSHI, 'KALSHI-CROSS', 0.47, 0.52),
    );

    // Polymarket stays normal
    service.recordPollData(
      PlatformId.POLYMARKET,
      polyContract,
      makeBook(PlatformId.POLYMARKET, 'POLY-CROSS', 0.5, 0.55),
    );
    service.recordWsData(
      PlatformId.POLYMARKET,
      polyContract,
      makeBook(PlatformId.POLYMARKET, 'POLY-CROSS', 0.5, 0.55),
    );

    expect(service.getDivergenceStatus(PlatformId.KALSHI)).toBe('divergent');
    expect(service.getDivergenceStatus(PlatformId.POLYMARKET)).toBe('normal');
  });
});
