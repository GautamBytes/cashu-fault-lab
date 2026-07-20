import { MemoryReceiverStore, CashuTsMintGateway } from '../dist/index.js';
const store = new MemoryReceiverStore();
if (typeof store.preflight !== 'function') process.exit(1);
console.log('reference-receiver consumer OK');
