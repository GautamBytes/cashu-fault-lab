import { buildCashuTsAdapterServer } from '../dist/index.js';
const server = await buildCashuTsAdapterServer({
  testMode: true,
  now: () => Math.floor(Date.now() / 1000),
});
await server.ready();
await server.close();
console.log('cashu-ts adapter consumer OK');
