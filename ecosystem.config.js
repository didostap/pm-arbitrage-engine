// pm2 process manager config — no secrets, safe to commit
module.exports = {
  apps: [
    {
      name: 'pm-arbitrage-engine',
      script: 'dist/src/main.js',
      node_args: '-r dotenv/config', // Load .env via dotenv before NestJS starts
      env: {
        NODE_ENV: 'production',
        DOTENV_CONFIG_PATH: '.env', // dotenv reads this file
      },
      max_restarts: 10,
      restart_delay: 5000,
      min_uptime: '10s', // NestJS needs time to initialize; don't count fast exits as "started"
      kill_timeout: 5000, // Allow 5s for graceful shutdown (SIGTERM → cleanup → exit)
      max_memory_restart: '1G', // Restart if memory exceeds 1GB (leak protection)
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};
