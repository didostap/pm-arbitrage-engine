import { describe, it, expect } from 'vitest';
import {
  kalshiOrderResponseSchema,
  kalshiAccountLimitsResponseSchema,
  kalshiWsMessageSchema,
} from './kalshi-response.schema';

describe('kalshiOrderResponseSchema', () => {
  it('should accept valid order response', () => {
    const result = kalshiOrderResponseSchema.parse({
      data: {
        order: {
          order_id: 'ord-123',
          status: 'resting',
          remaining_count: 10,
          fill_count: 5,
          taker_fill_count: 5,
          taker_fill_cost: 250,
        },
      },
    });
    expect(result.data.order.order_id).toBe('ord-123');
  });

  it('should accept extra fields (passthrough)', () => {
    const result = kalshiOrderResponseSchema.parse({
      data: {
        order: {
          order_id: 'ord-123',
          status: 'resting',
          remaining_count: 10,
          fill_count: 5,
          taker_fill_count: 5,
          taker_fill_cost: 250,
          extra_field: 'ignored',
        },
      },
      cursor: 'abc',
    });
    expect(result).toHaveProperty('cursor');
  });

  it('should reject missing required fields', () => {
    expect(() =>
      kalshiOrderResponseSchema.parse({ data: { order: {} } }),
    ).toThrow();
  });
});

describe('kalshiAccountLimitsResponseSchema', () => {
  it('should accept valid limits response', () => {
    const result = kalshiAccountLimitsResponseSchema.parse({
      data: { usage_tier: 'BASIC', read_limit: 10, write_limit: 10 },
    });
    expect(result.data.usage_tier).toBe('BASIC');
  });
});

describe('kalshiWsMessageSchema', () => {
  it('should accept valid snapshot message', () => {
    const result = kalshiWsMessageSchema.parse({
      type: 'orderbook_snapshot',
      sid: 1,
      msg: {
        seq: 100,
        market_ticker: 'MARKET-123',
        yes: [[65, 100]],
        no: [[35, 200]],
      },
    });
    expect(result.type).toBe('orderbook_snapshot');
  });

  it('should accept valid delta message', () => {
    const result = kalshiWsMessageSchema.parse({
      type: 'orderbook_delta',
      sid: 1,
      msg: {
        seq: 101,
        market_ticker: 'MARKET-123',
        price: 65,
        delta: 50,
        side: 'yes',
      },
    });
    expect(result.type).toBe('orderbook_delta');
  });

  it('should accept subscribed message without msg', () => {
    const result = kalshiWsMessageSchema.parse({
      type: 'subscribed',
      sid: 1,
    });
    expect(result.type).toBe('subscribed');
  });

  it('should accept error message without msg', () => {
    const result = kalshiWsMessageSchema.parse({
      type: 'error',
      sid: 1,
    });
    expect(result.type).toBe('error');
  });

  it('should require msg for orderbook_snapshot', () => {
    expect(() =>
      kalshiWsMessageSchema.parse({ type: 'orderbook_snapshot', sid: 1 }),
    ).toThrow();
  });

  it('should reject invalid message type', () => {
    expect(() =>
      kalshiWsMessageSchema.parse({ type: 'unknown', sid: 1, msg: {} }),
    ).toThrow();
  });
});
