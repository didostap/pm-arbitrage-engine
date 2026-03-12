import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { parseWsMessage } from './parse-ws-message';
import { PlatformId } from '../../common/types/platform.type';

const testSchema = z.object({ type: z.string(), data: z.number() });
const ctx = { platform: PlatformId.POLYMARKET };

describe('parseWsMessage', () => {
  it('should return parsed value on valid input', () => {
    const result = parseWsMessage(
      testSchema,
      { type: 'update', data: 42 },
      ctx,
    );
    expect(result).toEqual({ type: 'update', data: 42 });
  });

  it('should return null on invalid input', () => {
    const result = parseWsMessage(testSchema, { type: 123 }, ctx);
    expect(result).toBeNull();
  });

  it('should log warning on invalid input', () => {
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    parseWsMessage(testSchema, { bad: true }, ctx);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid WebSocket message'),
    );
    warnSpy.mockRestore();
  });
});
