# Deployment Runbook — PM Arbitrage System (Paper Trading)

This runbook covers end-to-end deployment of the PM Arbitrage Engine and Dashboard on a Hetzner VPS for paper trading validation. The engine runs natively via pm2; PostgreSQL and the dashboard run in Docker.

**Audience:** Operator (Arbi).
**Scope:** Paper trading validation (7+ days continuous operation against live market data).

---

## Table of Contents

1. [VPS Provisioning](#1-vps-provisioning)
2. [Runtime Environment Setup](#2-runtime-environment-setup)
3. [Repository Clone & Build](#3-repository-clone--build)
4. [Database Setup](#4-database-setup)
5. [Environment Configuration](#5-environment-configuration)
6. [Process Management (pm2)](#6-process-management-pm2)
7. [Backup Configuration](#7-backup-configuration)
8. [Verification Checklist](#8-verification-checklist)
9. [Telegram Alert Verification](#9-telegram-alert-verification)
10. [SSH Tunnel Access](#10-ssh-tunnel-access)
11. [Troubleshooting](#11-troubleshooting)
12. [Dashboard Deployment](#12-dashboard-deployment)

---

## 1. VPS Provisioning

### Server Specification

| Spec     | Value                   | Rationale                           |
| -------- | ----------------------- | ----------------------------------- |
| Provider | Hetzner                 | EU-based, cost-effective            |
| Plan     | CX22                    | 2 vCPU, 4 GB RAM, 40 GB SSD         |
| OS       | Ubuntu 24.04 LTS        | LTS support through 2029            |
| Location | Falkenstein or Helsinki | Lowest cost; see latency note below |

**Latency note:** Hetzner EU data centers add ~100-150ms to US-based Kalshi/Polymarket APIs. This is acceptable for paper trading validation where detection accuracy is not critically time-sensitive. For live trading, consider Hetzner Ashburn (US) or measure actual latency from VPS to both APIs.

### Hetzner Setup Steps

1. Create a Hetzner Cloud account at <https://console.hetzner.cloud>
2. Navigate to **Servers → Add Server**
3. Select:
   - **Location:** Falkenstein (or your preference)
   - **Image:** Ubuntu 24.04
   - **Type:** CX22 (Shared vCPU, 2 vCPU / 4 GB / 40 GB SSD)
   - **SSH keys:** Upload your public key (`~/.ssh/id_ed25519.pub`)
   - **Networking:** Public IPv4 enabled
   - **Name:** `pm-arbitrage-paper`
4. Click **Create & Buy Now**
5. Note the assigned IP address

### Initial SSH Access

```bash
ssh root@<VPS_IP>
```

### Firewall Configuration

```bash
sudo apt update && sudo apt install -y ufw
sudo ufw allow OpenSSH
sudo ufw enable
sudo ufw status
# Expected: Status: active, OpenSSH ALLOW Anywhere
```

This blocks ALL inbound traffic except SSH (port 22). The engine binds to `127.0.0.1:8080` and is only accessible via SSH tunnel.

### Disable Password Authentication

Edit `/etc/ssh/sshd_config`:

```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd
```

Verify: `grep PasswordAuthentication /etc/ssh/sshd_config` should show `PasswordAuthentication no`.

---

## 2. Runtime Environment Setup

### Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # Must show v20.x.x
```

### pnpm

```bash
sudo npm install -g pnpm
pnpm --version
```

### Docker & Docker Compose

```bash
# Install Docker
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Verify
docker --version
docker compose version
```

### Version Verification Summary

```bash
node --version          # v20.x.x
pnpm --version          # 9.x or 10.x
docker --version        # 27.x+
docker compose version  # v2.x+
```

---

## 3. Repository Clone & Build

### Git Authentication

Set up SSH key for GitHub access on the VPS:

```bash
ssh-keygen -t ed25519 -C "pm-arbitrage-vps"
cat ~/.ssh/id_ed25519.pub
# Add this key to GitHub → Settings → SSH keys
```

Alternatively, use a GitHub personal access token (PAT) for HTTPS clone.

### Clone & Build

```bash
cd /opt
git clone git@github.com:<your-org>/pm-arbitrage-engine.git
cd pm-arbitrage-engine

pnpm install --frozen-lockfile
pnpm prisma generate
pnpm build

# Verify build output exists
ls dist/src/main.js
```

---

## 4. Database Setup

The engine connects to PostgreSQL running in Docker via `docker-compose.dev.yml`. Despite the filename, this is the correct compose file for VPS deployment — it provides PostgreSQL-only (no engine container).

### Change Default Password

**CRITICAL:** Before starting PostgreSQL for the first time, change the default password.

Edit `docker-compose.dev.yml`:

```yaml
environment:
  POSTGRES_PASSWORD: <YOUR_STRONG_PASSWORD> # Change from 'password'
```

Also ensure the postgres service has restart policy:

```yaml
services:
  postgres:
    # ... existing config ...
    restart: unless-stopped # Survives VPS reboot
```

### Start PostgreSQL

```bash
docker compose -f docker-compose.dev.yml up -d

# Verify container is running
docker ps --format 'table {{.Names}}\t{{.Status}}'
# Expected: pm-arbitrage-postgres-dev   Up X seconds (healthy)
```

### Run Migrations

```bash
# Use 'migrate deploy' in production (NOT 'migrate dev')
pnpm prisma migrate deploy
```

### Verify All Tables

```bash
docker exec pm-arbitrage-postgres-dev psql -U postgres -d pmarbitrage -c '\dt' | \
  grep -E 'contract_matches|risk_states|orders|open_positions|audit_logs|order_book_snapshots|platform_health_logs|system_metadata'
```

Must show **all 8 tables**. If any are missing, migrations did not apply correctly.

---

## 5. Environment Configuration

### Create `.env.production`

```bash
cp .env.production.example .env.production
chmod 600 .env.production    # Owner-only read/write
```

Edit `.env.production` and configure:

1. **`DATABASE_URL`** — Update password to match the one set in `docker-compose.dev.yml`:

   ```
   DATABASE_URL="postgresql://postgres:<YOUR_STRONG_PASSWORD>@localhost:5433/pmarbitrage?schema=public"
   ```

2. **Platform API keys** — Set real API keys:
   - `KALSHI_API_KEY_ID` — From Kalshi sandbox dashboard
   - `KALSHI_PRIVATE_KEY_PATH` — Path to RSA private key (place in `secrets/` directory)
   - `POLYMARKET_PRIVATE_KEY` — Wallet private key for read-only/testnet

3. **Paper mode** — Verify both platforms are set to paper:

   ```
   PLATFORM_MODE_KALSHI=paper
   PLATFORM_MODE_POLYMARKET=paper
   ```

4. **Telegram** — Set bot token and chat ID:
   ```
   TELEGRAM_BOT_TOKEN=<from @BotFather>
   TELEGRAM_CHAT_ID=<your chat ID>
   ```

### Security

- `.env.production` is gitignored and must NEVER be committed
- File permissions are `600` (owner-only)
- API keys should use sandbox/testnet credentials for paper trading

---

## 6. Process Management (pm2)

### Install pm2

```bash
npm install -g pm2
pm2 --version    # Should show 5.x+
```

### Install Log Rotation (MANDATORY)

Without this, pm2 logs grow unbounded and will fill the 40 GB SSD within days.

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 7
pm2 save
```

### Start the Engine

```bash
cd /opt/pm-arbitrage-engine
pm2 start ecosystem.config.js
pm2 status    # Should show 'pm-arbitrage-engine' as 'online'
pm2 logs --lines 50    # Verify clean startup
```

### Persist Across Reboots

```bash
pm2 save                    # Save current process list
pm2 startup                 # Generate systemd startup script
# Follow the command it outputs (copy-paste the sudo line)
```

### Reboot Ordering

After VPS reboot:

1. Docker (PostgreSQL) starts via `restart: unless-stopped` — takes 10-20s to be ready
2. pm2 starts immediately via systemd — engine tries to connect to DB
3. Engine fails to connect, pm2 restarts it (`restart_delay: 5000`)
4. After 2-3 retries (~10-15s), PostgreSQL is ready, engine connects successfully
5. `max_restarts: 10` provides ample headroom

### Zero-Downtime Restart (for engine updates during validation)

```bash
cd /opt/pm-arbitrage-engine
git pull
pnpm install --frozen-lockfile
pnpm prisma generate
pnpm build
pm2 restart pm-arbitrage-engine
pm2 logs --lines 20    # Verify clean restart
```

---

## 7. Backup Configuration

### Backup Directory

```bash
mkdir -p /var/backups/pm-arbitrage/
chmod 700 /var/backups/pm-arbitrage/
```

### Install Backup Script

The backup script is included in the repository at `scripts/backup-db.sh`:

```bash
chmod +x scripts/backup-db.sh scripts/restore-db.sh
```

### Test Backup Manually

```bash
./scripts/backup-db.sh
ls -la /var/backups/pm-arbitrage/    # Should show a .sql.gz file
```

### Set Up Hourly Cron

```bash
crontab -e
```

Add the following line (adjust path to your clone location):

```
0 * * * * /opt/pm-arbitrage-engine/scripts/backup-db.sh 2>&1 | logger -t pm-arbitrage-backup
```

### Verify Backup Restore

```bash
# Get the most recent backup file
LATEST=$(ls -t /var/backups/pm-arbitrage/*.sql.gz | head -1)

# Run restore verification
./scripts/restore-db.sh "$LATEST"
# Should show row counts for all tables and report PASS
```

### Backup Log Monitoring

Check backup logs via syslog:

```bash
journalctl -t pm-arbitrage-backup --since "1 hour ago"
```

---

## 8. Verification Checklist

Run through each item after deployment:

- [x] `pm2 status` shows `pm-arbitrage-engine` as `online`
- [x] `pm2 logs --lines 50` shows clean startup (no errors, Prisma connects, platforms initialize)
- [x] SSH tunnel established: `ssh -L 8080:localhost:8080 user@<VPS_IP>`
- [x] On **LOCAL machine**: `curl http://localhost:8080/api/health` returns `{"data":{...},"timestamp":"..."}`
- [x] Telegram test alert received (see [Section 9](#9-telegram-alert-verification))
- [x] Backup script runs successfully: `./scripts/backup-db.sh`
- [x] Restore script verifies backup: `./scripts/restore-db.sh <backup-file>`
- [x] 10-minute stability observation: `pm2 logs` shows no errors for 10+ minutes
- [x] Reboot persistence: `sudo reboot`, wait 1 minute, SSH back in, `pm2 status` shows `online`

---

## 9. Telegram Alert Verification

The engine fires a daily test alert via `@Cron` at the time configured in `TELEGRAM_TEST_ALERT_CRON` (default: `0 8 * * *` = 8:00 AM UTC).

### Immediate Verification (without waiting for daily cron)

1. Edit `.env.production` — set a fast cron:

   ```
   TELEGRAM_TEST_ALERT_CRON=*/2 * * * *
   ```

2. Restart the engine:

   ```bash
   pm2 restart pm-arbitrage-engine
   ```

3. Wait up to 2 minutes — a test alert should arrive in your Telegram chat

4. **Revert** the cron to daily:

   ```
   TELEGRAM_TEST_ALERT_CRON=0 8 * * *
   ```

5. Restart again:
   ```bash
   pm2 restart pm-arbitrage-engine
   ```

---

## 10. SSH Tunnel Access

The engine binds to `127.0.0.1:8080` — it is NOT accessible from the public internet.

### Establish Tunnel

```bash
# On your LOCAL machine:
ssh -L 8080:localhost:8080 user@<VPS_IP>
```

After the tunnel is established, all access happens on your **local machine**:

```bash
# Health check
curl http://localhost:8080/api/health

# Prisma Studio (if needed for debugging)
# On VPS: cd /opt/pm-arbitrage-engine && pnpm prisma studio
# Then on LOCAL: open http://localhost:5555 in browser
```

### Persistent Tunnels

For long debugging sessions, use `autossh` for automatic reconnection:

```bash
# Install on LOCAL machine
# macOS: brew install autossh
# Linux: sudo apt install autossh

autossh -M 0 -o "ServerAliveInterval 30" -o "ServerAliveCountMax 3" -L 8080:localhost:8080 user@<VPS_IP>
```

### Security Note

Prisma Studio has **no built-in authentication**. Only access via SSH tunnel on trusted connections. Close Studio after use.

---

## 11. Troubleshooting

### Engine Won't Start / Restart Loop

**Symptom:** `pm2 status` shows `errored` or rapid restarts.

**Causes & fixes:**

- **PostgreSQL not ready:** Wait 30s after VPS boot. Check: `docker ps` — container should be `healthy`. If not: `docker compose -f docker-compose.dev.yml up -d`
- **Missing `.env.production`:** Check file exists and has correct permissions: `ls -la .env.production`
- **Bad DATABASE_URL:** Verify password matches `docker-compose.dev.yml`. Test: `docker exec pm-arbitrage-postgres-dev psql -U postgres -d pmarbitrage -c 'SELECT 1'`
- **Prisma client not generated:** Run `pnpm prisma generate && pnpm build && pm2 restart pm-arbitrage-engine`

### Port Conflict

**Symptom:** `EADDRINUSE: address already in use :::8080`

```bash
lsof -i :8080
# Kill the conflicting process, or change PORT in .env.production
```

### Prisma Migration Failure

```bash
# Check migration status
pnpm prisma migrate status

# If stuck, verify DB connectivity first
docker exec pm-arbitrage-postgres-dev psql -U postgres -d pmarbitrage -c 'SELECT 1'
```

### Docker / PostgreSQL Issues

```bash
# Container not running
docker compose -f docker-compose.dev.yml up -d

# Check container logs
docker logs pm-arbitrage-postgres-dev --tail 50

# Memory issues (check Docker resource usage)
docker stats --no-stream
```

### UFW Not Found

```bash
sudo apt update && sudo apt install -y ufw
```

### Backup Script Failure

```bash
# Check container is running
docker ps --format '{{.Names}}' | grep pm-arbitrage-postgres-dev

# Check disk space
df -h /var/backups/pm-arbitrage/

# Run manually with verbose output
bash -x scripts/backup-db.sh
```

### pm2 Logs Too Large

If logs are consuming excessive disk space:

```bash
# Check log sizes
pm2 flush    # Clear all logs (use with caution)

# Verify logrotate is installed
pm2 describe pm-arbitrage-engine | grep pm2-logrotate
```

---

## 12. Dashboard Deployment

The operator dashboard is a React SPA served by nginx in a Docker container. It proxies API and WebSocket requests to the engine and uses runtime environment injection for configuration.

### Architecture Overview

```
Browser ──SSH Tunnel──▶ VPS:3000 ──▶ Dashboard Container (nginx :80)
                                          ├── /assets/*     → static files (Vite-built, hash-named)
                                          ├── /api/*        → proxy to engine:8080
                                          ├── /ws           → WebSocket proxy to engine:8080
                                          └── /*            → SPA fallback (index.html)
```

The dashboard container communicates with the engine container via Docker's internal network (`pm-arbitrage-network`). No direct public access — only reachable via SSH tunnel.

### Prerequisites

- Engine is deployed and running (Sections 1–6 complete)
- Docker and Docker Compose installed (Section 2)
- The `pm-arbitrage-dashboard` repository is cloned alongside the engine

### Clone the Dashboard Repository

```bash
cd /opt
git clone git@github.com:<your-org>/pm-arbitrage-dashboard.git
```

The engine's `docker-compose.yml` expects the dashboard at `../pm-arbitrage-dashboard` relative to the engine directory. Verify the layout:

```bash
ls /opt/pm-arbitrage-engine/docker-compose.yml
ls /opt/pm-arbitrage-dashboard/Dockerfile
```

### Environment Variables

The dashboard uses **runtime** environment injection — not build-time Vite variables. The `entrypoint.sh` script generates `/env.js` at container startup from these environment variables:

| Variable         | Description                               | Default                 |
| ---------------- | ----------------------------------------- | ----------------------- |
| `API_URL`        | Engine API URL (from nginx's perspective) | `http://localhost:8080` |
| `WS_URL`         | Engine WebSocket URL                      | `ws://localhost:8080`   |
| `OPERATOR_TOKEN` | Bearer token for API authentication       | _(empty)_               |

In Docker Compose, these are pre-configured to use Docker's internal DNS:

```yaml
environment:
  API_URL: http://engine:8080
  WS_URL: ws://engine:8080
  OPERATOR_TOKEN: <YOUR_OPERATOR_TOKEN> # Must match engine's OPERATOR_TOKEN
```

**IMPORTANT:** The `OPERATOR_TOKEN` must match the value configured in the engine's `.env.production`. If they don't match, the dashboard will receive 401 responses.

### Build & Start with Docker Compose

The dashboard is defined in the engine's `docker-compose.yml` as the `dashboard` service. To deploy the full stack (PostgreSQL + Engine + Dashboard):

```bash
cd /opt/pm-arbitrage-engine

# Edit docker-compose.yml to set production values:
# 1. Change POSTGRES_PASSWORD from 'password'
# 2. Set OPERATOR_TOKEN on the dashboard service
# 3. Verify engine environment variables

docker compose up -d --build
```

To deploy **only the dashboard** (if the engine is already running via pm2):

```bash
cd /opt/pm-arbitrage-engine

# Start just the dashboard container
docker compose up -d --build dashboard
```

**Note:** When the engine runs via pm2 (not Docker), the nginx proxy directives (`proxy_pass http://engine:8080`) won't resolve because `engine` is a Docker network hostname. See [Standalone Dashboard Deployment](#standalone-dashboard-deployment) below for this scenario.

### Standalone Dashboard Deployment

When the engine runs natively via pm2 (the default from Section 6), the dashboard container cannot use Docker's internal DNS to reach it. Use the host network or override the proxy target.

**Option A — Run with `--network host`:**

```bash
docker build -t pm-arbitrage-dashboard /opt/pm-arbitrage-dashboard

docker run -d \
  --name pm-arbitrage-dashboard \
  --network host \
  -e API_URL=http://localhost:8080 \
  -e WS_URL=ws://localhost:8080 \
  -e OPERATOR_TOKEN=dev-token-change-me \
  --restart unless-stopped \
  pm-arbitrage-dashboard
```

With `--network host`, nginx listens on VPS port 80. The API proxy resolves `localhost:8080` to the pm2-managed engine. Adjust the nginx config if port 80 conflicts with another service.

**Option B — Override nginx proxy target:**

Create a custom nginx config that points to the host:

```bash
# On the VPS, create an override config
cat > nginx-prod.conf << 'EOF'
# Copy the contents of nginx.conf but replace:
#   proxy_pass http://engine:8080;
# with:
#   proxy_pass http://127.0.0.1:8080;
EOF

docker run -d \
  --name pm-arbitrage-dashboard \
  -p 3000:80 \
  --add-host=host.docker.internal:host-gateway \
  -v /opt/pm-arbitrage-dashboard/nginx-prod.conf:/etc/nginx/conf.d/default.conf:ro \
  -e API_URL=http://host.docker.internal:8080 \
  -e WS_URL=ws://host.docker.internal:8080 \
  -e OPERATOR_TOKEN=<YOUR_OPERATOR_TOKEN> \
  --restart unless-stopped \
  pm-arbitrage-dashboard
```

### Runtime Configuration (env.js)

The dashboard uses a two-tier config strategy:

1. **Development (local):** Vite injects `VITE_API_URL`, `VITE_WS_URL`, `VITE_OPERATOR_TOKEN` from `.env` at build time
2. **Production (Docker):** `entrypoint.sh` generates `/env.js` at container startup, injecting runtime values into `window.__ENV__`

The `index.html` loads `/env.js` before the app bundle:

```html
<script src="/env.js"></script>
```

The app reads config via `src/lib/env.ts`, which checks `window.__ENV__` first, then falls back to `import.meta.env.VITE_*` variables.

**Never cache `env.js` or `index.html`** — the nginx config already sets `Cache-Control: no-cache` for both. Vite-hashed `/assets/*` files get 1-year cache headers.

### Caching & Security Headers

The nginx config includes:

| Path          | Cache Policy                          | Rationale                                     |
| ------------- | ------------------------------------- | --------------------------------------------- |
| `/assets/*`   | `max-age=31536000, immutable`         | Vite adds content hashes to filenames         |
| `/env.js`     | `no-cache, no-store, must-revalidate` | Contains runtime config, must always be fresh |
| `/index.html` | `no-cache`                            | Entry point, must pick up new asset hashes    |

Security headers applied to all responses:

- `X-Frame-Options: DENY` — prevents clickjacking
- `X-Content-Type-Options: nosniff` — prevents MIME sniffing
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Content-Security-Policy: default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'`

The `style-src 'unsafe-inline'` is required because shadcn/ui (Radix primitives) injects inline styles for positioning and animations.

### UFW Firewall Update

If you want the dashboard accessible only via SSH tunnel (recommended for paper trading):

```bash
# No changes needed — UFW already blocks all ports except SSH (Section 1)
# Access via SSH tunnel:
ssh -L 3000:localhost:3000 -L 8080:localhost:8080 user@<VPS_IP>
```

On your **local machine**, open `http://localhost:3000` in a browser.

### Updating the Dashboard

```bash
cd /opt/pm-arbitrage-dashboard
git pull

cd /opt/pm-arbitrage-engine
docker compose up -d --build dashboard
```

Or if running standalone:

```bash
cd /opt/pm-arbitrage-dashboard
git pull
docker build -t pm-arbitrage-dashboard .
docker stop pm-arbitrage-dashboard && docker rm pm-arbitrage-dashboard
# Re-run the docker run command from above
```

### Verification

```bash
# Check container is running
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep dashboard
# Expected: pm-arbitrage-dashboard   Up X seconds (healthy)   0.0.0.0:3000->80/tcp

# Check env.js was generated
docker exec pm-arbitrage-dashboard cat /usr/share/nginx/html/env.js
# Should show window.__ENV__ with your configured values

# Check nginx is serving (from VPS)
curl -s http://localhost:3000/ | head -5
# Should return HTML with <title>PM Arbitrage Dashboard</title>

# Check API proxy (from VPS)
curl -s http://localhost:3000/api/health
# Should return engine health response (same as localhost:8080/api/health)

# Via SSH tunnel (from LOCAL machine)
ssh -L 5000:localhost:5000 user@<VPS_IP>
# Then open http://localhost:3000 in your browser
```

### Dashboard Troubleshooting

#### Container Won't Start

```bash
# Check build logs
docker compose logs dashboard

# Rebuild from scratch
docker compose build --no-cache dashboard
docker compose up -d dashboard
```

#### 502 Bad Gateway on /api/ Requests

The dashboard can't reach the engine. Check:

```bash
# Is the engine running?
pm2 status                    # If using pm2
docker ps | grep engine       # If using Docker Compose

# Is the engine healthy?
curl http://localhost:8080/api/health

# Check nginx error logs
docker exec pm-arbitrage-dashboard cat /var/log/nginx/error.log | tail -20
```

If the engine runs via pm2, ensure you're using the standalone deployment method (Option A or B above) — the default `docker-compose.yml` nginx config uses `http://engine:8080` which only resolves within Docker's network.

#### 401 Unauthorized

Token mismatch between dashboard and engine:

```bash
# Check what token the dashboard is using
docker exec pm-arbitrage-dashboard cat /usr/share/nginx/html/env.js

# Compare with engine's token
grep OPERATOR_TOKEN /opt/pm-arbitrage-engine/.env.production
```

Both must match. Update the dashboard's `OPERATOR_TOKEN` environment variable and restart:

```bash
docker compose up -d dashboard
# Or re-run docker run with the correct -e OPERATOR_TOKEN=...
```

#### Blank Page / Assets Not Loading

```bash
# Check if the build succeeded
docker exec pm-arbitrage-dashboard ls /usr/share/nginx/html/assets/

# Check browser console for CSP violations (via SSH tunnel + browser DevTools)
# If CSP blocks resources, review the Content-Security-Policy header in nginx.conf
```

#### WebSocket Connection Fails

```bash
# Verify WebSocket proxy works
# Install wscat: npm install -g wscat
wscat -c ws://localhost:3000/ws
# Should connect (or return a protocol error if the engine expects specific subprotocols)

# Check nginx WebSocket config
docker exec pm-arbitrage-dashboard cat /etc/nginx/conf.d/default.conf | grep -A5 "location /ws"
```

### Resource Limits

The `docker-compose.yml` constrains the dashboard container to **128 MB RAM** and **0.25 CPU**. This is generous for a static file server. If the container is OOM-killed:

```bash
# Check if it was killed
docker inspect pm-arbitrage-dashboard --format '{{.State.OOMKilled}}'

# Increase limit in docker-compose.yml if needed
deploy:
  resources:
    limits:
      memory: 256M
```
