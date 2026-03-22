import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ResetSettingsDto } from './reset-settings.dto.js';

function toDto(data: Record<string, unknown>): ResetSettingsDto {
  return plainToInstance(ResetSettingsDto, data);
}

describe('ResetSettingsDto', () => {
  it('[P1] accepts valid keys array with known setting keys', async () => {
    const dto = toDto({
      keys: ['gasBufferPercent', 'detectionMinEdgeThreshold', 'exitMode'],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('[P1] accepts empty array (means reset all Category B keys)', async () => {
    const dto = toDto({ keys: [] });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('[P1] rejects invalid key names not in SETTINGS_METADATA', async () => {
    const dto = toDto({ keys: ['nonExistentSetting'] });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'keys')).toBe(true);
  });

  it('[P1] rejects bankrollUsd in keys array (bankrollUsd has separate endpoint)', async () => {
    const dto = toDto({ keys: ['bankrollUsd'] });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'keys')).toBe(true);
  });

  it('[P1] rejects non-array keys field', async () => {
    const dto = toDto({ keys: 'gasBufferPercent' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'keys')).toBe(true);
  });
});
