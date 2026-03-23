/**
 * Story 10-5-4: AC1 + AC3
 *
 * AC1: expectEventHandled() integration test helper self-tests
 * AC3: Test template demonstrating single + multi-handler scenarios
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  expectEventHandled,
  expectEventHasHandler,
  expectNoDeadHandlers,
} from './expect-event-handled';
import { BaseEvent } from '../events/base.event';

// ──────────────────────────────────────────────
// Test Fixture Services (used only in this file)
// ──────────────────────────────────────────────

@Injectable()
class SingleHandlerFixture {
  @OnEvent('fixture.single.event')
  async onSingleEvent(_event: BaseEvent): Promise<void> {
    // Intentionally empty — verifies wiring only
  }
}

@Injectable()
class MultiHandlerFixtureA {
  @OnEvent('fixture.multi.event')
  async onMultiEventA(_event: BaseEvent): Promise<void> {
    // Handler A for shared event
  }
}

@Injectable()
class MultiHandlerFixtureB {
  @OnEvent('fixture.multi.event')
  async onMultiEventB(_event: BaseEvent): Promise<void> {
    // Handler B for shared event
  }
}

@Injectable()
class NoDecoratorFixture {
  async onMissingDecorator(_event: BaseEvent): Promise<void> {
    // Method exists but has NO @OnEvent decorator
  }
}

@Injectable()
class DeadHandlerFixture {
  @OnEvent('fixture.dead.never-emitted-by-anyone')
  async onDeadEvent(_event: BaseEvent): Promise<void> {
    // Decorated but no emitter fires this event
  }
}

// ──────────────────────────────────────────────
// AC1: expectEventHandled() Self-Tests
// ──────────────────────────────────────────────

describe('expectEventHandled() — AC1 Self-Tests', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot({
          wildcard: true,
          delimiter: '.',
        }),
      ],
      providers: [
        SingleHandlerFixture,
        MultiHandlerFixtureA,
        MultiHandlerFixtureB,
        NoDecoratorFixture,
        DeadHandlerFixture,
      ],
    }).compile();
    await module.init();
  });

  afterEach(async () => {
    await module.close();
  });

  it('[P0] AC1-UNIT-001 — verifies handler invoked via real EventEmitter2', async () => {
    // FAILS: expectEventHandled() does not exist yet
    await expectEventHandled({
      module,
      eventName: 'fixture.single.event',
      payload: { timestamp: new Date(), correlationId: 'ac1-001' } as BaseEvent,
      handlerClass: SingleHandlerFixture,
      handlerMethod: 'onSingleEvent',
    });
  });

  it('[P0] AC1-UNIT-002 — throws when handler method does not exist on class', async () => {
    // FAILS: expectEventHandled() does not exist yet
    await expect(
      expectEventHandled({
        module,
        eventName: 'fixture.single.event',
        payload: {
          timestamp: new Date(),
          correlationId: 'ac1-002',
        } as BaseEvent,
        handlerClass: SingleHandlerFixture,
        handlerMethod: 'nonExistentMethod',
      }),
    ).rejects.toThrow(/handler method.*nonExistentMethod.*does not exist/i);
  });

  it('[P0] AC1-UNIT-003 — throws when @OnEvent event name mismatches (handler not invoked)', async () => {
    // FAILS: expectEventHandled() does not exist yet
    await expect(
      expectEventHandled({
        module,
        eventName: 'fixture.wrong.event.name',
        payload: {
          timestamp: new Date(),
          correlationId: 'ac1-003',
        } as BaseEvent,
        handlerClass: SingleHandlerFixture,
        handlerMethod: 'onSingleEvent',
        timeout: 100,
      }),
    ).rejects.toThrow(/not invoked|timeout/i);
  });

  it('[P1] AC1-UNIT-004 — works with async handlers (awaits completion)', async () => {
    // FAILS: expectEventHandled() does not exist yet
    await expectEventHandled({
      module,
      eventName: 'fixture.single.event',
      payload: { timestamp: new Date(), correlationId: 'ac1-004' } as BaseEvent,
      handlerClass: SingleHandlerFixture,
      handlerMethod: 'onSingleEvent',
    });
  });

  it('[P0] AC1-UNIT-005 — timeout fires when handler is never invoked (dead wiring)', async () => {
    // FAILS: expectEventHandled() does not exist yet
    await expect(
      expectEventHandled({
        module,
        eventName: 'fixture.unregistered.event',
        payload: {
          timestamp: new Date(),
          correlationId: 'ac1-005',
        } as BaseEvent,
        handlerClass: NoDecoratorFixture,
        handlerMethod: 'onMissingDecorator',
        timeout: 50,
      }),
    ).rejects.toThrow(/not invoked|timeout/i);
  });

  it('[P1] AC1-UNIT-006 — event payload passed correctly to handler', async () => {
    // FAILS: expectEventHandled() does not exist yet
    const payload = {
      timestamp: new Date(),
      correlationId: 'ac1-006',
    } as BaseEvent;
    const spy = vi.spyOn(module.get(SingleHandlerFixture), 'onSingleEvent');

    await expectEventHandled({
      module,
      eventName: 'fixture.single.event',
      payload,
      handlerClass: SingleHandlerFixture,
      handlerMethod: 'onSingleEvent',
    });

    expect(spy).toHaveBeenCalledWith(payload);
    spy.mockRestore();
  });
});

// ──────────────────────────────────────────────
// AC3: Test Template — Single-Handler Scenario
// ──────────────────────────────────────────────

describe('Event Wiring Template — Single Handler (AC3)', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      providers: [SingleHandlerFixture],
    }).compile();
    await module.init();
  });

  afterEach(async () => {
    await module.close();
  });

  it('[P1] AC3-UNIT-002 — template: single handler receives event', async () => {
    // FAILS: expectEventHandled() does not exist yet
    //
    // TEMPLATE PATTERN:
    //   1. Create TestingModule with EventEmitterModule + handler service
    //   2. Call expectEventHandled() with event name, payload, handler class/method
    //   3. Helper verifies the @OnEvent decorator wiring via real EventEmitter2
    //
    await expectEventHandled({
      module,
      eventName: 'fixture.single.event',
      payload: {
        timestamp: new Date(),
        correlationId: 'template-single',
      } as BaseEvent,
      handlerClass: SingleHandlerFixture,
      handlerMethod: 'onSingleEvent',
    });
  });
});

// ──────────────────────────────────────────────
// AC3: Test Template — Multi-Handler Scenario
// ──────────────────────────────────────────────

describe('Event Wiring Template — Multi Handler (AC3)', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      providers: [MultiHandlerFixtureA, MultiHandlerFixtureB],
    }).compile();
    await module.init();
  });

  afterEach(async () => {
    await module.close();
  });

  it('[P1] AC3-UNIT-003 — template: multiple handlers for same event', async () => {
    // FAILS: expectEventHandled() does not exist yet
    //
    // TEMPLATE PATTERN:
    //   When multiple services subscribe to the same event,
    //   verify EACH handler independently with expectEventHandled().
    //
    const payload = {
      timestamp: new Date(),
      correlationId: 'template-multi',
    } as BaseEvent;

    await expectEventHandled({
      module,
      eventName: 'fixture.multi.event',
      payload,
      handlerClass: MultiHandlerFixtureA,
      handlerMethod: 'onMultiEventA',
    });

    await expectEventHandled({
      module,
      eventName: 'fixture.multi.event',
      payload,
      handlerClass: MultiHandlerFixtureB,
      handlerMethod: 'onMultiEventB',
    });
  });
});

// ──────────────────────────────────────────────
// AC1 Complementary: expectEventHasHandler()
// ──────────────────────────────────────────────

describe('expectEventHasHandler() — Complementary Helper', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      providers: [SingleHandlerFixture],
    }).compile();
    await module.init();
  });

  afterEach(async () => {
    await module.close();
  });

  it('[P1] verifies event name has at least one registered handler', () => {
    // FAILS: expectEventHasHandler() does not exist yet
    expectEventHasHandler(module, 'fixture.single.event');
  });

  it('[P1] throws for events with no registered handler', () => {
    // FAILS: expectEventHasHandler() does not exist yet
    expect(() =>
      expectEventHasHandler(module, 'fixture.nobody.listens'),
    ).toThrow(/no handler/i);
  });
});

// ──────────────────────────────────────────────
// AC2 complementary: expectNoDeadHandlers()
// ──────────────────────────────────────────────

describe('expectNoDeadHandlers() — Dead Handler Detection', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      providers: [SingleHandlerFixture, DeadHandlerFixture],
    }).compile();
    await module.init();
  });

  afterEach(async () => {
    await module.close();
  });

  it('[P0] AC2-INT-004 — identifies dead handlers (decorated but never triggered)', () => {
    // FAILS: expectNoDeadHandlers() does not exist yet
    // DeadHandlerFixture has @OnEvent('fixture.dead.never-emitted-by-anyone')
    // but nothing in this test module emits that event
    // The helper should detect this as a dead handler
    expect(() => expectNoDeadHandlers(module, DeadHandlerFixture)).toThrow(
      /dead handler.*onDeadEvent/i,
    );
  });
});
