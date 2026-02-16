import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';

import { ConfigValidationError } from '../../common/errors/index.js';
import {
  ContractPairDto,
  ContractPairsConfigDto,
  PrimaryLeg,
} from './dto/contract-pair.dto.js';
import { ContractPairConfig } from './types/index.js';

@Injectable()
export class ContractPairLoaderService implements OnModuleInit {
  private readonly logger = new Logger(ContractPairLoaderService.name);
  private activePairs: ContractPairConfig[] = [];

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const configPath = this.resolveConfigPath();
    const rawContent = this.readConfigFile(configPath);
    const parsed = this.parseYaml(rawContent, configPath);
    const pairs = await this.validatePairs(parsed);
    this.activePairs = pairs.map((dto) => this.toPairConfig(dto));
    this.logger.log(
      `Contract pairs loaded: ${this.activePairs.length} pairs from ${configPath}`,
    );
  }

  getActivePairs(): ContractPairConfig[] {
    return [...this.activePairs];
  }

  findPairByContractId(contractId: string): ContractPairConfig | undefined {
    return this.activePairs.find(
      (pair) =>
        pair.polymarketContractId === contractId ||
        pair.kalshiContractId === contractId,
    );
  }

  private resolveConfigPath(): string {
    const configPath = this.configService.get<string>(
      'CONTRACT_PAIRS_CONFIG_PATH',
      'config/contract-pairs.yaml',
    );
    return path.resolve(process.cwd(), configPath);
  }

  private readConfigFile(configPath: string): string {
    if (!fs.existsSync(configPath)) {
      throw new ConfigValidationError(
        `Contract pairs config file not found: ${configPath}`,
        [`File not found: ${configPath}`],
      );
    }
    return fs.readFileSync(configPath, 'utf-8');
  }

  private parseYaml(
    content: string,
    configPath: string,
  ): Record<string, unknown> {
    try {
      const result = yaml.load(content);
      if (result == null || typeof result !== 'object') {
        throw new ConfigValidationError(
          `Failed to parse YAML config at ${configPath}: file is empty or does not contain a valid object`,
          ['YAML content is empty or not an object'],
        );
      }
      return result as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        throw error;
      }
      const message =
        error instanceof Error ? error.message : 'Unknown YAML parse error';
      throw new ConfigValidationError(
        `Failed to parse YAML config at ${configPath}: ${message}`,
        [message],
      );
    }
  }

  private async validatePairs(
    parsed: Record<string, unknown>,
  ): Promise<ContractPairDto[]> {
    const configDto = plainToInstance(ContractPairsConfigDto, parsed);
    const allErrors: string[] = [];

    // Check for empty pairs before class-validator runs
    if (
      !configDto.pairs ||
      !Array.isArray(configDto.pairs) ||
      configDto.pairs.length === 0
    ) {
      throw new ConfigValidationError(
        'Contract pairs config must contain at least one pair',
        ['Contract pairs config must contain at least one pair'],
      );
    }

    // Class-validator validation on each pair
    for (let i = 0; i < configDto.pairs.length; i++) {
      const pairDto = plainToInstance(ContractPairDto, configDto.pairs[i]);
      configDto.pairs[i] = pairDto;
      const errors = await validate(pairDto);
      for (const error of errors) {
        const constraints = error.constraints
          ? Object.values(error.constraints).join(', ')
          : 'unknown validation error';
        allErrors.push(`Pair[${i}].${error.property}: ${constraints}`);
      }
    }

    // Cross-pair validation (duplicates + >30 warning)
    const crossErrors = ContractPairsConfigDto.validateDuplicatesAndLimits(
      configDto.pairs,
    );
    const warnings: string[] = [];
    const realErrors: string[] = [];

    for (const err of crossErrors) {
      if (err.startsWith('Warning:')) {
        warnings.push(err);
      } else {
        realErrors.push(err);
      }
    }

    allErrors.push(...realErrors);

    if (allErrors.length > 0) {
      throw new ConfigValidationError(
        `Contract pairs config validation failed with ${allErrors.length} error(s)`,
        allErrors,
      );
    }

    // Log warnings (>30 pairs) after validation passes
    for (const warning of warnings) {
      const countMatch = warning.match(/(\d+) pairs/);
      const count = countMatch ? countMatch[1] : 'unknown';
      this.logger.warn(
        `Contract pairs count exceeds recommended maximum (${count} pairs, max 30)`,
      );
    }

    return configDto.pairs;
  }

  private toPairConfig(dto: ContractPairDto): ContractPairConfig {
    return {
      polymarketContractId: dto.polymarketContractId,
      kalshiContractId: dto.kalshiContractId,
      eventDescription: dto.eventDescription,
      operatorVerificationTimestamp: new Date(
        dto.operatorVerificationTimestamp,
      ),
      primaryLeg: dto.primaryLeg ?? PrimaryLeg.KALSHI,
    };
  }
}
