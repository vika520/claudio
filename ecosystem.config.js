module.exports = {
  apps: [{
    name: 'claudio',
    script: './scripts/start.js',
    cwd: '/www/wwwroot/claudio',
    env: {
      NODE_ENV: 'production',
      PORT: 3002
    },
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    log_file: '/www/wwwlogs/claudio-combined.log',
    out_file: '/www/wwwlogs/claudio-out.log',
    error_file: '/www/wwwlogs/claudio-error.log',
    time: true
  }]
};
