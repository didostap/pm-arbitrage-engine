/**
 * Test helpers for verifying @OnEvent decorator wiring via real EventEmitter2.
 *
 * These helpers use a real EventEmitter2 instance (not mocked) within a NestJS
 * TestingModule to verify that @OnEvent decorators actually connect emitters
 * to handlers — catching the exact gap that was 44% of Epic 10 defects.
 *
 * @example Single handler verification
 * ```typescript
 * await expectEventHandled({
 *   module,
 *   eventName: EVENT_NAMES.ORDER_FILLED,
 *   payload: new OrderFilledEvent(...),
 *   handlerClass: DataIngestionService,
 *   handlerMethod: 'handleOrderFilled',
 * });
 * ```
 *
 * @example Multi-handler scenario (same event, multiple subscribers)
 * ```typescript
 * await expectEventHandled({ module, eventName, payload, handlerClass: ServiceA, handlerMethod: 'onEvent' });
 * await expectEventHandled({ module, eventName, payload, handlerClass: ServiceB, handlerMethod: 'onEvent' });
 * ```
 */
import { TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Type } from '@nestjs/common';
import { vi, expect } from 'vitest';
import { EVENT_NAMES } from '../events/event-catalog';

/** NestJS event-emitter stores @OnEvent metadata under this key on the method function */
const EVENT_LISTENER_METADATA = 'EVENT_LISTENER_METADATA';

export interface ExpectEventHandledOptions {
  /** NestJS TestingModule (must include EventEmitterModule.forRoot() and the handler provider) */
  module: TestingModule;
  /** Event name string (use EVENT_NAMES constants) */
  eventName: string;
  /** Event payload to emit */
  payload: unknown;
  /** Class containing the @OnEvent handler */
  handlerClass: Type<any>;
  /** Method name decorated with @OnEvent */
  handlerMethod: string;
  /** Max wait for handler invocation in ms (default: 200) */
  timeout?: number;
}

/**
 * Verifies that an @OnEvent handler is actually invoked when an event fires
 * through a real EventEmitter2 in a NestJS TestingModule.
 *
 * NestJS event-emitter uses dynamic property access (`instance[methodKey]`)
 * at invocation time, so vi.spyOn correctly intercepts the call.
 */
export async function expectEventHandled(
  options: ExpectEventHandledOptions,
): Promise<void> {
  const {
    module,
    eventName,
    payload,
    handlerClass,
    handlerMethod,
    timeout = 200,
  } = options;

  const eventEmitter = module.get(EventEmitter2);

  const service: Record<string, unknown> = module.get(handlerClass);

  // Validate handler method exists on the service
  if (typeof service[handlerMethod] !== 'function') {
    throw new Error(
      `Handler method '${handlerMethod}' does not exist on ${handlerClass.name}`,
    );
  }

  // Detect if the method is already spied by the caller.
  // Vitest's vi.spyOn returns the existing mock when the method is already mocked,
  // so we must not call mockRestore() on a caller-owned spy (it would clear their calls).
  const currentFn = service[handlerMethod] as (...args: unknown[]) => unknown;
  const callerOwnsSpy = vi.isMockFunction(currentFn);

  const spy = vi.spyOn(service as any, handlerMethod);

  try {
    // Emit via real EventEmitter2 — tests actual @OnEvent decorator wiring
    eventEmitter.emit(eventName, payload);

    // Poll for handler invocation (handles both sync and async event dispatch)
    const deadline = Date.now() + timeout;
    while (spy.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    if (spy.mock.calls.length === 0) {
      throw new Error(
        `Handler '${handlerMethod}' on ${handlerClass.name} was not invoked ` +
          `for event '${eventName}' within ${timeout}ms (timeout). ` +
          `Check that @OnEvent('${eventName}') is correctly applied.`,
      );
    }

    // Verify the payload was passed correctly
    expect(spy).toHaveBeenCalledWith(payload);
  } finally {
    // Only restore if we created the spy — don't touch caller-owned spies
    if (!callerOwnsSpy) {
      spy.mockRestore();
    }
  }
}

/**
 * Verifies that at least one handler is registered for the given event name
 * in the TestingModule's EventEmitter2.
 */
export function expectEventHasHandler(
  module: TestingModule,
  eventName: string,
): void {
  const eventEmitter = module.get(EventEmitter2);
  const listeners = eventEmitter.listeners(eventName);

  if (listeners.length === 0) {
    throw new Error(
      `No handler registered for event '${eventName}'. ` +
        `Ensure a service with @OnEvent('${eventName}') is included in the TestingModule.`,
    );
  }
}

/**
 * Verifies that all @OnEvent handlers on a class subscribe to events
 * that exist in the EVENT_NAMES catalog. Handlers for events NOT in
 * EVENT_NAMES are reported as dead handlers.
 *
 * Use this on production service classes (not test fixtures with custom event names).
 */
export function expectNoDeadHandlers(
  module: TestingModule,
  handlerClass: Type<any>,
  knownEvents?: Set<string>,
): void {
  const allEvents = knownEvents ?? new Set(Object.values(EVENT_NAMES));

  const instance: Record<string, unknown> = module.get(handlerClass);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const prototype: Record<string, unknown> = Object.getPrototypeOf(instance);

  const deadHandlers: { method: string; event: string }[] = [];

  for (const methodName of Object.getOwnPropertyNames(prototype)) {
    if (methodName === 'constructor') continue;
    if (typeof prototype[methodName] !== 'function') continue;

    // @OnEvent stores metadata on descriptor.value (the method function itself)
    const metadata = Reflect.getMetadata(
      EVENT_LISTENER_METADATA,
      prototype[methodName] as object,
    ) as Array<{ event: string | string[] }> | undefined;

    if (!metadata) continue;

    for (const entry of metadata) {
      // @OnEvent(['a', 'b']) means "listen to 'a' AND 'b'" — check each individually
      const events = Array.isArray(entry.event)
        ? entry.event.map(String)
        : [String(entry.event)];

      for (const eventName of events) {
        if (!allEvents.has(eventName)) {
          deadHandlers.push({ method: methodName, event: eventName });
        }
      }
    }
  }

  if (deadHandlers.length > 0) {
    const details = deadHandlers
      .map((d) => `${d.method} (@OnEvent('${d.event}'))`)
      .join(', ');
    throw new Error(
      `Dead handler(s) found on ${handlerClass.name}: ${details}. ` +
        `These events are not in the EVENT_NAMES catalog.`,
    );
  }
}
