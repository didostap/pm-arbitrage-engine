import { describe, it, expect } from 'vitest';
import { Platform } from '@prisma/client';
import { PlatformId } from '../types/platform.type';
import { toPlatformEnum } from './platform';

describe('toPlatformEnum', () => {
  it('should convert KALSHI to uppercase', () => {
    const result = toPlatformEnum(PlatformId.KALSHI);
    expect(result).toBe(Platform.KALSHI);
  });

  it('should convert POLYMARKET to uppercase', () => {
    const result = toPlatformEnum(PlatformId.POLYMARKET);
    expect(result).toBe(Platform.POLYMARKET);
  });

  it('should throw error for invalid platform', () => {
    expect(() => toPlatformEnum('invalid' as PlatformId)).toThrowError(
      /Invalid platform ID/,
    );
  });
});
