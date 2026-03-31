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
    polymarketClobTokenId: 'mock-clob-token-1',
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
  let pairLoader: { getYamlPairs: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      contractMatch: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ matchId: 'uuid-from-upsert' }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    pairLoader = {
      getYamlPairs: vi.fn().mockReturnValue([]),
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
    pairLoader.getYamlPairs.mockReturnValue(pairs);

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
          polymarketClobTokenId: 'mock-clob-token-1',
          kalshiContractId: 'kalshi-1',
          operatorApproved: true,
        }),
        update: expect.objectContaining({
          operatorApproved: true,
          polymarketClobTokenId: 'mock-clob-token-1',
        }),
      }),
    );
  });

  it('should populate matchId on pair config after upsert', async () => {
    const pairs = [makePair()];
    pairLoader.getYamlPairs.mockReturnValue(pairs);
    prisma.contractMatch.upsert.mockResolvedValue({
      matchId: 'uuid-new-pair',
    });

    await service.syncPairsToDatabase();

    expect(pairs[0]!.matchId).toBe('uuid-new-pair');
  });

  it('should populate matchId on unchanged pairs from existing record', async () => {
    const ts = new Date('2026-02-15T10:30:00Z');
    const pairs = [makePair({ operatorVerificationTimestamp: ts })];
    pairLoader.getYamlPairs.mockReturnValue(pairs);
    prisma.contractMatch.findUnique.mockResolvedValue({
      matchId: 'uuid-existing',
      operatorApproved: true,
      polymarketDescription: 'Will event A happen?',
      kalshiDescription: 'Will event A happen?',
      operatorApprovalTimestamp: ts,
      polymarketClobTokenId: 'mock-clob-token-1',
    });

    await service.syncPairsToDatabase();

    expect(prisma.contractMatch.upsert).not.toHaveBeenCalled();
    expect(pairs[0]!.matchId).toBe('uuid-existing');
  });

  it('should upsert existing pairs (updates operator_approved and timestamps)', async () => {
    const pairs = [makePair()];
    pairLoader.getYamlPairs.mockReturnValue(pairs);
    prisma.contractMatch.findUnique.mockResolvedValue({
      matchId: 'uuid-existing',
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
    pairLoader.getYamlPairs.mockReturnValue(pairs);
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

  it('should detect and warn about untradable pairs (approved but missing polymarketClobTokenId)', async () => {
    const pairs = [makePair()];
    pairLoader.getYamlPairs.mockReturnValue(pairs);
    prisma.contractMatch.findMany.mockResolvedValue([
      {
        matchId: 'uuid-untradable',
        polymarketContractId: 'poly-old',
        kalshiContractId: 'kalshi-old',
      },
    ]);

    const warnSpy = vi.spyOn(service['logger'], 'warn');

    await service.syncPairsToDatabase();

    expect(prisma.contractMatch.findMany).toHaveBeenCalledWith({
      where: {
        operatorApproved: true,
        polymarketClobTokenId: null,
      },
      select: {
        matchId: true,
        polymarketContractId: true,
        kalshiContractId: true,
      },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Approved pairs missing polymarketClobTokenId — cannot trade until resolved',
        data: expect.objectContaining({ count: 1 }),
      }),
    );
  });

  it('should not warn when no untradable pairs exist', async () => {
    const pairs = [makePair()];
    pairLoader.getYamlPairs.mockReturnValue(pairs);
    prisma.contractMatch.findMany.mockResolvedValue([]);

    const warnSpy = vi.spyOn(service['logger'], 'warn');

    await service.syncPairsToDatabase();

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Approved pairs missing polymarketClobTokenId — cannot trade until resolved',
      }),
    );
  });

  it('should handle empty config pairs gracefully', async () => {
    pairLoader.getYamlPairs.mockReturnValue([]);

    const warnSpy = vi.spyOn(service['logger'], 'warn');

    await service.syncPairsToDatabase();

    expect(warnSpy).toHaveBeenCalledWith(
      'No active pairs loaded — skipping database sync',
    );
    expect(prisma.contractMatch.upsert).not.toHaveBeenCalled();
  });

  it('should set polymarket_description and kalshi_description from eventDescription', async () => {
    const pairs = [makePair({ eventDescription: 'Custom event' })];
    pairLoader.getYamlPairs.mockReturnValue(pairs);

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
    pairLoader.getYamlPairs.mockReturnValue(pairs);

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
    pairLoader.getYamlPairs.mockReturnValue(pairs);
    // First pair exists (updated), second is new (inserted)
    prisma.contractMatch.findUnique
      .mockResolvedValueOnce({
        matchId: 'uuid-1',
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
    pairLoader.getYamlPairs.mockReturnValue(pairs);
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
    pairLoader.getYamlPairs.mockReturnValue(pairs);

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
    pairLoader.getYamlPairs.mockReturnValue(pairs);
    prisma.contractMatch.findUnique.mockResolvedValue({
      operatorApproved: true,
      polymarketDescription: 'Will event A happen?',
      kalshiDescription: 'Will event A happen?',
      operatorApprovalTimestamp: ts,
      polymarketClobTokenId: 'mock-clob-token-1',
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
    pairLoader.getYamlPairs.mockReturnValue(pairs);

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

  describe('origin field', () => {
    it('[P0] syncPairsToDatabase() should set origin: MANUAL on upsert for YAML-sourced pairs', async () => {
      const pairs = [makePair()];
      pairLoader.getYamlPairs.mockReturnValue(pairs);

      await service.syncPairsToDatabase();

      expect(prisma.contractMatch.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ origin: 'MANUAL' }),
          update: expect.objectContaining({ origin: 'MANUAL' }),
        }),
      );
    });

    it('[P1] backfill migration SQL should update operatorApproved=true AND operatorRationale IS NULL to MANUAL', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const sql = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../prisma/migrations/20260328175246_add_contract_match_origin/migration.sql',
        ),
        'utf-8',
      );
      expect(sql).toContain('SET "origin" = \'MANUAL\'');
      expect(sql).toContain('"operator_approved" = true');
      expect(sql).toContain('"operator_rationale" IS NULL');
    });
  });

  describe('resolutionDate sync', () => {
    it('should include resolutionDate in create when pair has resolutionDate', async () => {
      const pair = makePair({
        resolutionDate: new Date('2026-06-30T00:00:00Z'),
      });
      pairLoader.getYamlPairs.mockReturnValue([pair]);

      await service.syncPairsToDatabase();

      expect(prisma.contractMatch.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            resolutionDate: new Date('2026-06-30T00:00:00Z'),
          }),
        }),
      );
    });

    it('should set resolutionDate to null in create when pair omits resolutionDate', async () => {
      const pair = makePair(); // no resolutionDate set
      pairLoader.getYamlPairs.mockReturnValue([pair]);

      await service.syncPairsToDatabase();

      expect(prisma.contractMatch.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            resolutionDate: null,
          }),
        }),
      );
    });

    it('should include resolutionDate in update when pair has resolutionDate', async () => {
      const pair = makePair({
        resolutionDate: new Date('2026-06-30T00:00:00Z'),
      });
      pairLoader.getYamlPairs.mockReturnValue([pair]);

      await service.syncPairsToDatabase();

      expect(prisma.contractMatch.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            resolutionDate: new Date('2026-06-30T00:00:00Z'),
          }),
        }),
      );
    });

    it('should NOT include resolutionDate in update when pair omits field (preserves DB value)', async () => {
      const pair = makePair(); // resolutionDate is undefined
      pairLoader.getYamlPairs.mockReturnValue([pair]);

      await service.syncPairsToDatabase();

      const upsertCall = prisma.contractMatch.upsert.mock.calls[0]![0] as {
        update: Record<string, unknown>;
      };
      expect(upsertCall.update).not.toHaveProperty('resolutionDate');
    });

    it('should set resolutionDate to null in update when pair explicitly specifies null (clears DB value)', async () => {
      const pair = makePair({ resolutionDate: null });
      pairLoader.getYamlPairs.mockReturnValue([pair]);

      await service.syncPairsToDatabase();

      expect(prisma.contractMatch.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            resolutionDate: null,
          }),
        }),
      );
    });
  });
});
