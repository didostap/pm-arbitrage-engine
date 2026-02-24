import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { ComplianceConfigLoaderService } from './compliance-config-loader.service';
import { ConfigValidationError } from '../../../common/errors/config-validation-error';

vi.mock('fs');
vi.mock('js-yaml');

const validConfig = {
  compliance: {
    defaultAction: 'allow',
    rules: [
      {
        platform: 'KALSHI',
        blockedCategories: ['adult-content', 'assassination', 'terrorism'],
        notes: 'Kalshi CFTC-regulated',
      },
      {
        platform: 'POLYMARKET',
        blockedCategories: ['adult-content', 'assassination', 'terrorism'],
        notes: 'Polymarket ToS',
      },
    ],
    jurisdiction: {
      entity: 'US',
      kalshiRequirement: 'US entity/residency required',
    },
  },
};

function setupMocks(
  config: Record<string, unknown> | null = validConfig,
  fileExists = true,
  envPath?: string,
) {
  vi.mocked(fs.existsSync).mockReturnValue(fileExists);
  vi.mocked(fs.readFileSync).mockReturnValue('yaml-content');
  vi.mocked(yaml.load).mockReturnValue(config);

  return {
    get: vi.fn().mockImplementation((key: string, defaultValue?: string) => {
      if (key === 'COMPLIANCE_MATRIX_CONFIG_PATH') {
        return envPath ?? defaultValue;
      }
      return defaultValue;
    }),
  };
}

describe('ComplianceConfigLoaderService', () => {
  let service: ComplianceConfigLoaderService;
  let configServiceMock: { get: ReturnType<typeof vi.fn> };

  async function createService(
    mockConfig: Record<string, unknown> | null = validConfig,
    fileExists = true,
    envPath?: string,
  ): Promise<ComplianceConfigLoaderService> {
    configServiceMock = setupMocks(mockConfig, fileExists, envPath);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ComplianceConfigLoaderService,
        { provide: ConfigService, useValue: configServiceMock },
      ],
    }).compile();

    service = module.get(ComplianceConfigLoaderService);
    return service;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should load valid YAML config and expose rules', async () => {
    await createService();
    service.onModuleInit();

    const config = service.getConfig();
    expect(config.defaultAction).toBe('allow');
    expect(config.rules).toHaveLength(2);
    expect(config.rules[0].platform).toBe('KALSHI');
    expect(config.rules[0].blockedCategories).toEqual([
      'adult-content',
      'assassination',
      'terrorism',
    ]);
    expect(config.jurisdiction?.entity).toBe('US');
  });

  it('should throw ConfigValidationError for missing file', async () => {
    await createService(validConfig, false);

    expect(() => service.onModuleInit()).toThrow(ConfigValidationError);
  });

  it('should throw ConfigValidationError for empty rules array', async () => {
    const badConfig = {
      compliance: {
        defaultAction: 'allow',
        rules: [],
      },
    };
    await createService(badConfig as unknown as Record<string, unknown>);

    expect(() => service.onModuleInit()).toThrow(ConfigValidationError);
  });

  it('should throw ConfigValidationError for duplicate platform entries', async () => {
    const badConfig = {
      compliance: {
        defaultAction: 'allow',
        rules: [
          { platform: 'KALSHI', blockedCategories: ['adult-content'] },
          { platform: 'KALSHI', blockedCategories: ['terrorism'] },
        ],
      },
    };
    await createService(badConfig as unknown as Record<string, unknown>);

    expect(() => service.onModuleInit()).toThrow(ConfigValidationError);
  });

  it('should throw ConfigValidationError for empty blockedCategories', async () => {
    const badConfig = {
      compliance: {
        defaultAction: 'allow',
        rules: [{ platform: 'KALSHI', blockedCategories: [] }],
      },
    };
    await createService(badConfig as unknown as Record<string, unknown>);

    expect(() => service.onModuleInit()).toThrow(ConfigValidationError);
  });

  it('should throw ConfigValidationError for whitespace-only category strings', async () => {
    const badConfig = {
      compliance: {
        defaultAction: 'allow',
        rules: [{ platform: 'KALSHI', blockedCategories: ['  '] }],
      },
    };
    await createService(badConfig as unknown as Record<string, unknown>);

    expect(() => service.onModuleInit()).toThrow(ConfigValidationError);
  });

  it('should return true for blocked category (case-insensitive)', async () => {
    await createService();
    service.onModuleInit();

    expect(
      service.isBlocked('KALSHI', 'Will there be an ASSASSINATION attempt?'),
    ).toBe(true);
  });

  it('should return false for non-blocked category', async () => {
    await createService();
    service.onModuleInit();

    expect(
      service.isBlocked('KALSHI', 'Will BTC hit $100k by June 2026?'),
    ).toBe(false);
  });

  it('should use default config path when env var not set', async () => {
    await createService();
    service.onModuleInit();

    expect(configServiceMock.get).toHaveBeenCalledWith(
      'COMPLIANCE_MATRIX_CONFIG_PATH',
      'config/compliance-matrix.yaml',
    );
  });

  it('should use custom config path from env var', async () => {
    await createService(validConfig, true, 'custom/path.yaml');
    service.onModuleInit();

    expect(configServiceMock.get).toHaveBeenCalledWith(
      'COMPLIANCE_MATRIX_CONFIG_PATH',
      'config/compliance-matrix.yaml',
    );
  });
});
