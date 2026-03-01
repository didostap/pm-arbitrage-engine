import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { OnModuleDestroy, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'http';
import WebSocket from 'ws';
import type { PlatformHealth } from '../common/types/platform.type';
import type {
  OrderFilledEvent,
  ExecutionFailedEvent,
  SingleLegExposureEvent,
  ExitTriggeredEvent,
} from '../common/events/execution.events';
import type {
  LimitBreachedEvent,
  LimitApproachedEvent,
} from '../common/events/risk.events';
import { EVENT_NAMES } from '../common/events/event-catalog';
import { DashboardEventMapperService } from './dashboard-event-mapper.service';

@WebSocketGateway({ path: '/ws' })
export class DashboardGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(DashboardGateway.name);
  private readonly clients = new Set<WebSocket>();

  constructor(
    private readonly configService: ConfigService,
    private readonly mapper: DashboardEventMapperService,
  ) {}

  handleConnection(client: WebSocket, request: IncomingMessage): void {
    const token = this.extractToken(request);
    const expectedToken = this.configService.get<string>('OPERATOR_API_TOKEN');

    if (!token || token !== expectedToken) {
      this.logger.warn('WebSocket auth rejected');
      client.close(4001, 'Unauthorized');
      return;
    }

    this.clients.add(client);
    this.logger.log(`Dashboard client connected (total: ${this.clients.size})`);
  }

  handleDisconnect(client: WebSocket): void {
    this.clients.delete(client);
    this.logger.log(
      `Dashboard client disconnected (total: ${this.clients.size})`,
    );
  }

  onModuleDestroy(): void {
    this.clients.clear();
    this.logger.log('Dashboard gateway destroyed, all clients cleared');
  }

  getConnectedClientCount(): number {
    return this.clients.size;
  }

  // --- Event handlers (fan-out from EventEmitter2) ---

  @OnEvent(EVENT_NAMES.PLATFORM_HEALTH_UPDATED)
  @OnEvent(EVENT_NAMES.PLATFORM_HEALTH_DEGRADED)
  @OnEvent(EVENT_NAMES.PLATFORM_HEALTH_RECOVERED)
  broadcastHealthChange(payload: PlatformHealth): void {
    const envelope = this.mapper.mapHealthEvent(payload);
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.ORDER_FILLED)
  handleOrderFilled(event: OrderFilledEvent): void {
    const envelope = this.mapper.mapExecutionCompleteEvent(event, 'filled');
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.EXECUTION_FAILED)
  handleExecutionFailed(event: ExecutionFailedEvent): void {
    const envelope = this.mapper.mapExecutionFailedEvent(event);
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.SINGLE_LEG_EXPOSURE)
  handleSingleLegExposure(event: SingleLegExposureEvent): void {
    const envelope = this.mapper.mapSingleLegAlert(event);
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.LIMIT_BREACHED)
  handleLimitBreached(event: LimitBreachedEvent): void {
    const envelope = this.mapper.mapLimitBreachedAlert(event);
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.LIMIT_APPROACHED)
  handleLimitApproached(event: LimitApproachedEvent): void {
    const envelope = this.mapper.mapLimitApproachedAlert(event);
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.EXIT_TRIGGERED)
  handleExitTriggered(event: ExitTriggeredEvent): void {
    const envelope = this.mapper.mapPositionUpdate(event);
    this.broadcast(envelope);
  }

  // --- Private helpers ---

  private broadcast(data: unknown): void {
    const message = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch (error) {
          this.logger.warn({
            message: 'Failed to send WebSocket message, removing dead client',
            data: {
              error: error instanceof Error ? error.message : String(error),
            },
          });
          this.clients.delete(client);
        }
      }
    }
  }

  private extractToken(request: IncomingMessage): string | null {
    try {
      const url = request.url;
      if (!url) return null;
      const parsed = new URL(url, 'http://localhost');
      return parsed.searchParams.get('token');
    } catch {
      return null;
    }
  }
}
