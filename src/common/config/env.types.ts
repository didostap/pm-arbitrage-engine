import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { envSchema } from './env.schema';

/** Inferred type from the Zod env schema — all env vars with their parsed types */
export type Env = z.infer<typeof envSchema>;

/** Typed ConfigService that provides compile-time key checking */
export type TypedConfigService = ConfigService<Env, true>;

/** One-shot typed access to all parsed env vars.
 *  Values are already validated/transformed by ConfigModule's validate function,
 *  so we build the Env object directly from ConfigService without re-parsing. */
export function getEnvConfig(configService: ConfigService): Env {
  return Object.fromEntries(
    Object.keys(envSchema.shape).map((key) => [key, configService.get(key)]),
  ) as Env;
}
