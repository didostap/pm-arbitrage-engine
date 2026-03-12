import { z } from 'zod';

export const telegramResponseSchema = z
  .object({
    ok: z.boolean(),
  })
  .passthrough();

export const telegramRateLimitSchema = z
  .object({
    parameters: z
      .object({
        retry_after: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();
