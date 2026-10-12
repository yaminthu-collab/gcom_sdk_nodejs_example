import { TharabaGate } from '@tharabagate/sdk';
import { config } from './config.js';
import { openDb, Repository } from './db.js';
import { PaymentService } from './payments.js';
import { createApp } from './app.js';
const settings = config();
// One reusable SDK instance. TEST currently requires an explicit verified baseUrl.
const client = new TharabaGate({apiKey:settings.apiKey,environment:'TEST',baseUrl:settings.apiBaseUrl});
const db = openDb(settings.databaseUrl);
const service = new PaymentService(new Repository(db),client.payments,settings.baseUrl);
const server = createApp(service,settings.secret).listen(settings.port,() => console.log(`Merchant example listening on ${settings.baseUrl}`));
let running = false;
const timer = setInterval(async () => {
  if (running) return;
  running = true;
  try { await service.recoverExpired(); } finally { running = false; }
},60_000);
timer.unref();
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,() => {
  clearInterval(timer);
  server.close(() => { if (!running) db.close(); });
});
