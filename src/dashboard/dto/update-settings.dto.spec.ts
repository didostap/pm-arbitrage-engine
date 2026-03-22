import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateSettingsDto } from './update-settings.dto.js';

function toDto(data: Record<string, unknown>): UpdateSettingsDto {
  return plainToInstance(UpdateSettingsDto, data);
}

describe('UpdateSettingsDto', () => {
  // ── PATCH Semantics ──────────────────────────────────────────────────

  it('[P1] accepts empty object (all fields optional, PATCH semantics)', async () => {
    const dto = toDto({});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  // ── Integer Fields with Ranges ────────────────────────────────────────

  it('[P0] validates integer fields with correct ranges', async () => {
    const dto = toDto({
      gasBufferPercent: 20,
      autoUnwindDelayMs: 2000,
      polymarketOrderPollTimeoutMs: 5000,
      auditLogRetentionDays: 7,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('[P0] rejects integer field out of range (gasBufferPercent: 150)', async () => {
    const dto = toDto({ gasBufferPercent: 150 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'gasBufferPercent')).toBe(true);
  });

  it('[P0] rejects autoUnwindDelayMs above max (30001)', async () => {
    const dto = toDto({ autoUnwindDelayMs: 30001 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'autoUnwindDelayMs')).toBe(true);
  });

  it('[P0] rejects polymarketOrderPollTimeoutMs below min (999)', async () => {
    const dto = toDto({ polymarketOrderPollTimeoutMs: 999 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some((e) => e.property === 'polymarketOrderPollTimeoutMs'),
    ).toBe(true);
  });

  it('[P0] rejects auditLogRetentionDays above max (3651)', async () => {
    const dto = toDto({ auditLogRetentionDays: 3651 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'auditLogRetentionDays')).toBe(
      true,
    );
  });

  // ── Decimal String Fields ─────────────────────────────────────────────

  it('[P0] validates decimal string fields match regex /^-?\\d+(\\.\\d+)?$/', async () => {
    const dto = toDto({
      detectionMinEdgeThreshold: '0.008',
      detectionGasEstimateUsd: '0.30',
      detectionPositionSizeUsd: '300',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('[P0] rejects invalid decimal string (alphabetic)', async () => {
    const dto = toDto({ detectionMinEdgeThreshold: 'abc' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'detectionMinEdgeThreshold')).toBe(
      true,
    );
  });

  it('[P0] rejects invalid decimal string (multiple dots)', async () => {
    const dto = toDto({ detectionMinEdgeThreshold: '1.2.3' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'detectionMinEdgeThreshold')).toBe(
      true,
    );
  });

  // ── Enum Fields ───────────────────────────────────────────────────────

  it('[P0] validates enum fields (exitMode and llmPrimaryProvider)', async () => {
    const dto = toDto({
      exitMode: 'fixed',
      llmPrimaryProvider: 'gemini',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('[P0] accepts all valid exitMode values', async () => {
    for (const mode of ['fixed', 'model', 'shadow']) {
      const dto = toDto({ exitMode: mode });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('[P0] accepts all valid llmPrimaryProvider values', async () => {
    for (const provider of ['gemini', 'anthropic']) {
      const dto = toDto({ llmPrimaryProvider: provider });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('[P0] rejects invalid enum value for exitMode', async () => {
    const dto = toDto({ exitMode: 'invalid' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'exitMode')).toBe(true);
  });

  it('[P0] rejects invalid enum value for llmPrimaryProvider', async () => {
    const dto = toDto({ llmPrimaryProvider: 'openai' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'llmPrimaryProvider')).toBe(true);
  });

  // ── Boolean Fields ────────────────────────────────────────────────────

  it('[P1] validates boolean fields', async () => {
    const dto = toDto({
      discoveryEnabled: true,
      csvEnabled: false,
      autoUnwindEnabled: true,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('[P1] rejects non-boolean for boolean field', async () => {
    const dto = toDto({ discoveryEnabled: 'yes' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'discoveryEnabled')).toBe(true);
  });

  // ── Float Fields with Ranges ──────────────────────────────────────────

  it('[P1] validates float fields with ranges', async () => {
    const dto = toDto({
      exitEdgeEvapMultiplier: -1.0,
      exitTimeDecayTrigger: 0.8,
      exitProfitCaptureRatio: 0.5,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('[P1] rejects exitEdgeEvapMultiplier above max (0)', async () => {
    const dto = toDto({ exitEdgeEvapMultiplier: 0.5 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'exitEdgeEvapMultiplier')).toBe(
      true,
    );
  });

  it('[P1] rejects exitTimeDecayTrigger outside 0-1 range', async () => {
    const dto = toDto({ exitTimeDecayTrigger: 1.5 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'exitTimeDecayTrigger')).toBe(
      true,
    );
  });

  it('[P1] rejects exitProfitCaptureRatio below min (0.01)', async () => {
    const dto = toDto({ exitProfitCaptureRatio: 0.005 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'exitProfitCaptureRatio')).toBe(
      true,
    );
  });

  it('[P1] rejects exitProfitCaptureRatio above max (5)', async () => {
    const dto = toDto({ exitProfitCaptureRatio: 5.01 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'exitProfitCaptureRatio')).toBe(
      true,
    );
  });

  // ── String Fields (Non-empty) ─────────────────────────────────────────

  it('[P1] validates string fields are non-empty (cron expressions)', async () => {
    const dto = toDto({
      discoveryCronExpression: '0 0 8,20 * * *',
      llmPrimaryModel: 'gemini-2.5-flash',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('[P1] rejects empty string for cron expression', async () => {
    const dto = toDto({ discoveryCronExpression: '' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'discoveryCronExpression')).toBe(
      true,
    );
  });

  it('[P1] rejects empty string for model name', async () => {
    const dto = toDto({ llmPrimaryModel: '' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'llmPrimaryModel')).toBe(true);
  });

  // ── Partial Update ────────────────────────────────────────────────────

  it('[P1] accepts valid partial update with multiple fields', async () => {
    const dto = toDto({
      gasBufferPercent: 25,
      detectionMinEdgeThreshold: '0.01',
      exitMode: 'model',
      discoveryEnabled: false,
      exitProfitCaptureRatio: 1.5,
      discoveryCronExpression: '0 */6 * * *',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
