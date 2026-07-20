import { createAdapterServer } from './server.js';

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const token = env('CFL_TEMPLATE_TOKEN');
const portRaw = process.env.CFL_TEMPLATE_PORT;
const port = portRaw !== undefined ? Number(portRaw) : 4103;
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('CFL_TEMPLATE_PORT must be a valid port number');
}

const server = await createAdapterServer({ token });

try {
  await server.listen({ port, host: '127.0.0.1' });
  console.error(`template adapter listening on http://127.0.0.1:${port}`);
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
