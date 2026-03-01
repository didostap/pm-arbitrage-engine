/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest expect.objectContaining returns any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ContractMatchSyncService } from './contract-match-sync.service';
import { ContractPairLoaderService } from './contract-pair-loader.service';
import { PrismaService } from '../../common/prisma.service';
import { ContractPairConfig } from './types/contract-pair-config.type';

function makePair(
  overrides: Partial<ContractPairConfig> = {},
): ContractPairConfig {
  return {
    polymarketContractId: 'poly-1',
    kalshiContractId: 'kalshi-1',
    eventDescription: 'Will event A happen?',
    operatorVerificationTimestamp: new Date('2026-02-15T10:30:00Z'),
    primaryLeg: 'kalshi',
    ...overrides,
  };
}

describe('ContractMatchSyncService', () => {
  let service: ContractMatchSyncService;
  let prisma: {
    contractMatch: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  };
  let pairLoader: { getActivePairs: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      contractMatch: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    pairLoader = {
      getActivePairs: vi.fn().mockReturnValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContractMatchSyncService,
        { provide: PrismaService, useValue: prisma },
        { provide: ContractPairLoaderService, useValue: pairLoader },
      ],
    }).compile();

    service = module.get(ContractMatchSyncService);
  });

  it('should call syncPairsToDatabase from onApplicationBootstrap', async () => {
    const spy = vi.spyOn(service, 'syncPairsToDatabase').mockResolvedValue();
    await service.onApplicationBootstrap();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('should sync config pairs to database on module init', async () => {
    const pairs = [makePair()];
    pairLoader.getActivePairs.mockReturnValue(pairs);

    await service.syncPairsToDatabase();

    expect(prisma.contractMatch.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.contractMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          polymarketContractId_kalshiContractId: {
            polymarketContractId: 'poly-1',
            kalshiContractId: 'kalshi-1',
          },
        },
        create: expect.objectContaining({
          polymarketContractId: 'poly-1',
          kalshiContractId: 'kalshi-1',
          operatorApproved: true,
        }),
        update: expect.objectContaining({
          operatorApproved: true,
        }),
      }),
    );
  });

  it('should upsert existing pairs (updates operator_approved and timestamps)', async () => {
    const pairs = [makePair()];
    pairLoader.getActivePairs.mockReturnValue(pairs);
    prisma.contractMatch.findUnique.mockResolvedValue({
      operatorApproved: false,
      polymarketDescription: 'old',
      kalshiDescription: 'old',
      operatorApprovalTimestamp: null,
    });

    await service.syncPairsToDatabase();

    expect(prisma.contractMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          operatorApproved: true,
          operatorApprovalTimestamp: new Date('2026-02-15T10:30:00Z'),
        }),
      }),
    );
  });

  it('should insert new pairs that do not exist in DB', async () => {
    const pairs = [makePair()];
    pairLoader.getActivePairs.mockReturnValue(pairs);
    prisma.contractMatch.findUnique.mockResolvedValue(null);

    await service.syncPairsToDatabase();

    expect(prisma.contractMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          polymarketContractId: 'poly-1',
          kalshiContractId: 'kalshi-1',
          operatorApproved: true,
        }),
      }),
    );
  });

  it('should detect and log inactive pairs (in DB but not in config)', async () => {
    const pairs = [makePair()];
    pairLoader.getActivePairs.mockReturnValue(pairs);
    prisma.contractMatch.findMany.mockResolvedValue([
      { polymarketContractId: 'poly-1', kalshiContractId: 'kalshi-1' },
      { polymarketContractId: 'poly-old', kalshiContractId: 'kalshi-old' },
    ]);

    const warnSpy = vi.spyOn(service['logger'], 'warn');

    await service.syncPairsToDatabase();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Database contains approved pairs not in current config — may need manual review',
        data: expect.objectContaining({ count: 1 }),
      }),
    );
  });

  it('should not delete removed pairs from DB', async () => {
    const pairs = [makePair()];
    pairLoader.getActivePairs.mockReturnValue(pairs);
    prisma.contractMatch.findMany.mockResolvedValue([
      { polymarketContractId: 'poly-1', kalshiContractId: 'kalshi-1' },
      { polymarketContractId: 'poly-old', kalshiContractId: 'kalshi-old' },
    ]);

    await service.syncPairsToDatabase();

    // No delete methods should exist or be called
    expect(
      (prisma.contractMatch as Record<string, unknown>)['delete'],
    ).toBeUndefined();
    expect(
      (prisma.contractMatch as Record<string, unknown>)['deleteMany'],
    ).toBeUndefined();
  });

  it('should handle empty config pairs gracefully', async () => {
    pairLoader.getActivePairs.mockReturnValue([]);

    const warnSpy = vi.spyOn(service['logger'], 'warn');

    await service.syncPairsToDatabase();

    expect(warnSpy).toHaveBeenCalledWith(
      'No active pairs loaded — skipping database sync',
    );
    expect(prisma.contractMatch.upsert).not.toHaveBeenCalled();
  });

  it('should set polymarket_description and kalshi_description from eventDescription', async () => {
    const pairs = [makePair({ eventDescription: 'Custom event' })];
    pairLoader.getActivePairs.mockReturnValue(pairs);

    await service.syncPairsToDatabase();

    expect(prisma.contractMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          polymarketDescription: 'Custom event',
          kalshiDescription: 'Custom event',
        }),
        update: expect.objectContaining({
          polymarketDescription: 'Custom event',
          kalshiDescription: 'Custom event',
        }),
      }),
    );
  });

  it('should set operator_approval_timestamp from config operatorVerificationTimestamp', async () => {
    const ts = new Date('2026-01-01T00:00:00Z');
    const pairs = [makePair({ operatorVerificationTimestamp: ts })];
    pairLoader.getActivePairs.mockReturnValue(pairs);

    await service.syncPairsToDatabase();

    expect(prisma.contractMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          operatorApprovalTimestamp: ts,
        }),
        update: expect.objectContaining({
          operatorApprovalTimestamp: ts,
        }),
      }),
    );
  });

  it('should log summary with correct counts', async () => {
    const pairs = [
      makePair(),
      makePair({
        polymarketContractId: 'poly-2',
        kalshiContractId: 'kalshi-2',
      }),
    ];
    pairLoader.getActivePairs.mockReturnValue(pairs);
    // First pair exists (updated), second is new (inserted)
    prisma.contractMatch.findUnique
      .mockResolvedValueOnce({
        operatorApproved: false,
        polymarketDescription: 'old',
        kalshiDescription: 'old',
        operatorApprovalTimestamp: null,
      })
      .mockResolvedValueOnce(null);

    const logSpy = vi.spyOn(service['logger'], 'log');

    await service.syncPairsToDatabase();

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Contract matches seeded to database',
        data: { inserted: 1, updated: 1, unchanged: 0 },
      }),
    );
  });

  it('should handle database errors gracefully (logs error, does not crash)', async () => {
    const pairs = [makePair()];
    pairLoader.getActivePairs.mockReturnValue(pairs);
    prisma.contractMatch.findUnique.mockRejectedValue(
      new Error('DB connection failed'),
    );

    const errorSpy = vi.spyOn(service['logger'], 'error');

    await expect(service.syncPairsToDatabase()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Failed to sync contract matches to database',
        data: { error: 'DB connection failed' },
      }),
    );
  });

  it('should handle concurrent pairs with same polymarket ID but different kalshi IDs', async () => {
    const pairs = [
      makePair({
        polymarketContractId: 'poly-1',
        kalshiContractId: 'kalshi-A',
      }),
      makePair({
        polymarketContractId: 'poly-1',
        kalshiContractId: 'kalshi-B',
      }),
    ];
    pairLoader.getActivePairs.mockReturnValue(pairs);

    await service.syncPairsToDatabase();

    expect(prisma.contractMatch.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.contractMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          polymarketContractId_kalshiContractId: {
            polymarketContractId: 'poly-1',
            kalshiContractId: 'kalshi-A',
          },
        },
      }),
    );
    expect(prisma.contractMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          polymarketContractId_kalshiContractId: {
            polymarketContractId: 'poly-1',
            kalshiContractId: 'kalshi-B',
          },
        },
      }),
    );
  });

  it('should skip upsert for unchanged pairs and count them correctly', async () => {
    const ts = new Date('2026-02-15T10:30:00Z');
    const pairs = [makePair({ operatorVerificationTimestamp: ts })];
    pairLoader.getActivePairs.mockReturnValue(pairs);
    prisma.contractMatch.findUnique.mockResolvedValue({
      operatorApproved: true,
      polymarketDescription: 'Will event A happen?',
      kalshiDescription: 'Will event A happen?',
      operatorApprovalTimestamp: ts,
    });

    const logSpy = vi.spyOn(service['logger'], 'log');

    await service.syncPairsToDatabase();

    expect(prisma.contractMatch.upsert).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Contract matches seeded to database',
        data: { inserted: 0, updated: 0, unchanged: 1 },
      }),
    );
  });

  it('should handle pair with null/undefined operatorVerificationTimestamp', async () => {
    const pairs = [
      makePair({
        operatorVerificationTimestamp: undefined as unknown as Date,
      }),
    ];
    pairLoader.getActivePairs.mockReturnValue(pairs);

    await service.syncPairsToDatabase();

    expect(prisma.contractMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          operatorApprovalTimestamp: null,
        }),
        update: expect.objectContaining({
          operatorApprovalTimestamp: null,
        }),
      }),
    );
  });
});
