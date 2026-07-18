const http = require('node:http');

const port = Number(process.env.PORT || 8787);

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('agent.e1x8.xyz is online\n');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`agent server listening on http://127.0.0.1:${port}`);
});
