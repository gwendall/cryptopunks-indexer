module.exports = {
  apps: [
    {
      name: 'punks-indexer',
      script: 'node',
      args: ['--import', 'tsx', 'src/server.ts'],
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      time: true,
      out_file: 'data/pm2-out.log',
      error_file: 'data/pm2-err.log',
    },
  ],
};

