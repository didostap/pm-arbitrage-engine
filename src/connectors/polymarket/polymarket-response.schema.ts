import { z } from 'zod';

// Polymarket CLOB API response schemas

export const polymarketPostOrderResponseSchema = z
  .object({
    orderID: z.string().optional(),
    id: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough()
  .refine((d) => d.orderID || d.id, {
    message:
      'Response must contain at least one order identifier (orderID or id)',
  });

export const polymarketOrderStatusSchema = z
  .object({
    status: z.string().optional(),
    filledSize: z.number().optional(),
    filledPrice: z.number().optional(),
  })
  .passthrough();

// Polymarket Gamma API response schemas

const polymarketMarketSchema = z
  .object({
    conditionId: z.string(),
    question: z.string(),
    description: z.string().optional(),
    endDate: z.string().optional(),
    clobTokenIds: z.string().optional(),
    outcomes: z.string().optional(),
  })
  .passthrough();

export const polymarketEventSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    tags: z.array(z.object({ label: z.string() }).passthrough()).optional(),
    markets: z.array(polymarketMarketSchema).optional(),
  })
  .passthrough();

const polymarketTokenSchema = z
  .object({
    outcome: z.string(),
    winner: z.boolean(),
  })
  .passthrough();

export const polymarketResolutionMarketSchema = z
  .object({
    conditionId: z.string(),
    tokens: z.array(polymarketTokenSchema),
  })
  .passthrough();

// Polymarket WebSocket message schemas

export const polymarketOrderBookMsgSchema = z
  .object({
    asset_id: z.string(),
    market: z.string(),
    timestamp: z.number(),
    bids: z.array(z.object({ price: z.string(), size: z.string() })),
    asks: z.array(z.object({ price: z.string(), size: z.string() })),
    hash: z.string(),
  })
  .passthrough();

const polymarketPriceChangeEntrySchema = z
  .object({
    asset_id: z.string(),
    price: z.string(),
    size: z.string(),
    side: z.string(),
    hash: z.string(),
    best_bid: z.string(),
    best_ask: z.string(),
  })
  .passthrough();

export const polymarketPriceChangeMsgSchema = z
  .object({
    market: z.string(),
    price_changes: z.array(polymarketPriceChangeEntrySchema),
    timestamp: z.string(),
    event_type: z.literal('price_change'),
  })
  .passthrough();

// Third-party API response schemas

export const coinGeckoPriceSchema = z
  .object({
    'polygon-ecosystem-token': z
      .object({
        usd: z.number(),
      })
      .passthrough(),
  })
  .passthrough();
