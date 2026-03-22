import { Global, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { seedConfig } from '../../prisma/seed-config.js';
import { CONFIG_DEFAULTS } from './config/config-defaults.js';

/**
 * Global persistence module providing database access.
 * PrismaService is available to all modules without explicit imports.
 *
 * On startup, auto-seeds EngineConfig defaults from env vars (Story 10-5.1 AC8).
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PersistenceModule implements OnModuleInit {
  private readonly logger = new Logger(PersistenceModule.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Build env values map from ConfigService for seed
    const envValues: Record<string, string> = {};
    for (const entry of Object.values(CONFIG_DEFAULTS)) {
      const value = this.configService.get<string>(entry.envKey);
      if (value !== undefined) {
        envValues[entry.envKey] = String(value);
      }
    }

    try {
      await seedConfig(this.prisma, envValues);
      this.logger.log('EngineConfig seed completed');
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code: string }).code
          : undefined;
      // Prisma P2021 (table not found) or P2022 (column not found) = schema not yet migrated
      const isSchemaError = code === 'P2021' || code === 'P2022';
      if (isSchemaError) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          'EngineConfig seed deferred — schema not yet migrated',
          { error: message },
        );
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error('EngineConfig seed failed', { error: message });
        throw error;
      }
    }
  }
}
