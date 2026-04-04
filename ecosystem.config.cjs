// pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'Nodelink',
      script: 'npm',
      args: ['run', 'start'],
      cwd: __dirname
    }
  ]
}
