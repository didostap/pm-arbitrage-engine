import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { withCorrelationId } from '../../common/services/correlation-context.js';
import { AuditLogRepository } from '../../persistence/repositories/audit-log.repository.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import { AuditLogPrunedEvent } from '../../common/events/monitoring.events.js';
import { MONITORING_ERROR_CODES } from './monitoring-error-codes.js';

@Injectable()
export class AuditLogRetentionService {
  private readonly logger = new Logger(AuditLogRetentionService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly auditLogRepository: AuditLogRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Cron('0 3 * * *', { timeZone: 'UTC' })
  async handlePruning(): Promise<void> {
    await withCorrelationId(async () => {
      try {
        const retentionDays = this.configService.get<number>(
          'AUDIT_LOG_RETENTION_DAYS',
          7,
        );

        if (retentionDays === 0) {
          this.logger.debug({
            message: 'Audit log pruning disabled (AUDIT_LOG_RETENTION_DAYS=0)',
            module: 'monitoring',
          });
          return;
        }

        const cutoffDate = new Date(Date.now() - retentionDays * 86_400_000);

        const count = await this.auditLogRepository.deleteOlderThan(cutoffDate);

        if (count > 0) {
          this.eventEmitter.emit(
            EVENT_NAMES.AUDIT_LOG_PRUNED,
            new AuditLogPrunedEvent(
              count,
              cutoffDate.toISOString(),
              retentionDays,
            ),
          );
          this.logger.log({
            message: `Audit log pruned ${count} rows older than ${cutoffDate.toISOString()}`,
            module: 'monitoring',
            data: {
              count,
              cutoffDate: cutoffDate.toISOString(),
              retentionDays,
            },
          });
        } else {
          this.logger.debug({
            message: 'No audit log rows to prune',
            module: 'monitoring',
            data: { cutoffDate: cutoffDate.toISOString(), retentionDays },
          });
        }
      } catch (error) {
        this.logger.error({
          message: 'Audit log pruning failed',
          code: MONITORING_ERROR_CODES.AUDIT_LOG_PRUNE_FAILED,
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
          module: 'monitoring',
        });
        // NEVER re-throw — pruning failure must not block trading
      }
    });
  }
}
