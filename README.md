# PM Arbitrage Engine

NestJS-based trading engine for prediction market arbitrage detection and execution.

## Prerequisites

- Node.js LTS
- pnpm 8+
- Docker & Docker Compose

## Quick Start

### Local Development

1. **Install dependencies**
   ```bash
   pnpm install
   ```

2. **Start PostgreSQL** (Docker)
   ```bash
   docker-compose -f docker-compose.dev.yml up -d
   ```

3. **Run database migrations**
   ```bash
   pnpm prisma migrate dev
   ```

4. **Start the development server**
   ```bash
   pnpm start:dev
   ```

5. **Verify health endpoint**
   ```bash
   curl http://localhost:8080/api/health
   ```

   Expected response:
   ```json
   {
     "data": { "status": "ok" },
     "timestamp": "2026-02-11T10:30:00.000Z"
   }
   ```

### Full Stack (Docker)

```bash
docker-compose up
```

Access the engine at `http://localhost:8080/api/health`

## Project Structure

```
src/
├── modules/          # Feature modules (5 core modules)
│   ├── data-ingestion/
│   ├── arbitrage-detection/
│   ├── execution/
│   ├── risk-management/
│   └── monitoring/
├── connectors/       # Platform integrations
│   ├── kalshi/
│   └── polymarket/
├── common/           # Shared cross-cutting code
│   ├── interfaces/
│   ├── errors/
│   ├── events/
│   └── config/
├── core/             # Engine lifecycle, scheduler
├── main.ts
└── app.module.ts
```

## Available Scripts

```bash
# Development
pnpm start:dev        # Start with hot reload
pnpm build            # Build for production
pnpm start:prod       # Run production build

# Testing
pnpm test             # Run unit tests
pnpm test:watch       # Run tests in watch mode
pnpm test:cov         # Run tests with coverage

# Code Quality
pnpm lint             # Lint and fix code
pnpm format           # Format code with Prettier

# Database
pnpm prisma migrate dev    # Run migrations
pnpm prisma generate       # Generate Prisma client
pnpm prisma studio         # Open Prisma Studio
```

## Environment Variables

Copy `.env.example` to `.env.development` and configure:

```env
NODE_ENV=development
PORT=8080
DATABASE_URL="postgresql://postgres:password@localhost:5433/pmarbitrage?schema=public"
```

**Note:** PostgreSQL uses port `5433` on the **host machine** to avoid conflicts with local PostgreSQL installations (which typically use port 5432). Docker Compose maps host port `5433` to container port `5432` internally. When connecting from your local machine, use port `5433`. When connecting from inside Docker (e.g., the engine container), use port `5432` with hostname `postgres`.

## Technology Stack

| Layer      | Technology       | Version       |
| ---------- | ---------------- | ------------- |
| Language   | TypeScript       | 5.x (strict)  |
| Runtime    | Node.js          | LTS           |
| Framework  | NestJS + Fastify | 11.x / 11.1.x |
| ORM        | Prisma           | 6.x           |
| Database   | PostgreSQL       | 16+           |
| Blockchain | viem             | Latest stable |
| Testing    | Vitest           | 4.x           |

## Development Notes

- **Fastify** is used instead of Express for 2-3x performance improvement
- **Vitest** with SWC for fast test execution and decorator support
- **Strict TypeScript** configuration enabled
- Tests co-located with source files (`*.spec.ts`)
- Docker Compose for local PostgreSQL and full-stack deployment

## License

UNLICENSED
