import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';
import { HealthCheckResponseDto } from './common/dto/health-check-response.dto';

@ApiTags('Health')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  @ApiOperation({ summary: 'System health check' })
  async getHealth(): Promise<HealthCheckResponseDto> {
    return this.appService.getHealth();
  }
}
