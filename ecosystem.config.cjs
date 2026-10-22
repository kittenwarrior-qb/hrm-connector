// pm2 start ecosystem.config.cjs
// Chạy 1 instance (fork) vì scheduler nằm trong process — chạy cluster sẽ sync trùng.
module.exports = {
  apps: [
    {
      name: 'hrm-connector',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      kill_timeout: 10000,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
