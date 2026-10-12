import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Order {
  id: string; orderNumber: string; description: string; amount: string; currency: string;
  orderStatus: string; paymentId: string | null; paymentFlow: string | null;
  paymentStatus: string | null; qrExpiresAt: string | null; webhookReceivedAt: string | null;
  idempotencyKey: string | null; paymentResponse: string | null; createdAt: string; updatedAt: string;
}
export const finalStatuses = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED', 'PARTIALLY_REFUNDED'];
export function openDb(url: string) {
  if (url !== ':memory:' && !url.startsWith('file:')) throw new Error('DATABASE_URL must be file:...');
  const path = url === ':memory:' ? url : resolve(url.slice(5));
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS OrderRecord (
    id TEXT PRIMARY KEY, orderNumber TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
    amount TEXT NOT NULL, currency TEXT NOT NULL, orderStatus TEXT NOT NULL DEFAULT 'PENDING',
    paymentId TEXT UNIQUE, paymentFlow TEXT, paymentStatus TEXT, qrExpiresAt TEXT,
    webhookReceivedAt TEXT, idempotencyKey TEXT, paymentResponse TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ProcessedWebhookEvent (eventId TEXT PRIMARY KEY, processedAt TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS qr_expiry ON OrderRecord(paymentFlow, qrExpiresAt);`);
  return db;
}
export class Repository {
  constructor(readonly db: Database.Database) {}
  get(id: string) { return this.db.prepare('SELECT * FROM OrderRecord WHERE id = ?').get(id) as Order | undefined; }
  create(input: Pick<Order, 'orderNumber' | 'description' | 'amount' | 'currency'>) {
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare('INSERT INTO OrderRecord(id,orderNumber,description,amount,currency,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)')
      .run(id,input.orderNumber,input.description,input.amount,input.currency,now,now);
    return this.get(id)!;
  }
  // Synchronous SQLite transactions never span network awaits.
  apply(id: string, paymentId: string, status: string) {
    const order = this.get(id);
    if (!order || order.paymentId !== paymentId) throw new Error('Payment reference mismatch');
    if (order.paymentStatus && finalStatuses.includes(order.paymentStatus)) return;
    const merchantStatus = ({SUCCEEDED:'PAID',FAILED:'PAYMENT_FAILED',EXPIRED:'PAYMENT_FAILED',CANCELLED:'CANCELLED',REFUNDED:'PAID',PARTIALLY_REFUNDED:'PAID'} as Record<string,string>)[status] ?? 'PAYMENT_PENDING';
    this.db.prepare('UPDATE OrderRecord SET paymentStatus=?, orderStatus=?, updatedAt=? WHERE id=?')
      .run(status,merchantStatus,new Date().toISOString(),id);
  }
}
