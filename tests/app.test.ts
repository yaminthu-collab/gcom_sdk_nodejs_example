import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { InvalidWebhookSignatureError, type PaymentsClient, type WebhookEvent } from '@tharabagate/sdk';
import { openDb, Repository } from '../src/db.js';
import { PaymentService, qrExpiry } from '../src/payments.js';
import { createApp } from '../src/app.js';

describe('merchant integration',() => {
  let repo: Repository, service: PaymentService;
  const sdk = {create:vi.fn(),get:vi.fn()} satisfies PaymentsClient;
  const event: WebhookEvent = {id:'evt-1',type:'payment.succeeded',createdAt:'2026-01-01T00:00:00Z',data:{paymentId:'pay-1',merchantOrderId:'ORDER-1',status:'SUCCEEDED'}};
  beforeEach(() => {
    vi.resetAllMocks(); repo = new Repository(openDb(':memory:'));
    service = new PaymentService(repo,sdk,'http://localhost:3000');
  });
  afterEach(() => repo.db.close());
  function order() { return repo.create({orderNumber:'ORDER-1',description:'Demo',amount:'10000.00',currency:'MMK'}); }
  async function payment(flow: 'HOSTED' | 'DIRECT_QR' = 'DIRECT_QR') {
    const item = order();
    sdk.create.mockResolvedValue({paymentId:'pay-1',paymentFlow:flow,status:'PENDING',...(flow === 'HOSTED' ? {checkoutUrl:'https://example.com/checkout'} : {qrPayload:'bank-payload',expiresAt:'2020-01-01 12:00:00'})});
    await service.create(item.id,flow); return item;
  }
  it.each(['HOSTED','DIRECT_QR'] as const)('creates %s and persists reference and idempotency',async flow => {
    const item = await payment(flow);
    expect(repo.get(item.id)).toMatchObject({paymentId:'pay-1',paymentFlow:flow,paymentStatus:'PENDING',orderStatus:'PAYMENT_PENDING'});
    const first = sdk.create.mock.calls[0];
    expect(first[0]).toMatchObject({amount:'10000.00',merchantOrderId:'ORDER-1',paymentFlow:flow});
    expect(first[1].idempotencyKey).toBe(repo.get(item.id)!.idempotencyKey);
    await service.create(item.id,flow); expect(sdk.create).toHaveBeenCalledTimes(1);
  });
  it('keeps the persisted key across ambiguous creation failures',async () => {
    const item = order(); sdk.create.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.create(item.id,'HOSTED')).rejects.toThrow();
    sdk.create.mockResolvedValue({paymentId:'pay-1',paymentFlow:'HOSTED',status:'PENDING'});
    await service.create(item.id,'HOSTED');
    expect(sdk.create.mock.calls[0]).toEqual(sdk.create.mock.calls[1]);
  });
  it('verifies raw bytes and handles valid duplicate webhooks atomically',async () => {
    const item = await payment(); const verify = vi.fn(() => event);
    const app = createApp(service,'secret',verify);
    for (let i=0;i<2;i++) await request(app).post('/webhooks/tharabagate').set('Content-Type','application/json').send('{ "signed": true }').expect(200);
    expect(Buffer.isBuffer(verify.mock.calls[0][0]?.payload)).toBe(true);
    expect(repo.get(item.id)!.orderStatus).toBe('PAID');
    expect(repo.db.prepare('SELECT count(*) AS n FROM ProcessedWebhookEvent').get()).toEqual({n:1});
  });
  it('rejects invalid signature through the real SDK verifier',async () => {
    await request(createApp(service,'secret')).post('/webhooks/tharabagate').send({id:'invalid'}).expect(401);
    expect(repo.db.prepare('SELECT count(*) AS n FROM ProcessedWebhookEvent').get()).toEqual({n:0});
  });
  it('maps verifier signature failures to 401',async () => {
    const verify = () => { throw new InvalidWebhookSignatureError('invalid'); };
    await request(createApp(service,'secret',verify)).post('/webhooks/tharabagate').send({}).expect(401);
  });
  it('recovers expired QR without webhook using SDK Get Payment',async () => {
    const item = await payment(); sdk.get.mockResolvedValue({paymentId:'pay-1',status:'SUCCEEDED'});
    await service.recoverExpired(); expect(sdk.get).toHaveBeenCalledWith('pay-1');
    expect(repo.get(item.id)!.orderStatus).toBe('PAID');
    await service.recoverExpired(); expect(sdk.get).toHaveBeenCalledTimes(1);
  });
  it('skips active QR and hosted payments',async () => {
    const item = await payment(); repo.db.prepare('UPDATE OrderRecord SET qrExpiresAt=? WHERE id=?').run('2099-01-01T00:00:00.000Z',item.id);
    await service.recoverExpired(); expect(sdk.get).not.toHaveBeenCalled();
    repo.db.prepare("UPDATE OrderRecord SET paymentFlow='HOSTED',qrExpiresAt='2020-01-01T00:00:00.000Z'").run();
    await service.recoverExpired(); expect(sdk.get).not.toHaveBeenCalled();
  });
  it('does not regress when webhook wins a fallback race',async () => {
    const item = await payment();
    sdk.get.mockImplementation(async () => { service.webhook(event); return {paymentId:'pay-1',status:'PENDING'}; });
    await service.recoverExpired(); expect(repo.get(item.id)!.paymentStatus).toBe('SUCCEEDED');
  });
  it('does not regress when fallback wins',async () => {
    const item = await payment(); sdk.get.mockResolvedValue({paymentId:'pay-1',status:'SUCCEEDED'});
    await service.recoverExpired(); service.webhook({...event,data:{...event.data,status:'PENDING'}});
    expect(repo.get(item.id)!.orderStatus).toBe('PAID');
  });
  it('return navigation alone never marks paid',async () => {
    const item = await payment('HOSTED');
    await request(createApp(service,'secret')).get(`/payment/result?orderId=${item.id}`).expect(200).expect(({body}) => expect(body.orderStatus).toBe('PAYMENT_PENDING'));
    expect(sdk.get).not.toHaveBeenCalled();
  });
  it('offers create/get/refresh endpoints and validates string money',async () => {
    const app = createApp(service,'secret');
    await request(app).post('/api/orders').send({orderNumber:'bad',description:'',amount:10,currency:'MMK'}).expect(400);
    const item = await payment(); sdk.get.mockResolvedValue({paymentId:'pay-1',status:'SUCCEEDED'});
    await request(app).get(`/api/orders/${item.id}`).expect(200);
    await request(app).post(`/api/orders/${item.id}/payments/refresh`).expect(200).expect(({body}) => expect(body.orderStatus).toBe('PAID'));
  });
  it.each([['hosted','HOSTED'],['qr','DIRECT_QR']] as const)('serves the %s creation route',async (path,flow) => {
    const app = createApp(service,'secret');
    const response = await request(app).post('/api/orders').send({orderNumber:'ORDER-1',description:'Demo',amount:'10000.00',currency:'MMK'}).expect(201);
    sdk.create.mockResolvedValue({paymentId:'pay-1',paymentFlow:flow,status:'PENDING'});
    await request(app).post(`/api/orders/${response.body.id}/payments/${path}`).expect(200).expect(({body}) => expect(body.paymentId).toBe('pay-1'));
  });
  it('rolls back event insertion for unmatched payment and permits redelivery',async () => {
    expect(() => service.webhook(event)).toThrow();
    expect(repo.db.prepare('SELECT count(*) AS n FROM ProcessedWebhookEvent').get()).toEqual({n:0});
    const item = await payment(); service.webhook(event);
    expect(repo.get(item.id)!.orderStatus).toBe('PAID');
  });
  it.each([['FAILED','PAYMENT_FAILED'],['EXPIRED','PAYMENT_FAILED'],['CANCELLED','CANCELLED']])('maps %s',async (status,expected) => {
    const item = await payment(); service.webhook({...event,data:{...event.data,status}});
    expect(repo.get(item.id)!.orderStatus).toBe(expected);
  });
  it('converts bank wall clock with explicit Myanmar offset',() => expect(qrExpiry('2026-10-12 12:00:00')).toBe('2026-10-12T05:30:00.000Z'));
});
