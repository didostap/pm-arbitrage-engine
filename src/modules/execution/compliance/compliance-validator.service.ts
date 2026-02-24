import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EVENT_NAMES } from '../../../common/events/event-catalog';
import { ComplianceBlockedEvent } from '../../../common/events/execution.events';
import { ComplianceConfigLoaderService } from './compliance-config-loader.service';
import type {
  ComplianceCheckContext,
  ComplianceDecision,
  ComplianceViolation,
} from './compliance-config';

@Injectable()
export class ComplianceValidatorService {
  constructor(
    private readonly configLoader: ComplianceConfigLoaderService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  validate(
    context: ComplianceCheckContext,
    isPaper?: boolean,
    mixedMode?: boolean,
  ): ComplianceDecision {
    const violations: ComplianceViolation[] = [];
    const now = new Date().toISOString();

    // Check primary platform
    this.checkPlatform(
      context.primaryPlatform,
      context.eventDescription,
      violations,
      now,
    );

    // Check secondary platform
    this.checkPlatform(
      context.secondaryPlatform,
      context.eventDescription,
      violations,
      now,
    );

    const decision: ComplianceDecision = {
      approved: violations.length === 0,
      violations,
    };

    if (!decision.approved) {
      this.eventEmitter.emit(
        EVENT_NAMES.COMPLIANCE_BLOCKED,
        new ComplianceBlockedEvent(
          context.opportunityId,
          context.pairId,
          violations.map((v) => ({
            platform: v.platform,
            category: v.category,
            rule: v.rule,
          })),
          undefined,
          isPaper ?? false,
          mixedMode ?? false,
        ),
      );
    }

    return decision;
  }

  private checkPlatform(
    platform: string,
    eventDescription: string,
    violations: ComplianceViolation[],
    timestamp: string,
  ): void {
    const config = this.configLoader.getConfig();
    const rule = config.rules.find((r) => r.platform === platform);

    if (!rule) {
      // No rule for this platform — enforce defaultAction
      if (config.defaultAction === 'deny') {
        violations.push({
          platform: platform as 'KALSHI' | 'POLYMARKET',
          category: '*',
          rule: `Default deny: no compliance rule defined for platform ${platform}`,
          timestamp,
        });
      }
      return;
    }

    const descLower = eventDescription.toLowerCase();
    for (const category of rule.blockedCategories) {
      if (descLower.includes(category.toLowerCase())) {
        violations.push({
          platform: platform as 'KALSHI' | 'POLYMARKET',
          category,
          rule: `Blocked category: ${category}`,
          timestamp,
        });
      }
    }
  }
}
