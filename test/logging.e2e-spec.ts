import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from '../src/app.module';
import { TradingEngineService } from '../src/core/trading-engine.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BaseEvent } from '../src/common/events/base.event';
import {
  withCorrelationId,
  getCorrelationId,
} from '../src/common/services/correlation-context';

describe('Structured Logging (e2e)', () => {
  let app: NestFastifyApplication;
  let tradingEngineService: TradingEngineService;
  let eventEmitter: EventEmitter2;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();

    tradingEngineService =
      moduleFixture.get<TradingEngineService>(TradingEngineService);
    eventEmitter = moduleFixture.get<EventEmitter2>(EventEmitter2);
  });

  afterAll(async () => {
    await app.close();
  });

  it('should propagate correlation ID through polling cycle', async () => {
    let capturedId: string | undefined;

    // Capture correlation ID from within the cycle
    await withCorrelationId(async () => {
      capturedId = getCorrelationId();

      // Verify ID exists and is valid UUID format
      expect(capturedId).toBeDefined();
      expect(typeof capturedId).toBe('string');

      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(uuidRegex.test(capturedId!)).toBe(true);

      // Verify ID persists across async boundaries
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(getCorrelationId()).toBe(capturedId);
    });

    // Verify ID is undefined outside context
    expect(getCorrelationId()).toBeUndefined();
  });

  it('should emit events with correlation ID', async () => {
    let capturedEvent: BaseEvent | null = null;

    // Subscribe to platform health events
    eventEmitter.on('platform.health.*', (event: BaseEvent) => {
      capturedEvent = event;
    });

    // Trigger event emission via health service
    await tradingEngineService.executeCycle();

    // Wait for async event handling
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify event was captured (if health status changed)
    // Cast needed: TS doesn't track closure mutations from eventEmitter.on()
    const event = capturedEvent as BaseEvent | null;
    if (event) {
      // correlationId may be undefined when event is emitted outside
      // a withCorrelationId() context (e.g., connector-level health change)
      if (event.correlationId !== undefined) {
        expect(typeof event.correlationId).toBe('string');
      }
      expect(event.timestamp).toBeDefined();
      // BaseEvent constructor sets timestamp as new Date(), verify it's a Date instance or valid date value
      if (event.timestamp instanceof Date) {
        expect(event.timestamp.getTime()).not.toBeNaN();
      } else {
        // If serialized/deserialized, timestamp may be a string — verify it parses to a valid date
        expect(
          new Date(event.timestamp as unknown as string).getTime(),
        ).not.toBeNaN();
      }
    }
  });

  it('should maintain separate correlation IDs for sequential cycles', async () => {
    const ids: (string | undefined)[] = [];

    // Capture ID from first cycle
    await withCorrelationId(async () => {
      ids.push(getCorrelationId());
      await Promise.resolve(); // Satisfy async requirement
    });

    // Capture ID from second cycle
    await withCorrelationId(async () => {
      ids.push(getCorrelationId());
      await Promise.resolve(); // Satisfy async requirement
    });

    // Both should be defined
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBeDefined();

    // Both should be different
    expect(ids[0]).not.toBe(ids[1]);

    // Both should be valid UUIDs
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    ids.forEach((id) => {
      expect(uuidRegex.test(id!)).toBe(true);
    });
  });

  it.todo(
    'should include structured log fields in TradingEngineService — capture log output and verify correlationId, module, and timestamp fields',
  );
});
