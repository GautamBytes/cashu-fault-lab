import { buildCashuTsAdapterServer } from '../dist/index.js';
const server = await buildCashuTsAdapterServer();
await server.ready();
await server.close();
console.log('cashu-ts adapter consumer OK');
