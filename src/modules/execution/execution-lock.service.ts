import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class ExecutionLockService {
  private readonly logger = new Logger(ExecutionLockService.name);
  private lockPromise: Promise<void> | null = null;
  private releaseFn: (() => void) | null = null;
  private lockTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly LOCK_TIMEOUT_MS = 30_000;

  async acquire(): Promise<void> {
    while (this.lockPromise) {
      await this.lockPromise;
    }
    this.lockPromise = new Promise<void>((resolve) => {
      this.releaseFn = resolve;
    });
    this.lockTimeout = setTimeout(() => {
      this.logger.error({
        message: 'Execution lock timeout — force releasing after 30s',
      });
      this.release();
    }, this.LOCK_TIMEOUT_MS);
  }

  release(): void {
    if (this.lockTimeout) {
      clearTimeout(this.lockTimeout);
      this.lockTimeout = null;
    }
    if (this.releaseFn) {
      const fn = this.releaseFn;
      this.releaseFn = null;
      this.lockPromise = null;
      fn();
    }
  }

  isLocked(): boolean {
    return this.lockPromise !== null;
  }
}
