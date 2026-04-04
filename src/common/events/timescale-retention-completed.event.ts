import { BaseEvent } from './base.event.js';

export class TimescaleRetentionCompletedEvent extends BaseEvent {
  constructor(
    public readonly droppedChunks: Record<string, number>,
    public readonly durationMs: number,
  ) {
    super();
  }
}
