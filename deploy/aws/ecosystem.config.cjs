// PM2 process definition for the API on the Lightsail server.
//   pm2 start deploy/aws/ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: "tender-api",
      cwd: __dirname + "/../../server",
      script: "src/index.js",
      // Never watch files in production: a restart kills any extraction
      // call in flight (billed, result lost).
      watch: false,
      max_memory_restart: "1500M",
      env: { NODE_ENV: "production" },
    },
  ],
};
