import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PersistenceModule } from './common/persistence.module';
import { ConnectorModule } from './connectors/connector.module';
import { CoreModule } from './core/core.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: `.env.${process.env.NODE_ENV || 'development'}`,
    }),
    PersistenceModule,
    CoreModule,
    ConnectorModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
