import { Connector } from './connector.js';

const connector = new Connector();

void connector.start().catch(error => {
  console.error(error instanceof Error ? `Connector startup failed: ${error.message}` : 'Connector startup failed');
  process.exitCode = 1;
});

async function stop(signal: string): Promise<void> {
  console.log(`${signal} received; stopping connector`);
  await connector.stop();
  process.exit(0);
}

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));
