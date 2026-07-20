import { emptyOracleModel, assertSafety } from '../dist/index.js';
const model = emptyOracleModel();
assertSafety(model);
console.log('oracle consumer OK');
