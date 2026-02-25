import {
  Catch,
  type ExceptionFilter,
  type ArgumentsHost,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SystemError } from '../errors/system-error.js';
import { SystemHealthCriticalEvent } from '../events/system.events.js';
import { EVENT_NAMES } from '../events/event-catalog.js';

@Catch(SystemError)
export class SystemErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(SystemErrorFilter.name);
  private emitting = false;

  constructor(private readonly eventEmitter: EventEmitter2) {}

  catch(exception: SystemError, host: ArgumentsHost): void {
    // Structured log with full error context
    this.logger.error({
      message: exception.message,
      code: exception.code,
      severity: exception.severity,
      retryStrategy: exception.retryStrategy,
      component:
        'component' in exception
          ? (exception as { component?: string }).component
          : undefined,
      module: 'system-error-filter',
      stack: exception.stack,
    });

    // Emit SystemHealthCriticalEvent for critical severity errors
    // Re-entrancy guard prevents infinite loops (filter → emit → handler fails → filter catches → emit again)
    if (exception.severity === 'critical' && !this.emitting) {
      this.emitting = true;
      try {
        this.eventEmitter.emit(
          EVENT_NAMES.SYSTEM_HEALTH_CRITICAL,
          new SystemHealthCriticalEvent(
            'component' in exception
              ? String(
                  (exception as { component?: string }).component ?? 'unknown',
                )
              : 'unknown',
            `Unhandled SystemError: ${exception.message} (code: ${exception.code})`,
            ['Check error logs', 'Investigate root cause'],
            'critical',
          ),
        );
      } finally {
        this.emitting = false;
      }
    }

    // Only build HTTP response for HTTP contexts
    const contextType = host.getType();
    if (contextType !== 'http') {
      // For Cron, WebSocket, or other non-HTTP contexts: log only, no response to build
      return;
    }

    const ctx = host.switchToHttp();
    const response: {
      status: (code: number) => { send: (body: unknown) => void };
    } = ctx.getResponse();

    // Map severity to HTTP status (SystemError severity: 'critical' | 'error' | 'warning')
    const statusCode =
      exception.severity === 'critical'
        ? 500
        : exception.severity === 'error'
          ? 500
          : 400; // 'warning'

    const errorResponse = {
      error: {
        code: exception.code,
        message: exception.message,
        severity: exception.severity,
      },
      timestamp: new Date().toISOString(),
    };

    // Fastify response
    void response.status(statusCode).send(errorResponse);
  }
}
