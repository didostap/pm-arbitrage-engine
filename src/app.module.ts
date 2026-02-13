import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PersistenceModule } from './common/persistence.module';
import { ConnectorModule } from './connectors/connector.module';
import { CoreModule } from './core/core.module';
import { DataIngestionModule } from './modules/data-ingestion/data-ingestion.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: `.env.${process.env.NODE_ENV || 'development'}`,
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(), // NEW - for @Cron decorators in PlatformHealthService
    PersistenceModule,
    CoreModule,
    ConnectorModule,
    DataIngestionModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
