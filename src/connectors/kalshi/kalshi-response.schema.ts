import { z } from 'zod';

// Kalshi REST API response schemas

/**
 * Intentional passthrough strategy: only critical consumed fields are validated
 * with strict Zod types. Additional fields returned by the Kalshi API (e.g.
 * `created_time`, `yes_price_dollars`, `no_price_dollars`, `expiration_time`)
 * pass through unvalidated via `.passthrough()` and are accessed via cast
 * (e.g. `order as Record<string, unknown>`). This avoids breaking on API
 * additions while still guaranteeing the fields we depend on are present.
 */
export const kalshiOrderResponseSchema = z
  .object({
    data: z.object({
      order: z
        .object({
          order_id: z.string(),
          status: z.string(),
          remaining_count_fp: z.string(),
          fill_count_fp: z.string(),
          taker_fill_count_fp: z.string(),
          taker_fill_cost_dollars: z.string(),
        })
        .passthrough(),
    }),
  })
  .passthrough();

export const kalshiCancelOrderResponseSchema = z
  .object({
    data: z.object({
      order: z
        .object({
          order_id: z.string(),
          status: z.string(),
        })
        .passthrough(),
      reduced_by_fp: z.string(),
    }),
  })
  .passthrough();

export const kalshiAccountLimitsResponseSchema = z
  .object({
    data: z.object({
      usage_tier: z.string(),
      read_limit: z.number(),
      write_limit: z.number(),
    }),
  })
  .passthrough();

// Kalshi WebSocket message schemas

const kalshiSnapshotMsgSchema = z
  .object({
    seq: z.number(),
    market_ticker: z.string(),
    yes_dollars_fp: z.array(z.tuple([z.string(), z.string()])),
    no_dollars_fp: z.array(z.tuple([z.string(), z.string()])),
  })
  .passthrough();

const kalshiDeltaMsgSchema = z
  .object({
    seq: z.number(),
    market_ticker: z.string(),
    price_dollars: z.string(),
    delta_fp: z.string(),
    side: z.enum(['yes', 'no']),
  })
  .passthrough();

export const kalshiWsMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('orderbook_snapshot'),
      sid: z.number(),
      msg: kalshiSnapshotMsgSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal('orderbook_delta'),
      sid: z.number(),
      msg: kalshiDeltaMsgSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal('subscribed'),
      sid: z.number(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('error'),
      sid: z.number(),
    })
    .passthrough(),
]);
