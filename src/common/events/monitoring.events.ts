export class AuditLogFailedEvent {
  constructor(
    public readonly error: string,
    public readonly eventType: string,
    public readonly module: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

export class AuditChainBrokenEvent {
  constructor(
    public readonly brokenAtId: string,
    public readonly expectedHash: string,
    public readonly actualHash: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}
