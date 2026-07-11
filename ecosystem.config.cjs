module.exports = {
  apps: [
    {
      name: 'webapp',
      script: 'npx',
      args: 'wrangler pages dev dist --ip 0.0.0.0 --port 3000',
      interpreter: process.env.HOME + '/.nvm/versions/node/v22.23.1/bin/node',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        NVM_DIR: process.env.HOME + '/.nvm',
        PATH: process.env.HOME + '/.nvm/versions/node/v22.23.1/bin:' + process.env.PATH
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
}
