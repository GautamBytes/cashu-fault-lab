import { HttpFaultGateway } from '../dist/index.js';
const gateway = new HttpFaultGateway({ downstream: 'http://127.0.0.1:9999' });
await gateway.close();
console.log('http-fault-gateway consumer OK');
