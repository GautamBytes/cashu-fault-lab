import { HttpPaymentTransport } from '../dist/index.js';
const transport = new HttpPaymentTransport({ timeoutMs: 100 });
if (typeof transport.send !== 'function') process.exit(1);
console.log('reference-sender consumer OK');
