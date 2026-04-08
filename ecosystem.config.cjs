module.exports = {
  apps: [
    {
      name: 'whtspp-forwarder',
      cwd: __dirname,
      script: 'whatsapp-forwarder.js',
      interpreter: 'node',
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      min_uptime: '30s',
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
