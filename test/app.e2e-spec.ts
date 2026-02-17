import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './../src/app.module';

// Risk management env vars required by RiskManagerService.onModuleInit
process.env.RISK_BANKROLL_USD = '10000';
process.env.RISK_MAX_POSITION_PCT = '0.03';
process.env.RISK_MAX_OPEN_PAIRS = '10';

describe('AppController (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
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
      data: { status: string };
      timestamp: string;
    };
    expect(payload).toHaveProperty('data');
    expect(payload.data).toEqual({ status: 'ok' });
    expect(payload).toHaveProperty('timestamp');
    expect(typeof payload.timestamp).toBe('string');
  });
});
