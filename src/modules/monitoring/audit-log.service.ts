import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { auditLogDetailsSchema } from '../../common/schemas/prisma-json.schema.js';
import { AuditLogRepository } from '../../persistence/repositories/audit-log.repository.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import {
  AuditLogFailedEvent,
  AuditChainBrokenEvent,
} from '../../common/events/monitoring.events.js';
import { MONITORING_ERROR_CODES } from './monitoring-error-codes.js';

export interface AuditLogEntry {
  eventType: string;
  module: string;
  correlationId?: string;
  details: Record<string, unknown>;
}

export interface ChainVerificationResult {
  valid: boolean;
  entriesChecked: number;
  brokenAtId?: string;
  brokenAtTimestamp?: string;
  expectedHash?: string;
  actualHash?: string;
}

const GENESIS_HASH = '0'.repeat(64);

@Injectable()
export class AuditLogService implements OnModuleInit {
  private readonly logger = new Logger(AuditLogService.name);
  private writeQueue: Promise<void> = Promise.resolve();
  private lastHash: string | null = null;

  constructor(
    private readonly auditLogRepository: AuditLogRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const lastEntry = await this.auditLogRepository.findLast();
      this.lastHash = lastEntry?.currentHash ?? null;
      this.logger.log({
        message: 'Audit log service initialized',
        module: 'monitoring',
        data: { lastHashLoaded: !!lastEntry },
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to load last audit hash on init',
        module: 'monitoring',
        error: String(error),
      });
    }
  }

  async append(entry: AuditLogEntry): Promise<void> {
    const promise = this.writeQueue.then(async () => {
      try {
        await this.doAppend(entry);
      } catch (err) {
        this.handleWriteError(err, entry);
        throw err;
      }
    });

    // Keep queue alive regardless of outcome — serialization must not break
    this.writeQueue = promise.catch(() => {});
    return promise;
  }

  async verifyChain(
    startDate: Date,
    endDate: Date,
  ): Promise<ChainVerificationResult> {
    const entries = await this.auditLogRepository.findByDateRange(
      startDate,
      endDate,
    );

    if (entries.length === 0) {
      return { valid: true, entriesChecked: 0 };
    }

    // Get the entry just before the range to verify the first entry's previousHash
    const entryBefore = await this.auditLogRepository.findJustBefore(
      entries[0]!.createdAt,
    );

    let expectedPreviousHash: string;

    if (entryBefore) {
      // Normal case — verify first entry chains from the prior entry
      expectedPreviousHash = entryBefore.currentHash;
    } else if (entries[0]!.previousHash === GENESIS_HASH) {
      // Fresh database — first entry ever, verify against genesis
      expectedPreviousHash = GENESIS_HASH;
    } else {
      // Post-pruning — prior entries deleted, oldest retained = chain anchor
      // Setting expected = actual effectively SKIPS validation for this entry only.
      // The anchor's previousHash pointed to a now-pruned row — we can't verify it,
      // so we trust it and start chain verification from entry[1] onward.
      expectedPreviousHash = entries[0]!.previousHash;
      this.logger.debug({
        message: 'Chain verification starting at post-pruning anchor',
        module: 'monitoring',
        data: {
          anchorId: entries[0]!.id,
          anchorTimestamp: entries[0]!.createdAt.toISOString(),
        },
      });
    }

    for (const entry of entries) {
      // Verify previousHash matches expected
      if (entry.previousHash !== expectedPreviousHash) {
        this.eventEmitter.emit(
          EVENT_NAMES.AUDIT_CHAIN_BROKEN,
          new AuditChainBrokenEvent(
            entry.id,
            expectedPreviousHash,
            entry.previousHash,
          ),
        );
        return {
          valid: false,
          entriesChecked: entries.indexOf(entry) + 1,
          brokenAtId: entry.id,
          brokenAtTimestamp: entry.createdAt.toISOString(),
          expectedHash: expectedPreviousHash,
          actualHash: entry.previousHash,
        };
      }

      // Recompute hash and verify currentHash
      const parsedDetails = auditLogDetailsSchema.parse(entry.details ?? {});
      const recomputedHash = this.computeHash(
        entry.previousHash,
        entry.eventType,
        parsedDetails,
        entry.createdAt.toISOString(),
      );

      if (entry.currentHash !== recomputedHash) {
        this.eventEmitter.emit(
          EVENT_NAMES.AUDIT_CHAIN_BROKEN,
          new AuditChainBrokenEvent(
            entry.id,
            recomputedHash,
            entry.currentHash,
          ),
        );
        return {
          valid: false,
          entriesChecked: entries.indexOf(entry) + 1,
          brokenAtId: entry.id,
          brokenAtTimestamp: entry.createdAt.toISOString(),
          expectedHash: recomputedHash,
          actualHash: entry.currentHash,
        };
      }

      expectedPreviousHash = entry.currentHash;
    }

    return { valid: true, entriesChecked: entries.length };
  }

  private async doAppend(entry: AuditLogEntry): Promise<void> {
    // Load last hash from DB if not cached (first call after startup without onModuleInit)
    if (this.lastHash === null) {
      const lastEntry = await this.auditLogRepository.findLast();
      this.lastHash = lastEntry?.currentHash ?? GENESIS_HASH;
    }

    const previousHash = this.lastHash;
    const timestamp = new Date();
    const currentHash = this.computeHash(
      previousHash,
      entry.eventType,
      entry.details,
      timestamp.toISOString(),
    );

    await this.auditLogRepository.create({
      eventType: entry.eventType,
      module: entry.module,
      correlationId: entry.correlationId,
      details: entry.details as Prisma.InputJsonValue,
      previousHash,
      currentHash,
      createdAt: timestamp,
    });

    this.lastHash = currentHash;
  }

  private computeHash(
    previousHash: string,
    eventType: string,
    details: Record<string, unknown>,
    timestamp: string,
  ): string {
    const canonicalDetails = this.sortedStringify(details);
    const payload = `${previousHash}|${eventType}|${timestamp}|${canonicalDetails}`;
    return createHash('sha256').update(payload).digest('hex');
  }

  private sortedStringify(obj: unknown): string {
    if (obj === null || obj === undefined) return JSON.stringify(obj);
    if (typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) {
      return (
        '[' + obj.map((item) => this.sortedStringify(item)).join(',') + ']'
      );
    }
    const sorted = Object.keys(obj as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${this.sortedStringify((obj as Record<string, unknown>)[key])}`,
      );
    return '{' + sorted.join(',') + '}';
  }

  private handleWriteError(err: unknown, entry: AuditLogEntry): void {
    this.logger.error({
      message: 'Audit log write failed',
      module: 'monitoring',
      code: MONITORING_ERROR_CODES.AUDIT_LOG_WRITE_FAILED,
      error: String(err),
      data: { eventType: entry.eventType, module: entry.module },
    });
    this.eventEmitter.emit(
      EVENT_NAMES.AUDIT_LOG_FAILED,
      new AuditLogFailedEvent(String(err), entry.eventType, entry.module),
    );
  }
}
