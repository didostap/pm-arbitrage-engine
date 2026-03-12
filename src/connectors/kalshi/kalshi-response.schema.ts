import { z } from 'zod';

// Kalshi REST API response schemas

export const kalshiOrderResponseSchema = z
  .object({
    data: z.object({
      order: z
        .object({
          order_id: z.string(),
          status: z.string(),
          remaining_count: z.number(),
          fill_count: z.number(),
          taker_fill_count: z.number(),
          taker_fill_cost: z.number(),
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
      reduced_by: z.number(),
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
    yes: z.array(z.tuple([z.number(), z.number()])),
    no: z.array(z.tuple([z.number(), z.number()])),
  })
  .passthrough();

const kalshiDeltaMsgSchema = z
  .object({
    seq: z.number(),
    market_ticker: z.string(),
    price: z.number(),
    delta: z.number(),
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
