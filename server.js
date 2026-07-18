const { createApp } = require('./src/app');

const port = Number(process.env.PORT || 8787);
const app = createApp();

app.server.listen(port, '127.0.0.1', () => {
  console.log(`agent server listening on http://127.0.0.1:${port}`);
});
