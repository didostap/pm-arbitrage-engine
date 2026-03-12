import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseApiResponse } from './parse-api-response';
import { PlatformApiError } from '../../common/errors/platform-api-error';
import { PlatformId } from '../../common/types/platform.type';

const testSchema = z.object({ status: z.string() });
const ctx = { platform: PlatformId.KALSHI, operation: 'getOrderStatus' };

describe('parseApiResponse', () => {
  it('should return parsed value on valid input', () => {
    const result = parseApiResponse(testSchema, { status: 'filled' }, ctx);
    expect(result.status).toBe('filled');
  });

  it('should throw PlatformApiError(1007) on invalid input', () => {
    expect(() => parseApiResponse(testSchema, { bad: true }, ctx)).toThrow(
      PlatformApiError,
    );

    try {
      parseApiResponse(testSchema, { bad: true }, ctx);
    } catch (error) {
      const apiErr = error as PlatformApiError;
      expect(apiErr.code).toBe(1007);
      expect(apiErr.severity).toBe('critical');
      expect(apiErr.platformId).toBe(PlatformId.KALSHI);
      expect(apiErr.metadata).toHaveProperty('rawData');
      expect(apiErr.metadata).toHaveProperty('zodErrors');
    }
  });
});
