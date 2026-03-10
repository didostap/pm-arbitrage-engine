import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KalshiCatalogProvider } from './kalshi-catalog-provider';
import { PlatformId } from '../../common/types/platform.type';
import { PlatformApiError } from '../../common/errors/platform-api-error';
import type { ConfigService } from '@nestjs/config';

// Mock kalshi-typescript SDK
const { mockGetEvents } = vi.hoisted(() => ({
  mockGetEvents: vi.fn(),
}));
vi.mock('kalshi-typescript', () => {
  const MockEventsApi = vi.fn() as {
    new (): unknown;
    prototype: Record<string, unknown>;
  };
  MockEventsApi.prototype['getEvents'] = mockGetEvents;
  const MockConfiguration = vi.fn();
  return { EventsApi: MockEventsApi, Configuration: MockConfiguration };
});

function createMockConfig(
  overrides: Record<string, string> = {},
): ConfigService {
  const defaults: Record<string, string> = {
    KALSHI_API_KEY_ID: 'test-key',
    KALSHI_PRIVATE_KEY_PATH: '',
    KALSHI_API_BASE_URL: 'https://demo-api.kalshi.co/trade-api/v2',
    ...overrides,
  };
  return {
    get: vi.fn(
      (key: string, defaultVal?: unknown) => defaults[key] ?? defaultVal,
    ),
  } as unknown as ConfigService;
}

describe('KalshiCatalogProvider', () => {
  let provider: KalshiCatalogProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    const config = createMockConfig();
    provider = new KalshiCatalogProvider(config);
  });

  it('should return PlatformId.KALSHI', () => {
    expect(provider.getPlatformId()).toBe(PlatformId.KALSHI);
  });

  it('should use event.title as title and include market detail in description', async () => {
    mockGetEvents.mockResolvedValueOnce({
      data: {
        events: [
          {
            event_ticker: 'EVT-1',
            title: 'Will Bitcoin hit $100k?',
            series_ticker: 'CRYPTO',
            category: 'Crypto',
            markets: [
              {
                ticker: 'BTC-100K-YES',
                event_ticker: 'EVT-1',
                title: '',
                subtitle: '',
                yes_sub_title: 'Before Jan 1, 2026',
                status: 'open',
                close_time: '2026-12-31T00:00:00Z',
              },
            ],
          },
        ],
        cursor: '',
      },
    });

    const result = await provider.listActiveContracts();
    expect(result).toHaveLength(1);

    const contract = result[0]!;
    expect(contract.contractId).toBe('BTC-100K-YES');
    expect(contract.title).toBe('Will Bitcoin hit $100k?'); // event title
    expect(contract.description).toBe(
      'Will Bitcoin hit $100k?\nBefore Jan 1, 2026', // event title + market detail
    );
    expect(contract.category).toBe('CRYPTO');
    expect(contract.settlementDate).toEqual(new Date('2026-12-31T00:00:00Z'));
    expect(contract.platform).toBe(PlatformId.KALSHI);
  });

  it('should use subtitle as market detail when yes_sub_title is absent', async () => {
    mockGetEvents.mockResolvedValueOnce({
      data: {
        events: [
          {
            event_ticker: 'EVT-2',
            title: 'Election 2028',
            markets: [
              {
                ticker: 'ELECT-2028',
                event_ticker: 'EVT-2',
                title: '',
                subtitle: 'Democrat wins',
                status: 'open',
              },
            ],
          },
        ],
        cursor: '',
      },
    });

    const result = await provider.listActiveContracts();
    const contract = result[0]!;
    expect(contract.title).toBe('Election 2028');
    expect(contract.description).toBe('Election 2028\nDemocrat wins');
  });

  it('should use only event title when all market fields are empty', async () => {
    mockGetEvents.mockResolvedValueOnce({
      data: {
        events: [
          {
            event_ticker: 'EVT-3',
            title: 'Simple Event Question',
            markets: [
              {
                ticker: 'SIMPLE-1',
                event_ticker: 'EVT-3',
                title: '',
                subtitle: '',
                yes_sub_title: '',
                status: 'open',
              },
            ],
          },
        ],
        cursor: '',
      },
    });

    const result = await provider.listActiveContracts();
    const contract = result[0]!;
    expect(contract.title).toBe('Simple Event Question');
    expect(contract.description).toBe('Simple Event Question'); // no market detail
  });

  it('should include rules_primary in description when available', async () => {
    mockGetEvents.mockResolvedValueOnce({
      data: {
        events: [
          {
            event_ticker: 'EVT-5',
            title: 'Keir Starmer Out?',
            markets: [
              {
                ticker: 'KSTARMER-OUT',
                event_ticker: 'EVT-5',
                title: '',
                yes_sub_title: 'Before Jul 1, 2026',
                status: 'open',
                rules_primary:
                  'This market resolves Yes if Keir Starmer ceases to be PM before July 1, 2026.',
              },
            ],
          },
        ],
        cursor: '',
      },
    });

    const result = await provider.listActiveContracts();
    const contract = result[0]!;
    expect(contract.title).toBe('Keir Starmer Out?');
    expect(contract.description).toBe(
      'Keir Starmer Out?\nBefore Jul 1, 2026\nThis market resolves Yes if Keir Starmer ceases to be PM before July 1, 2026.',
    );
  });

  it('should use category when series_ticker is empty', async () => {
    mockGetEvents.mockResolvedValueOnce({
      data: {
        events: [
          {
            event_ticker: 'EVT-4',
            title: 'Some Event',
            series_ticker: '',
            category: 'Politics',
            markets: [
              {
                ticker: 'POL-1',
                event_ticker: 'EVT-4',
                title: 'Market question',
                status: 'open',
              },
            ],
          },
        ],
        cursor: '',
      },
    });

    const result = await provider.listActiveContracts();
    expect(result[0]!.category).toBe('Politics');
  });

  it('should handle cursor-based pagination across multiple pages', async () => {
    mockGetEvents
      .mockResolvedValueOnce({
        data: {
          events: [
            {
              event_ticker: 'E1',
              title: 'Event 1',
              markets: [
                {
                  ticker: 'M1',
                  event_ticker: 'E1',
                  title: 'Market 1',
                  status: 'open',
                },
              ],
            },
          ],
          cursor: 'page2-cursor',
        },
      })
      .mockResolvedValueOnce({
        data: {
          events: [
            {
              event_ticker: 'E2',
              title: 'Event 2',
              markets: [
                {
                  ticker: 'M2',
                  event_ticker: 'E2',
                  title: 'Market 2',
                  status: 'open',
                },
              ],
            },
          ],
          cursor: '',
        },
      });

    const result = await provider.listActiveContracts();
    expect(result).toHaveLength(2);
    expect(result[0]!.contractId).toBe('M1');
    expect(result[1]!.contractId).toBe('M2');
    expect(mockGetEvents).toHaveBeenCalledTimes(2);
  });

  it('should skip events with no markets', async () => {
    mockGetEvents.mockResolvedValueOnce({
      data: {
        events: [
          { event_ticker: 'E1', title: 'No markets', markets: [] },
          { event_ticker: 'E2', title: 'No markets field' },
        ],
        cursor: '',
      },
    });

    const result = await provider.listActiveContracts();
    expect(result).toHaveLength(0);
  });

  it('should return empty array when no events', async () => {
    mockGetEvents.mockResolvedValueOnce({
      data: { events: [], cursor: '' },
    });

    const result = await provider.listActiveContracts();
    expect(result).toHaveLength(0);
  });

  it('should wrap API errors in PlatformApiError', async () => {
    mockGetEvents.mockRejectedValueOnce(new Error('Network timeout'));

    await expect(provider.listActiveContracts()).rejects.toThrow(
      PlatformApiError,
    );
    await expect(provider.listActiveContracts()).rejects.toThrow(
      /Kalshi catalog fetch failed/,
    );
  });
});
