'use strict';
// Entry point only: read config, build the app, start listening. All logic lives in /src.
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const config = require('./src/config');
const { createApp } = require('./src/app');

const app = createApp(config);

let server;
if (config.tls.keyFile && config.tls.certFile) {
  // Option A: Node terminates TLS itself.
  server = https.createServer(
    { key: fs.readFileSync(config.tls.keyFile), cert: fs.readFileSync(config.tls.certFile), minVersion: 'TLSv1.2' },
    app.handle
  );
} else {
  // Option B (recommended): plain HTTP on 127.0.0.1 behind nginx/Caddy which terminates TLS.
  // Set TRUST_PROXY=true so HTTPS is detected from X-Forwarded-Proto and HTTP gets redirected.
  if (config.isProd && !config.trustProxy) {
    console.error('Refusing to start: production needs TLS_KEY_FILE/TLS_CERT_FILE or TRUST_PROXY=true behind an HTTPS proxy.');
    process.exit(1);
  }
  server = http.createServer(app.handle);
}

// Basic slow-client protection.
server.headersTimeout = 15_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 5_000;

server.listen(config.port, config.host, () => {
  const scheme = server instanceof https.Server ? 'https' : 'http';
  console.log(`Listening on ${scheme}://${config.host}:${config.port} (${config.env})`);
});

function shutdown() {
  server.close(() => {
    app.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
