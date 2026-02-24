import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ConfigValidationError } from '../../../common/errors/config-validation-error';
import type { ComplianceMatrixConfig } from './compliance-config';

@Injectable()
export class ComplianceConfigLoaderService implements OnModuleInit {
  private readonly logger = new Logger(ComplianceConfigLoaderService.name);
  private config!: ComplianceMatrixConfig;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const configPath = this.resolveConfigPath();
    const rawContent = this.readConfigFile(configPath);
    const parsed = this.parseYaml(rawContent, configPath);
    this.config = this.validateConfig(parsed);
    this.logger.log(
      `Compliance matrix loaded: ${this.config.rules.length} platform rules from ${configPath}`,
    );
    if (this.config.jurisdiction) {
      this.logger.log(`Jurisdiction: ${this.config.jurisdiction.entity}`);
    }
  }

  getConfig(): ComplianceMatrixConfig {
    return this.config;
  }

  isBlocked(platform: string, eventDescription: string): boolean {
    const rule = this.config.rules.find((r) => r.platform === platform);
    if (!rule) {
      return this.config.defaultAction === 'deny';
    }
    const descLower = eventDescription.toLowerCase();
    return rule.blockedCategories.some((cat) =>
      descLower.includes(cat.toLowerCase()),
    );
  }

  private resolveConfigPath(): string {
    const configPath = this.configService.get<string>(
      'COMPLIANCE_MATRIX_CONFIG_PATH',
      'config/compliance-matrix.yaml',
    );
    return path.resolve(process.cwd(), configPath);
  }

  private readConfigFile(configPath: string): string {
    if (!fs.existsSync(configPath)) {
      throw new ConfigValidationError(
        `Compliance matrix config file not found: ${configPath}`,
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

  private validateConfig(
    parsed: Record<string, unknown>,
  ): ComplianceMatrixConfig {
    const compliance = parsed['compliance'] as
      | Record<string, unknown>
      | undefined;
    if (!compliance) {
      throw new ConfigValidationError(
        'Compliance matrix config must contain a "compliance" key',
        ['Missing "compliance" key'],
      );
    }

    const defaultAction = compliance['defaultAction'];
    if (defaultAction !== 'allow' && defaultAction !== 'deny') {
      throw new ConfigValidationError(
        'Compliance matrix config: defaultAction must be "allow" or "deny"',
        [`Invalid defaultAction: ${String(defaultAction)}`],
      );
    }

    const rules = compliance['rules'];
    if (!Array.isArray(rules) || rules.length === 0) {
      throw new ConfigValidationError(
        'Compliance matrix config must contain at least one rule',
        ['Rules array is empty or missing'],
      );
    }

    const errors: string[] = [];
    const seenPlatforms = new Set<string>();

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i] as Record<string, unknown>;
      const platform = rule['platform'] as string;

      if (seenPlatforms.has(platform)) {
        errors.push(`Rule[${i}]: duplicate platform "${platform}"`);
      }
      seenPlatforms.add(platform);

      const blocked = rule['blockedCategories'];
      if (!Array.isArray(blocked) || blocked.length === 0) {
        errors.push(`Rule[${i}]: blockedCategories must be a non-empty array`);
      } else {
        for (let j = 0; j < blocked.length; j++) {
          const cat = blocked[j] as unknown;
          if (typeof cat !== 'string' || cat.trim() === '') {
            errors.push(
              `Rule[${i}].blockedCategories[${j}]: must be a non-empty string`,
            );
          }
        }
      }
    }

    if (errors.length > 0) {
      throw new ConfigValidationError(
        `Compliance matrix config validation failed with ${errors.length} error(s)`,
        errors,
      );
    }

    return {
      defaultAction: defaultAction,
      rules: rules.map((r: Record<string, unknown>) => ({
        platform: r['platform'] as 'KALSHI' | 'POLYMARKET',
        blockedCategories: r['blockedCategories'] as string[],
        notes: r['notes'] as string | undefined,
      })),
      jurisdiction: compliance[
        'jurisdiction'
      ] as ComplianceMatrixConfig['jurisdiction'],
    };
  }
}
