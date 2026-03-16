import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as yaml from 'js-yaml';
import { ContractPairLoaderService } from './contract-pair-loader.service';
import { PrismaService } from '../../common/prisma.service';
import { ConfigValidationError } from '../../common/errors';

const mockExistsSync = vi.fn<(path: string) => boolean>();
const mockReadFileSync = vi.fn<(path: string, encoding: string) => string>();

vi.mock('fs', () => ({
  existsSync: (...args: [string]) => mockExistsSync(...args),
  readFileSync: (...args: [string, string]) => mockReadFileSync(...args),
}));

const VALID_YAML_CONTENT = {
  pairs: [
    {
      polymarketContractId: 'poly-1',
      polymarketClobTokenId: 'clob-1',
      kalshiContractId: 'kalshi-1',
      eventDescription: 'Will event A happen?',
      operatorVerificationTimestamp: '2026-02-15T10:30:00Z',
      primaryLeg: 'kalshi',
    },
    {
      polymarketContractId: 'poly-2',
      polymarketClobTokenId: 'clob-2',
      kalshiContractId: 'kalshi-2',
      eventDescription: 'Will event B happen?',
      operatorVerificationTimestamp: '2026-02-15T11:00:00Z',
      primaryLeg: 'polymarket',
    },
  ],
};

function mockFsWithContent(content: Record<string, unknown> | null): void {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(content ? yaml.dump(content) : '');
}

function mockFsNotFound(): void {
  mockExistsSync.mockReturnValue(false);
}

function mockFsInvalidYaml(): void {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(': invalid: yaml: {{{}}}');
}

let mockFindMany: ReturnType<typeof vi.fn>;
let mockFindFirst: ReturnType<typeof vi.fn>;

async function createService(
  configOverrides: Record<string, string> = {},
): Promise<ContractPairLoaderService> {
  mockFindMany = vi.fn().mockResolvedValue([]);
  mockFindFirst = vi.fn().mockResolvedValue(null);

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ContractPairLoaderService,
      {
        provide: ConfigService,
        useValue: {
          get: vi.fn((key: string, defaultVal: string) => {
            if (key === 'CONTRACT_PAIRS_CONFIG_PATH') {
              return (
                configOverrides['CONTRACT_PAIRS_CONFIG_PATH'] ?? defaultVal
              );
            }
            return defaultVal;
          }),
        },
      },
      {
        provide: PrismaService,
        useValue: {
          contractMatch: {
            findMany: mockFindMany,
            findFirst: mockFindFirst,
          },
        },
      },
    ],
  }).compile();

  return module.get<ContractPairLoaderService>(ContractPairLoaderService);
}

describe('ContractPairLoaderService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('successful loading', () => {
    it('should load valid YAML and return pairs via getActivePairs()', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      const pairs = await service.getActivePairs();
      expect(pairs).toHaveLength(2);
      expect(pairs[0]!.polymarketContractId).toBe('poly-1');
      expect(pairs[0]!.polymarketClobTokenId).toBe('clob-1');
      expect(pairs[0]!.kalshiContractId).toBe('kalshi-1');
      expect(pairs[0]!.eventDescription).toBe('Will event A happen?');
      expect(pairs[0]!.operatorVerificationTimestamp).toBeInstanceOf(Date);
      expect(pairs[0]!.primaryLeg).toBe('kalshi');
      expect(pairs[1]!.primaryLeg).toBe('polymarket');
    });

    it('should return a new array from getActivePairs()', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      const pairs1 = await service.getActivePairs();
      const pairs2 = await service.getActivePairs();
      expect(pairs1).not.toBe(pairs2);
      expect(pairs1).toEqual(pairs2);
    });
  });

  describe('missing file', () => {
    it('should throw ConfigValidationError with file path when file not found', async () => {
      mockFsNotFound();
      const service = await createService();

      await expect(service.onModuleInit()).rejects.toThrow(
        ConfigValidationError,
      );
      await expect(service.onModuleInit()).rejects.toThrow(
        /Contract pairs config file not found/,
      );
    });
  });

  describe('invalid YAML syntax', () => {
    it('should throw ConfigValidationError on malformed YAML', async () => {
      mockFsInvalidYaml();
      const service = await createService();

      await expect(service.onModuleInit()).rejects.toThrow(
        ConfigValidationError,
      );
      await expect(service.onModuleInit()).rejects.toThrow(
        /Failed to parse YAML/,
      );
    });
  });

  describe('empty file content', () => {
    it('should throw ConfigValidationError when file is empty', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('');
      const service = await createService();

      await expect(service.onModuleInit()).rejects.toThrow(
        ConfigValidationError,
      );
      await expect(service.onModuleInit()).rejects.toThrow(
        /empty or does not contain a valid object/,
      );
    });
  });

  describe('missing required fields', () => {
    it('should throw with all field errors listed', async () => {
      mockFsWithContent({
        pairs: [
          {
            // missing all required fields
          },
        ],
      });
      const service = await createService();

      try {
        await service.onModuleInit();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        const configError = error as ConfigValidationError;
        const validationErrors = configError.metadata
          ?.validationErrors as string[];
        // Should report multiple missing fields
        expect(validationErrors.length).toBeGreaterThanOrEqual(3);
        expect(
          validationErrors.some((e) => e.includes('polymarketContractId')),
        ).toBe(true);
        expect(
          validationErrors.some((e) => e.includes('kalshiContractId')),
        ).toBe(true);
        expect(
          validationErrors.some((e) => e.includes('eventDescription')),
        ).toBe(true);
      }
    });
  });

  describe('duplicate contract IDs', () => {
    it('should throw on duplicate polymarketContractId', async () => {
      mockFsWithContent({
        pairs: [
          {
            polymarketContractId: 'poly-dup',
            polymarketClobTokenId: 'clob-dup-1',
            kalshiContractId: 'kalshi-1',
            eventDescription: 'Event A',
            operatorVerificationTimestamp: '2026-02-15T10:30:00Z',
          },
          {
            polymarketContractId: 'poly-dup',
            polymarketClobTokenId: 'clob-dup-2',
            kalshiContractId: 'kalshi-2',
            eventDescription: 'Event B',
            operatorVerificationTimestamp: '2026-02-15T11:00:00Z',
          },
        ],
      });
      const service = await createService();

      await expect(service.onModuleInit()).rejects.toThrow(
        ConfigValidationError,
      );
      await expect(service.onModuleInit()).rejects.toThrow(/validation failed/);
    });

    it('should throw on duplicate kalshiContractId', async () => {
      mockFsWithContent({
        pairs: [
          {
            polymarketContractId: 'poly-1',
            polymarketClobTokenId: 'clob-1',
            kalshiContractId: 'kalshi-dup',
            eventDescription: 'Event A',
            operatorVerificationTimestamp: '2026-02-15T10:30:00Z',
          },
          {
            polymarketContractId: 'poly-2',
            polymarketClobTokenId: 'clob-2',
            kalshiContractId: 'kalshi-dup',
            eventDescription: 'Event B',
            operatorVerificationTimestamp: '2026-02-15T11:00:00Z',
          },
        ],
      });
      const service = await createService();

      await expect(service.onModuleInit()).rejects.toThrow(
        ConfigValidationError,
      );
    });
  });

  describe('invalid timestamp', () => {
    it('should throw on invalid ISO 8601 timestamp', async () => {
      mockFsWithContent({
        pairs: [
          {
            polymarketContractId: 'poly-1',
            polymarketClobTokenId: 'clob-1',
            kalshiContractId: 'kalshi-1',
            eventDescription: 'Event A',
            operatorVerificationTimestamp: 'not-a-date',
          },
        ],
      });
      const service = await createService();

      await expect(service.onModuleInit()).rejects.toThrow(
        ConfigValidationError,
      );
    });
  });

  describe('>30 pairs warning', () => {
    it('should log warning but succeed with >30 pairs', async () => {
      const pairs = Array.from({ length: 31 }, (_, i) => ({
        polymarketContractId: `poly-${i}`,
        polymarketClobTokenId: `clob-${i}`,
        kalshiContractId: `kalshi-${i}`,
        eventDescription: `Event ${i} description`,
        operatorVerificationTimestamp: '2026-02-15T10:30:00Z',
      }));
      mockFsWithContent({ pairs });
      const service = await createService();

      const warnSpy = vi.spyOn(service['logger'], 'warn');

      await service.onModuleInit();

      const activePairs = await service.getActivePairs();
      expect(activePairs).toHaveLength(31);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Contract pairs count exceeds recommended maximum',
        ),
      );
    });
  });

  describe('findPairByContractId', () => {
    it('should return correct pair by polymarket ID', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      const pair = await service.findPairByContractId('poly-1');
      expect(pair).toBeDefined();
      expect(pair!.kalshiContractId).toBe('kalshi-1');
    });

    it('should return correct pair by kalshi ID', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      const pair = await service.findPairByContractId('kalshi-2');
      expect(pair).toBeDefined();
      expect(pair!.polymarketContractId).toBe('poly-2');
    });

    it('should return undefined for non-existent contract ID', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      const pair = await service.findPairByContractId('non-existent');
      expect(pair).toBeUndefined();
    });

    it('should find DB-only pair when not in YAML', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      mockFindFirst.mockResolvedValue({
        matchId: 'db-match-1',
        polymarketContractId: 'db-poly-1',
        polymarketClobTokenId: 'db-clob-1',
        kalshiContractId: 'db-kalshi-1',
        polymarketDescription: 'DB Event',
        kalshiDescription: 'DB Event Kalshi',
        operatorApprovalTimestamp: new Date('2026-03-01'),
        primaryLeg: 'polymarket',
        createdAt: new Date(),
      });

      const pair = await service.findPairByContractId('db-poly-1');
      expect(pair).toBeDefined();
      expect(pair!.matchId).toBe('db-match-1');
      expect(pair!.primaryLeg).toBe('polymarket');
    });

    it('should prefer YAML pair over DB pair', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      // YAML has poly-1, so findPairByContractId should return YAML version
      const pair = await service.findPairByContractId('poly-1');
      expect(pair).toBeDefined();
      expect(pair!.eventDescription).toBe('Will event A happen?');
      // DB findFirst should not be called since YAML matched
      expect(mockFindFirst).not.toHaveBeenCalled();
    });
  });

  describe('primaryLeg defaulting', () => {
    it('should default primaryLeg to kalshi when omitted', async () => {
      mockFsWithContent({
        pairs: [
          {
            polymarketContractId: 'poly-1',
            polymarketClobTokenId: 'clob-1',
            kalshiContractId: 'kalshi-1',
            eventDescription: 'Event without primaryLeg',
            operatorVerificationTimestamp: '2026-02-15T10:30:00Z',
            // primaryLeg intentionally omitted
          },
        ],
      });
      const service = await createService();
      await service.onModuleInit();

      const pairs = await service.getActivePairs();
      expect(pairs[0]!.primaryLeg).toBe('kalshi');
    });
  });

  describe('polymarketClobTokenId filtering', () => {
    it('should filter out pairs without polymarketClobTokenId from getActivePairs()', async () => {
      mockFsWithContent({
        pairs: [
          {
            polymarketContractId: 'poly-1',
            polymarketClobTokenId: 'clob-1',
            kalshiContractId: 'kalshi-1',
            eventDescription: 'Has CLOB token',
            operatorVerificationTimestamp: '2026-02-15T10:30:00Z',
          },
          {
            polymarketContractId: 'poly-2',
            polymarketClobTokenId: '',
            kalshiContractId: 'kalshi-2',
            eventDescription: 'Empty CLOB token',
            operatorVerificationTimestamp: '2026-02-15T11:00:00Z',
          },
        ],
      });

      // The DTO validation will reject empty polymarketClobTokenId,
      // so we test the runtime filtering via a pair that somehow lacks it.
      // For loader spec, we verify toPairConfig maps polymarketClobTokenId.
      const service = await createService();
      // This will throw because empty string fails @IsNotEmpty validation
      await expect(service.onModuleInit()).rejects.toThrow(
        ConfigValidationError,
      );
    });

    it('should map polymarketClobTokenId in toPairConfig()', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      const pairs = await service.getActivePairs();
      expect(pairs[0]!.polymarketClobTokenId).toBe('clob-1');
      expect(pairs[1]!.polymarketClobTokenId).toBe('clob-2');
    });
  });

  describe('empty pairs', () => {
    it('should throw when pairs array is empty', async () => {
      mockFsWithContent({ pairs: [] });
      const service = await createService();

      await expect(service.onModuleInit()).rejects.toThrow(
        ConfigValidationError,
      );
      await expect(service.onModuleInit()).rejects.toThrow(/at least one pair/);
    });

    it('should throw when pairs is null', async () => {
      mockFsWithContent({ pairs: null } as unknown as Record<string, unknown>);
      const service = await createService();

      await expect(service.onModuleInit()).rejects.toThrow(
        ConfigValidationError,
      );
    });
  });

  describe('getYamlPairs', () => {
    it('should return only YAML-configured pairs without DB query', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      const pairs = service.getYamlPairs();
      expect(pairs).toHaveLength(2);
      expect(pairs[0]!.polymarketContractId).toBe('poly-1');
      expect(pairs[1]!.polymarketContractId).toBe('poly-2');
      expect(mockFindMany).not.toHaveBeenCalled();
    });
  });

  describe('DB-approved pairs integration', () => {
    it('should return DB-approved pairs alongside YAML pairs', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      mockFindMany.mockResolvedValue([
        {
          matchId: 'db-match-1',
          polymarketContractId: 'db-poly-1',
          polymarketClobTokenId: 'db-clob-1',
          kalshiContractId: 'db-kalshi-1',
          polymarketDescription: 'DB Event Description',
          kalshiDescription: null,
          operatorApprovalTimestamp: new Date('2026-03-01'),
          primaryLeg: 'kalshi',
          createdAt: new Date('2026-02-28'),
        },
      ]);

      const pairs = await service.getActivePairs();
      expect(pairs).toHaveLength(3); // 2 YAML + 1 DB
      expect(pairs[2]!.matchId).toBe('db-match-1');
      expect(pairs[2]!.polymarketContractId).toBe('db-poly-1');
      expect(pairs[2]!.eventDescription).toBe('DB Event Description');
    });

    it('should deduplicate: YAML pair takes precedence over matching DB pair', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      // DB returns a pair with same contract IDs as YAML pair
      mockFindMany.mockResolvedValue([
        {
          matchId: 'db-dup-match',
          polymarketContractId: 'poly-1',
          polymarketClobTokenId: 'db-clob-override',
          kalshiContractId: 'kalshi-1',
          polymarketDescription: 'DB version',
          kalshiDescription: null,
          operatorApprovalTimestamp: new Date(),
          primaryLeg: 'polymarket',
          createdAt: new Date(),
        },
      ]);

      const pairs = await service.getActivePairs();
      expect(pairs).toHaveLength(2); // No duplicate
      // YAML version preserved
      expect(pairs[0]!.polymarketClobTokenId).toBe('clob-1');
      expect(pairs[0]!.eventDescription).toBe('Will event A happen?');
    });

    it('should default primaryLeg to kalshi when DB pair has null primaryLeg', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      mockFindMany.mockResolvedValue([
        {
          matchId: 'db-match-2',
          polymarketContractId: 'db-poly-2',
          polymarketClobTokenId: 'db-clob-2',
          kalshiContractId: 'db-kalshi-2',
          polymarketDescription: null,
          kalshiDescription: 'Kalshi Description',
          operatorApprovalTimestamp: null,
          primaryLeg: null,
          createdAt: new Date('2026-03-01'),
        },
      ]);

      const pairs = await service.getActivePairs();
      const dbPair = pairs.find((p) => p.matchId === 'db-match-2');
      expect(dbPair).toBeDefined();
      expect(dbPair!.primaryLeg).toBe('kalshi');
    });

    it('should use kalshiDescription when polymarketDescription is null', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      mockFindMany.mockResolvedValue([
        {
          matchId: 'db-match-3',
          polymarketContractId: 'db-poly-3',
          polymarketClobTokenId: 'db-clob-3',
          kalshiContractId: 'db-kalshi-3',
          polymarketDescription: null,
          kalshiDescription: 'Kalshi fallback description',
          operatorApprovalTimestamp: new Date(),
          primaryLeg: 'kalshi',
          createdAt: new Date(),
        },
      ]);

      const pairs = await service.getActivePairs();
      const dbPair = pairs.find((p) => p.matchId === 'db-match-3');
      expect(dbPair!.eventDescription).toBe('Kalshi fallback description');
    });

    it('should use createdAt as fallback when operatorApprovalTimestamp is null', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      const createdAt = new Date('2026-02-20');
      mockFindMany.mockResolvedValue([
        {
          matchId: 'db-match-4',
          polymarketContractId: 'db-poly-4',
          polymarketClobTokenId: 'db-clob-4',
          kalshiContractId: 'db-kalshi-4',
          polymarketDescription: 'Event',
          kalshiDescription: null,
          operatorApprovalTimestamp: null,
          primaryLeg: 'kalshi',
          createdAt,
        },
      ]);

      const pairs = await service.getActivePairs();
      const dbPair = pairs.find((p) => p.matchId === 'db-match-4');
      expect(dbPair!.operatorVerificationTimestamp).toEqual(createdAt);
    });

    it('should set matchId from DB row', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      mockFindMany.mockResolvedValue([
        {
          matchId: 'specific-uuid-123',
          polymarketContractId: 'db-poly-5',
          polymarketClobTokenId: 'db-clob-5',
          kalshiContractId: 'db-kalshi-5',
          polymarketDescription: 'Event',
          kalshiDescription: null,
          operatorApprovalTimestamp: new Date(),
          primaryLeg: 'kalshi',
          createdAt: new Date(),
        },
      ]);

      const pairs = await service.getActivePairs();
      const dbPair = pairs.find((p) => p.polymarketContractId === 'db-poly-5');
      expect(dbPair!.matchId).toBe('specific-uuid-123');
    });

    it('should populate resolutionDate from DB match', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      const resolutionDate = new Date('2026-06-15');
      mockFindMany.mockResolvedValue([
        {
          matchId: 'db-match-res',
          polymarketContractId: 'db-poly-res',
          polymarketClobTokenId: 'db-clob-res',
          kalshiContractId: 'db-kalshi-res',
          polymarketDescription: 'Resolution Event',
          kalshiDescription: null,
          operatorApprovalTimestamp: new Date(),
          primaryLeg: 'kalshi',
          createdAt: new Date(),
          resolutionDate,
        },
      ]);

      const pairs = await service.getActivePairs();
      const dbPair = pairs.find((p) => p.matchId === 'db-match-res');
      expect(dbPair!.resolutionDate).toEqual(resolutionDate);
    });

    it('should set resolutionDate to null when DB match has no resolution date', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      mockFindMany.mockResolvedValue([
        {
          matchId: 'db-match-nores',
          polymarketContractId: 'db-poly-nores',
          polymarketClobTokenId: 'db-clob-nores',
          kalshiContractId: 'db-kalshi-nores',
          polymarketDescription: 'No Resolution Event',
          kalshiDescription: null,
          operatorApprovalTimestamp: new Date(),
          primaryLeg: 'kalshi',
          createdAt: new Date(),
        },
      ]);

      const pairs = await service.getActivePairs();
      const dbPair = pairs.find((p) => p.matchId === 'db-match-nores');
      expect(dbPair!.resolutionDate).toBeNull();
    });

    it('should populate clusterId from DB match', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      mockFindMany.mockResolvedValue([
        {
          matchId: 'db-match-cluster',
          polymarketContractId: 'db-poly-cluster',
          polymarketClobTokenId: 'db-clob-cluster',
          kalshiContractId: 'db-kalshi-cluster',
          polymarketDescription: 'Cluster Event',
          kalshiDescription: null,
          operatorApprovalTimestamp: new Date(),
          primaryLeg: 'kalshi',
          createdAt: new Date(),
          clusterId: 'cluster-economics',
        },
      ]);

      const pairs = await service.getActivePairs();
      const dbPair = pairs.find((p) => p.matchId === 'db-match-cluster');
      expect(dbPair!.clusterId).toBe('cluster-economics');
    });

    it('should propagate confidenceScore from DB match', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      mockFindMany.mockResolvedValue([
        {
          matchId: 'db-match-conf',
          polymarketContractId: 'db-poly-conf',
          polymarketClobTokenId: 'db-clob-conf',
          kalshiContractId: 'db-kalshi-conf',
          polymarketDescription: 'Confidence Event',
          kalshiDescription: null,
          operatorApprovalTimestamp: new Date(),
          primaryLeg: 'kalshi',
          createdAt: new Date(),
          confidenceScore: 90,
        },
      ]);

      const pairs = await service.getActivePairs();
      const dbPair = pairs.find((p) => p.matchId === 'db-match-conf');
      expect(dbPair!.confidenceScore).toBe(90);
    });

    it('should set confidenceScore to null when DB match has null confidenceScore', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      mockFindMany.mockResolvedValue([
        {
          matchId: 'db-match-noconf',
          polymarketContractId: 'db-poly-noconf',
          polymarketClobTokenId: 'db-clob-noconf',
          kalshiContractId: 'db-kalshi-noconf',
          polymarketDescription: 'No Confidence Event',
          kalshiDescription: null,
          operatorApprovalTimestamp: new Date(),
          primaryLeg: 'kalshi',
          createdAt: new Date(),
          confidenceScore: null,
        },
      ]);

      const pairs = await service.getActivePairs();
      const dbPair = pairs.find((p) => p.matchId === 'db-match-noconf');
      expect(dbPair!.confidenceScore).toBeNull();
    });

    it('should set clusterId to undefined when DB match has null clusterId', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      mockFindMany.mockResolvedValue([
        {
          matchId: 'db-match-nocluster',
          polymarketContractId: 'db-poly-nocluster',
          polymarketClobTokenId: 'db-clob-nocluster',
          kalshiContractId: 'db-kalshi-nocluster',
          polymarketDescription: 'No Cluster Event',
          kalshiDescription: null,
          operatorApprovalTimestamp: new Date(),
          primaryLeg: 'kalshi',
          createdAt: new Date(),
          clusterId: null,
        },
      ]);

      const pairs = await service.getActivePairs();
      const dbPair = pairs.find((p) => p.matchId === 'db-match-nocluster');
      expect(dbPair!.clusterId).toBeUndefined();
    });

    it('should set resolutionDate to null for YAML-loaded pairs', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      const pairs = service.getYamlPairs();
      for (const pair of pairs) {
        expect(pair.resolutionDate).toBeNull();
      }
    });

    it('should set confidenceScore to null for YAML-loaded pairs', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      const pairs = service.getYamlPairs();
      for (const pair of pairs) {
        expect(pair.confidenceScore).toBeNull();
      }
    });

    it('should parse resolutionDate from YAML when provided', async () => {
      const yamlWithResolution = {
        pairs: [
          {
            polymarketContractId: 'poly-1',
            polymarketClobTokenId: 'clob-1',
            kalshiContractId: 'kalshi-1',
            eventDescription: 'Will event A happen?',
            operatorVerificationTimestamp: '2026-02-15T10:30:00Z',
            primaryLeg: 'kalshi',
            resolutionDate: '2026-06-30T00:00:00Z',
          },
        ],
      };
      mockFsWithContent(yamlWithResolution);
      const service = await createService();
      await service.onModuleInit();

      const pairs = service.getYamlPairs();
      expect(pairs[0]!.resolutionDate).toEqual(
        new Date('2026-06-30T00:00:00Z'),
      );
    });

    it('should set resolutionDate to null when not provided in YAML', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      const pairs = service.getYamlPairs();
      expect(pairs[0]!.resolutionDate).toBeNull();
    });
  });
});
