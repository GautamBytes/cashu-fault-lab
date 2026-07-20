import { emptyOracleModel, assertSafety } from '@cashu-fault-lab/oracle';
const model = emptyOracleModel();
assertSafety(model);
console.log('consumer OK');
