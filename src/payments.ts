import type { PaymentsClient, PaymentFlow, WebhookEvent } from '@tharabagate/sdk';
import { Repository, finalStatuses } from './db.js';
import { randomUUID } from 'node:crypto';

export class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
// The SDK documents bank-local yyyy-MM-dd HH:mm:ss. Myanmar is UTC+06:30.
export function qrExpiry(value?: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new Error('Unexpected SDK QR expiry format');
  const date = new Date(value.replace(' ', 'T') + '+06:30');
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid QR expiry');
  return date.toISOString();
}
export class PaymentService {
  constructor(readonly repo: Repository, readonly sdk: PaymentsClient, readonly baseUrl: string) {}
  async create(id: string, flow: PaymentFlow) {
    const order = this.repo.db.transaction(() => {
      const current = this.repo.get(id);
      if (!current) throw new HttpError(404,'Order not found');
      if (current.paymentFlow && current.paymentFlow !== flow) throw new HttpError(409,'Order already reserved for another payment flow');
      if (!current.idempotencyKey) this.repo.db.prepare('UPDATE OrderRecord SET paymentFlow=?,idempotencyKey=?,updatedAt=? WHERE id=?')
        .run(flow,randomUUID(),new Date().toISOString(),id);
      return this.repo.get(id)!;
    }).immediate();
    if (order.paymentResponse) return JSON.parse(order.paymentResponse);
    const result = await this.sdk.create({paymentFlow:flow,merchantOrderId:order.orderNumber,amount:order.amount,currency:order.currency,
      description:order.description,...(flow === 'HOSTED' ? {redirectUrl:`${this.baseUrl}/payment/result?orderId=${encodeURIComponent(id)}`} : {})},
      {idempotencyKey:order.idempotencyKey!});
    if (result.paymentFlow !== flow) throw new Error('Unexpected SDK payment flow');
    this.repo.db.transaction(() => {
      const current = this.repo.get(id)!;
      if (current.paymentId && current.paymentId !== result.paymentId) throw new Error('Idempotency returned another payment');
      this.repo.db.prepare('UPDATE OrderRecord SET paymentId=?,paymentResponse=?,qrExpiresAt=? WHERE id=?')
        .run(result.paymentId,JSON.stringify(result),result.paymentFlow === 'DIRECT_QR' ? qrExpiry(result.expiresAt) : null,id);
      this.repo.apply(id,result.paymentId,result.status);
    }).immediate();
    return result;
  }
  async refresh(id: string) {
    const order = this.repo.get(id);
    if (!order) throw new HttpError(404,'Order not found');
    if (!order.paymentId) throw new HttpError(409,'Order has no payment');
    const payment = await this.sdk.get(order.paymentId);
    if (payment.paymentId !== order.paymentId) throw new Error('SDK payment reference mismatch');
    this.repo.db.transaction(() => this.repo.apply(id,payment.paymentId,payment.status)).immediate();
    return this.repo.get(id)!;
  }
  webhook(event: WebhookEvent) {
    return this.repo.db.transaction(() => {
      if (this.repo.db.prepare('SELECT 1 FROM ProcessedWebhookEvent WHERE eventId=?').get(event.id)) return;
      const order = this.repo.db.prepare('SELECT * FROM OrderRecord WHERE paymentId=? OR orderNumber=?')
        .get(event.data.paymentId ?? '',event.data.merchantOrderId ?? '') as ReturnType<Repository['get']>;
      // Retry after creation persists the reference; never acknowledge an event we could lose.
      if (!order?.paymentId) throw new HttpError(503,'Payment not yet associated; retry delivery');
      if (!event.data.paymentId || event.data.paymentId !== order.paymentId || !event.data.status ||
          (event.data.merchantOrderId && event.data.merchantOrderId !== order.orderNumber) ||
          (event.data.currency && event.data.currency !== order.currency)) throw new HttpError(422,'Webhook payment mismatch');
      this.repo.apply(order.id,event.data.paymentId,event.data.status);
      const now = new Date().toISOString();
      this.repo.db.prepare('UPDATE OrderRecord SET webhookReceivedAt=? WHERE id=?').run(now,order.id);
      this.repo.db.prepare('INSERT INTO ProcessedWebhookEvent(eventId,processedAt) VALUES (?,?)').run(event.id,now);
    }).immediate();
  }
  async recoverExpired(now = new Date()) {
    const orders = this.repo.db.prepare(`SELECT * FROM OrderRecord WHERE paymentFlow='DIRECT_QR' AND paymentId IS NOT NULL AND qrExpiresAt<=?
      AND paymentStatus NOT IN ('SUCCEEDED','FAILED','CANCELLED','EXPIRED','REFUNDED','PARTIALLY_REFUNDED')`)
      .all(now.toISOString()) as NonNullable<ReturnType<Repository['get']>>[];
    for (const order of orders) {
      if (order.paymentStatus && finalStatuses.includes(order.paymentStatus)) continue;
      try { await this.refresh(order.id); } catch { console.error('QR recovery failed for order',order.id); }
    }
  }
}
