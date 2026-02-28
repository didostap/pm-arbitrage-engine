# Deployment Runbook — PM Arbitrage Engine (Paper Trading)

This runbook covers end-to-end deployment of the PM Arbitrage Engine on a Hetzner VPS for paper trading validation. The engine runs natively via pm2; PostgreSQL runs in Docker.

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
