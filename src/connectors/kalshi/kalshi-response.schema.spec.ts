import { describe, it, expect } from 'vitest';
import {
  kalshiOrderResponseSchema,
  kalshiAccountLimitsResponseSchema,
  kalshiWsMessageSchema,
  kalshiCancelOrderResponseSchema,
} from './kalshi-response.schema';

describe('kalshiOrderResponseSchema', () => {
  it('should accept valid order response', () => {
    const result = kalshiOrderResponseSchema.parse({
      data: {
        order: {
          order_id: 'ord-123',
          status: 'resting',
          remaining_count_fp: '10.00',
          fill_count_fp: '5.00',
          taker_fill_count_fp: '5.00',
          taker_fill_cost_dollars: '2.50',
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
          remaining_count_fp: '10.00',
          fill_count_fp: '5.00',
          taker_fill_count_fp: '5.00',
          taker_fill_cost_dollars: '2.50',
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

  it('should preserve passthrough fields (created_time, yes_price_dollars) for cast access', () => {
    const result = kalshiOrderResponseSchema.parse({
      data: {
        order: {
          order_id: 'ord-pt',
          status: 'executed',
          remaining_count_fp: '0.00',
          fill_count_fp: '10.00',
          taker_fill_count_fp: '10.00',
          taker_fill_cost_dollars: '4.50',
          created_time: '2026-01-01T00:00:00Z',
          yes_price_dollars: '0.45',
        },
      },
    });
    const rawOrder = result.data.order as Record<string, unknown>;
    expect(rawOrder['created_time']).toBe('2026-01-01T00:00:00Z');
    expect(rawOrder['yes_price_dollars']).toBe('0.45');
  });
});

describe('kalshiCancelOrderResponseSchema', () => {
  it('should accept valid cancel response with reduced_by_fp string', () => {
    const result = kalshiCancelOrderResponseSchema.parse({
      data: {
        order: {
          order_id: 'ord-456',
          status: 'canceled',
        },
        reduced_by_fp: '5.00',
      },
    });
    expect(result.data.reduced_by_fp).toBe('5.00');
  });

  it('should reject missing reduced_by_fp', () => {
    expect(() =>
      kalshiCancelOrderResponseSchema.parse({
        data: {
          order: { order_id: 'ord-456', status: 'canceled' },
        },
      }),
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
        yes_dollars_fp: [['0.6500', '100.00']],
        no_dollars_fp: [['0.3500', '200.00']],
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
        price_dollars: '0.6500',
        delta_fp: '50.00',
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
