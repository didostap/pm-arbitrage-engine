import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface HttpRequest {
  headers: Record<string, string | undefined>;
}

@Injectable()
export class AuthTokenGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HttpRequest>();
    const authHeader = request.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) return false;
    const token = authHeader.slice(7);
    return token === this.configService.get<string>('OPERATOR_API_TOKEN');
  }
}
