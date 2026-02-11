import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  app.setGlobalPrefix('api');

  // Bind to 0.0.0.0 in development (required for Docker container networking)
  // Production uses 127.0.0.1:8080 per architecture (localhost-only with SSH tunnel)
  const host = process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0';
  const port = process.env.PORT || 8080;

  await app.listen(port, host);
  console.log(`Application is running on: http://${host}:${port}`);
}

void bootstrap();
