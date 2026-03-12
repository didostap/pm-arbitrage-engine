import { describe, it, expect } from 'vitest';
import {
  polymarketPostOrderResponseSchema,
  polymarketOrderStatusSchema,
  polymarketEventSchema,
  polymarketResolutionMarketSchema,
  polymarketOrderBookMsgSchema,
  polymarketPriceChangeMsgSchema,
  coinGeckoPriceSchema,
} from './polymarket-response.schema';
import { telegramResponseSchema } from '../../common/schemas/telegram-response.schema';

describe('polymarketPostOrderResponseSchema', () => {
  it('should accept response with orderID', () => {
    const result = polymarketPostOrderResponseSchema.parse({
      orderID: 'order-123',
      status: 'matched',
    });
    expect(result.orderID).toBe('order-123');
  });

  it('should accept response with id (alternative identifier)', () => {
    const result = polymarketPostOrderResponseSchema.parse({
      id: 'alt-456',
    });
    expect(result.id).toBe('alt-456');
  });

  it('should reject response with no identifier', () => {
    expect(() =>
      polymarketPostOrderResponseSchema.parse({ status: 'live' }),
    ).toThrow('at least one order identifier');
  });
});

describe('polymarketOrderStatusSchema', () => {
  it('should accept valid order status', () => {
    const result = polymarketOrderStatusSchema.parse({
      status: 'matched',
      filledSize: 100,
      filledPrice: 0.65,
    });
    expect(result.status).toBe('matched');
  });

  it('should accept missing optional fields', () => {
    const result = polymarketOrderStatusSchema.parse({});
    expect(result.status).toBeUndefined();
  });

  it('should accept extra fields (passthrough)', () => {
    const result = polymarketOrderStatusSchema.parse({
      status: 'live',
      extra: true,
    });
    expect(result).toHaveProperty('extra');
  });
});

describe('polymarketEventSchema', () => {
  it('should accept valid event', () => {
    const result = polymarketEventSchema.parse({
      id: 'evt-1',
      title: 'Will X happen?',
      markets: [{ conditionId: 'cond-1', question: 'Yes or No?' }],
    });
    expect(result.id).toBe('evt-1');
  });

  it('should reject missing required fields', () => {
    expect(() => polymarketEventSchema.parse({ id: 'evt-1' })).toThrow();
  });
});

describe('polymarketResolutionMarketSchema', () => {
  it('should accept valid resolution market', () => {
    const result = polymarketResolutionMarketSchema.parse({
      conditionId: 'cond-1',
      tokens: [{ outcome: 'Yes', winner: true }],
    });
    expect(result.conditionId).toBe('cond-1');
  });
});

describe('polymarketOrderBookMsgSchema', () => {
  it('should accept valid order book message', () => {
    const result = polymarketOrderBookMsgSchema.parse({
      asset_id: 'asset-1',
      market: 'market-1',
      timestamp: 1234567890,
      bids: [{ price: '0.65', size: '100' }],
      asks: [{ price: '0.66', size: '200' }],
      hash: 'abc123',
    });
    expect(result.asset_id).toBe('asset-1');
  });
});

describe('polymarketPriceChangeMsgSchema', () => {
  it('should accept valid price change message', () => {
    const result = polymarketPriceChangeMsgSchema.parse({
      market: 'market-1',
      price_changes: [
        {
          asset_id: 'asset-1',
          price: '0.65',
          size: '100',
          side: 'BUY',
          hash: 'h1',
          best_bid: '0.64',
          best_ask: '0.66',
        },
      ],
      timestamp: '2026-03-12T00:00:00Z',
      event_type: 'price_change',
    });
    expect(result.event_type).toBe('price_change');
  });
});

describe('coinGeckoPriceSchema', () => {
  it('should accept valid CoinGecko response', () => {
    const result = coinGeckoPriceSchema.parse({
      'polygon-ecosystem-token': { usd: 0.42 },
    });
    expect(result['polygon-ecosystem-token'].usd).toBe(0.42);
  });

  it('should reject missing token key', () => {
    expect(() => coinGeckoPriceSchema.parse({})).toThrow();
  });
});

describe('telegramResponseSchema', () => {
  it('should accept valid telegram response', () => {
    const result = telegramResponseSchema.parse({ ok: true });
    expect(result.ok).toBe(true);
  });

  it('should reject missing ok field', () => {
    expect(() => telegramResponseSchema.parse({})).toThrow();
  });
});
