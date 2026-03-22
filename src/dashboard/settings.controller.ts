/**
 * Story 10-5.2 AC1-3 — Settings CRUD endpoints.
 *
 * GET  /api/dashboard/settings        → all settings grouped by section
 * PATCH /api/dashboard/settings       → partial update with validation + hot-reload
 * POST /api/dashboard/settings/reset  → reset specific or all keys to NULL
 */
import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthTokenGuard } from '../common/guards/auth-token.guard';
import { SettingsService, type GroupedSettings } from './settings.service.js';
import { UpdateSettingsDto } from './dto/update-settings.dto.js';
import { ResetSettingsDto } from './dto/reset-settings.dto.js';

@Controller('dashboard/settings')
@UseGuards(AuthTokenGuard)
@ApiTags('Settings')
@ApiBearerAuth()
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get all settings grouped by section' })
  @ApiResponse({ status: 200, description: 'Settings grouped by 15 sections' })
  async getSettings(): Promise<{
    data: GroupedSettings;
    timestamp: string;
  }> {
    const data = await this.settingsService.getSettings();
    return { data, timestamp: new Date().toISOString() };
  }

  @Patch()
  @ApiOperation({
    summary: 'Partial update of settings with validation + hot-reload',
  })
  @ApiResponse({
    status: 200,
    description: 'Updated settings grouped by section',
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async updateSettings(
    @Body(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: UpdateSettingsDto,
  ): Promise<{ data: GroupedSettings; timestamp: string }> {
    const data = await this.settingsService.updateSettings(
      dto as unknown as Record<string, unknown>,
      'dashboard',
    );
    return { data, timestamp: new Date().toISOString() };
  }

  @Post('reset')
  @ApiOperation({ summary: 'Reset specific or all settings to env defaults' })
  @ApiResponse({ status: 200, description: 'Settings after reset' })
  @ApiResponse({ status: 400, description: 'Invalid keys' })
  async resetSettings(
    @Body(new ValidationPipe({ whitelist: true })) dto: ResetSettingsDto,
  ): Promise<{ data: GroupedSettings; timestamp: string }> {
    const data = await this.settingsService.resetSettings(
      dto.keys,
      'dashboard',
    );
    return { data, timestamp: new Date().toISOString() };
  }
}
