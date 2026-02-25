import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { bufferLogs: true },
  );

  // Replace default NestJS logger with nestjs-pino
  app.useLogger(app.get(PinoLogger));

  app.setGlobalPrefix('api');

  // Swagger/OpenAPI setup
  const swaggerConfig = new DocumentBuilder()
    .setTitle('PM Arbitrage Engine')
    .setDescription('Cross-platform prediction market arbitrage system')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  // Bind to 0.0.0.0 in development (required for Docker container networking)
  // Production uses 127.0.0.1:8080 per architecture (localhost-only with SSH tunnel)
  const host = process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0';
  const port = process.env.PORT || 8080;

  await app.listen(port, host);

  const logger = new Logger('Bootstrap');
  logger.log(`Application is running on: http://${host}:${port}`);
}

void bootstrap();
