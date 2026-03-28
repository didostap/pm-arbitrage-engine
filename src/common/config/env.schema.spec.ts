import { describe, it, expect } from 'vitest';
import { envSchema } from './env.schema';

/** Minimal valid env — only required fields with no defaults */
const validEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  OPERATOR_API_TOKEN: 'test-secret-token-12345',
};

describe('envSchema', () => {
  it('should parse valid config with only required fields (defaults fill the rest)', () => {
    const result = envSchema.parse(validEnv);
    expect(result.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(result.NODE_ENV).toBe('development');
    expect(result.PORT).toBe(8080);
  });

  it('should fail when required DATABASE_URL is missing', () => {
    expect(() => envSchema.parse({})).toThrow();
  });

  it('should coerce numeric env vars from strings', () => {
    const result = envSchema.parse({ ...validEnv, PORT: '3000' });
    expect(result.PORT).toBe(3000);
    expect(typeof result.PORT).toBe('number');
  });

  it('should reject invalid numeric values', () => {
    expect(() => envSchema.parse({ ...validEnv, PORT: 'abc' })).toThrow();
  });

  it('should reject invalid enum values', () => {
    expect(() =>
      envSchema.parse({ ...validEnv, NODE_ENV: 'staging' }),
    ).toThrow();
  });

  it('should accept valid enum values', () => {
    const result = envSchema.parse({ ...validEnv, NODE_ENV: 'production' });
    expect(result.NODE_ENV).toBe('production');
  });

  it('should reject invalid URL values', () => {
    expect(() =>
      envSchema.parse({ ...validEnv, KALSHI_API_BASE_URL: 'not-a-url' }),
    ).toThrow();
  });

  it('should accept valid URL values', () => {
    const result = envSchema.parse({
      ...validEnv,
      KALSHI_API_BASE_URL: 'https://api.kalshi.com',
    });
    expect(result.KALSHI_API_BASE_URL).toBe('https://api.kalshi.com');
  });

  it('should keep financial values as strings (not coerce to number)', () => {
    const result = envSchema.parse({
      ...validEnv,
      RISK_BANKROLL_USD: '50000.50',
      DETECTION_MIN_EDGE_THRESHOLD: '0.008',
    });
    expect(typeof result.RISK_BANKROLL_USD).toBe('string');
    expect(result.RISK_BANKROLL_USD).toBe('50000.50');
    expect(typeof result.DETECTION_MIN_EDGE_THRESHOLD).toBe('string');
  });

  it('should reject invalid decimal string values', () => {
    expect(() =>
      envSchema.parse({ ...validEnv, RISK_BANKROLL_USD: 'abc' }),
    ).toThrow();
  });

  it('should transform boolean string values to actual booleans', () => {
    const result = envSchema.parse({
      ...validEnv,
      CSV_ENABLED: 'true',
      ALLOW_MIXED_MODE: 'false',
      DISCOVERY_ENABLED: 'true',
    });
    expect(result.CSV_ENABLED).toBe(true);
    expect(result.ALLOW_MIXED_MODE).toBe(false);
    expect(result.DISCOVERY_ENABLED).toBe(true);
  });

  it('should default boolean transforms correctly', () => {
    const result = envSchema.parse(validEnv);
    // CSV_ENABLED defaults to 'true' → true
    expect(result.CSV_ENABLED).toBe(true);
    // ALLOW_MIXED_MODE defaults to 'false' → false
    expect(result.ALLOW_MIXED_MODE).toBe(false);
  });

  it('should use defaults for all optional fields', () => {
    const result = envSchema.parse(validEnv);
    expect(result.POLLING_INTERVAL_MS).toBe(30000);
    expect(result.KALSHI_API_TIER).toBe('BASIC');
    expect(result.RISK_MAX_OPEN_PAIRS).toBe(10);
    expect(result.OPERATOR_API_TOKEN).toBe('test-secret-token-12345');
    expect(result.PLATFORM_MODE_KALSHI).toBe('live');
  });

  // Story 10-9-6: Incremental Ingestion env vars
  it('[P1] INCREMENTAL_INGESTION_CRON_EXPRESSION defaults to daily 2 AM UTC', () => {
    const result = envSchema.parse(validEnv);
    expect(result.INCREMENTAL_INGESTION_CRON_EXPRESSION).toBe('0 0 2 * * *');
  });

  it('[P1] INCREMENTAL_INGESTION_ENABLED defaults to true', () => {
    const result = envSchema.parse(validEnv);
    expect(result.INCREMENTAL_INGESTION_ENABLED).toBe(true);
  });

  it('[P1] STALENESS_THRESHOLD_PLATFORM_MS defaults to 129600000 (36 hours)', () => {
    const result = envSchema.parse(validEnv);
    expect(result.STALENESS_THRESHOLD_PLATFORM_MS).toBe(129_600_000);
  });

  it('[P1] per-category staleness thresholds have correct defaults', () => {
    const result = envSchema.parse(validEnv);
    expect(result.STALENESS_THRESHOLD_PMXT_MS).toBe(172_800_000);
    expect(result.STALENESS_THRESHOLD_ODDSPIPE_MS).toBe(129_600_000);
    expect(result.STALENESS_THRESHOLD_VALIDATION_MS).toBe(259_200_000);
  });
});
