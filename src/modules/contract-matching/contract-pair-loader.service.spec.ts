import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as yaml from 'js-yaml';
import { ContractPairLoaderService } from './contract-pair-loader.service';
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
      kalshiContractId: 'kalshi-1',
      eventDescription: 'Will event A happen?',
      operatorVerificationTimestamp: '2026-02-15T10:30:00Z',
      primaryLeg: 'kalshi',
    },
    {
      polymarketContractId: 'poly-2',
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

async function createService(
  configOverrides: Record<string, string> = {},
): Promise<ContractPairLoaderService> {
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

      const pairs = service.getActivePairs();
      expect(pairs).toHaveLength(2);
      expect(pairs[0]!.polymarketContractId).toBe('poly-1');
      expect(pairs[0]!.kalshiContractId).toBe('kalshi-1');
      expect(pairs[0]!.eventDescription).toBe('Will event A happen?');
      expect(pairs[0]!.operatorVerificationTimestamp).toBeInstanceOf(Date);
      expect(pairs[0]!.primaryLeg).toBe('kalshi');
      expect(pairs[1]!.primaryLeg).toBe('polymarket');
    });

    it('should return a shallow copy from getActivePairs()', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      const pairs1 = service.getActivePairs();
      const pairs2 = service.getActivePairs();
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
            kalshiContractId: 'kalshi-1',
            eventDescription: 'Event A',
            operatorVerificationTimestamp: '2026-02-15T10:30:00Z',
          },
          {
            polymarketContractId: 'poly-dup',
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
            kalshiContractId: 'kalshi-dup',
            eventDescription: 'Event A',
            operatorVerificationTimestamp: '2026-02-15T10:30:00Z',
          },
          {
            polymarketContractId: 'poly-2',
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
        kalshiContractId: `kalshi-${i}`,
        eventDescription: `Event ${i} description`,
        operatorVerificationTimestamp: '2026-02-15T10:30:00Z',
      }));
      mockFsWithContent({ pairs });
      const service = await createService();

      const warnSpy = vi.spyOn(service['logger'], 'warn');

      await service.onModuleInit();

      const activePairs = service.getActivePairs();
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

      const pair = service.findPairByContractId('poly-1');
      expect(pair).toBeDefined();
      expect(pair!.kalshiContractId).toBe('kalshi-1');
    });

    it('should return correct pair by kalshi ID', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      const pair = service.findPairByContractId('kalshi-2');
      expect(pair).toBeDefined();
      expect(pair!.polymarketContractId).toBe('poly-2');
    });

    it('should return undefined for non-existent contract ID', async () => {
      mockFsWithContent(VALID_YAML_CONTENT);
      const service = await createService();
      await service.onModuleInit();

      const pair = service.findPairByContractId('non-existent');
      expect(pair).toBeUndefined();
    });
  });

  describe('primaryLeg defaulting', () => {
    it('should default primaryLeg to kalshi when omitted', async () => {
      mockFsWithContent({
        pairs: [
          {
            polymarketContractId: 'poly-1',
            kalshiContractId: 'kalshi-1',
            eventDescription: 'Event without primaryLeg',
            operatorVerificationTimestamp: '2026-02-15T10:30:00Z',
            // primaryLeg intentionally omitted
          },
        ],
      });
      const service = await createService();
      await service.onModuleInit();

      const pairs = service.getActivePairs();
      expect(pairs[0]!.primaryLeg).toBe('kalshi');
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
});
