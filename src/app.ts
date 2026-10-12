import express, { type ErrorRequestHandler } from 'express';
import { TharabaGate, InvalidWebhookSignatureError, type VerifyWebhookOptions, type WebhookEvent } from '@tharabagate/sdk';
import { HttpError, PaymentService } from './payments.js';

export function createApp(service: PaymentService, secret: string,
  verify: (options: VerifyWebhookOptions) => WebhookEvent = TharabaGate.webhooks.verifyAndParse) {
  const app = express();
  app.post('/webhooks/tharabagate',express.raw({type:'application/json',limit:'256kb'}),(req,res,next) => {
    try { service.webhook(verify({payload:req.body,headers:req.headers,secret})); res.sendStatus(200); }
    catch (error) { if (error instanceof InvalidWebhookSignatureError) res.sendStatus(401); else next(error); }
  });
  app.use(express.json({limit:'32kb'}));
  app.post('/api/orders',(req,res,next) => {
    try {
      const {orderNumber,description,amount,currency} = req.body ?? {};
      if (typeof orderNumber !== 'string' || !orderNumber.trim() || orderNumber.length>100 ||
          typeof description !== 'string' || description.length>500 ||
          typeof amount !== 'string' || !/^\d{1,16}(\.\d{1,2})?$/.test(amount) || !/[1-9]/.test(amount) ||
          typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new HttpError(400,'Provide orderNumber, description, positive decimal string amount, and uppercase currency');
      res.status(201).json(service.repo.create({orderNumber,description,amount,currency}));
    } catch(error) { next(error); }
  });
  app.get('/api/orders/:id',(req,res,next) => {
    const order = service.repo.get(req.params.id);
    if (!order) return next(new HttpError(404,'Order not found'));
    res.json(order);
  });
  for (const [path,flow] of [['hosted','HOSTED'],['qr','DIRECT_QR']] as const) {
    app.post(`/api/orders/:id/payments/${path}`,(req,res,next) => {
      service.create(req.params.id,flow).then(result => res.json(result)).catch(next);
    });
  }
  app.post('/api/orders/:id/payments/refresh',(req,res,next) => {
    service.refresh(req.params.id).then(order => res.json(order)).catch(next);
  });
  app.get('/payment/result',(req,res,next) => {
    // redirectUrl is UX navigation, not authoritative payment confirmation.
    const order = typeof req.query.orderId === 'string' ? service.repo.get(req.query.orderId) : undefined;
    if (!order) return next(new HttpError(404,'Order not found'));
    res.json({orderId:order.id,orderStatus:order.orderStatus,paymentStatus:order.paymentStatus});
  });
  const handler: ErrorRequestHandler = (error,_req,res,_next) => {
    if (error instanceof HttpError) { res.status(error.status).json({error:error.message}); return; }
    if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') { res.status(409).json({error:'Order number already exists'}); return; }
    if (error?.type === 'entity.parse.failed') { res.status(400).json({error:'Invalid JSON'}); return; }
    res.status(500).json({error:'Operation failed; retry with the same order'});
  };
  app.use(handler);
  return app;
}
