import { Params } from 'nestjs-pino';
import { getCorrelationId } from '../services/correlation-context';

export const loggerConfig: Params = {
  pinoHttp: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',

    // Auto-inject correlation ID for HTTP-triggered code paths
    // NOTE: customProps only works for pinoHttp middleware (HTTP requests).
    // For polling cycles (non-HTTP contexts like @Cron), services must manually
    // include correlationId in their log data object.
    customProps: (): Record<string, unknown> => ({
      correlationId: getCorrelationId(),
    }),

    // Pretty-print for development
    transport:
      process.env.NODE_ENV !== 'production'
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              singleLine: false,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          }
        : undefined,

    // Customize base log object (remove unwanted default fields)
    base: null, // Removes pid, hostname, etc.

    // Serializers for complex objects
    serializers: {
      req: () => undefined, // Don't log HTTP req (not HTTP-heavy app)
      res: () => undefined,
    },
  },
};
