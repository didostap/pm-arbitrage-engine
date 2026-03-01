import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('/health (GET)', async () => {
    const result = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(result.statusCode).toBe(200);

    const payload = JSON.parse(result.payload) as {
      data: { status: string; service: string };
      timestamp: string;
    };
    expect(payload).toHaveProperty('data');
    expect(payload.data).toEqual({
      status: 'ok',
      service: 'pm-arbitrage-engine',
    });
    expect(payload).toHaveProperty('timestamp');
    expect(typeof payload.timestamp).toBe('string');
  });
});
