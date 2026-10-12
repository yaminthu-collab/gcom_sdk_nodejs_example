# Tharaba Gate merchant example

Runnable Node.js >=18, TypeScript, Express and SQLite merchant backend. Run all commands from `nodejs_sdk_example`. This example uses the existing `@tharabagate/sdk` package through `file:../nodejs`; keep both folders together. No Payment Service HTTP or signature logic is implemented here.

## Installation and environment

```sh
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

PowerShell: use `Copy-Item .env.example .env`. Before starting, fill in TEST API credentials, webhook secret, and `THARABA_GATE_BASE_URL` with the TEST deployment URL supplied by Tharaba Gate. The existing SDK does **not** define a default TEST URL. The application explicitly requires `THARABA_GATE_ENVIRONMENT=TEST` and fails clearly if configuration is missing. Never put credentials in frontend code or commit `.env`.

`DATABASE_URL=file:./data/merchant.sqlite` resolves relative to this folder. Schema creation is repeatable; the app also ensures it exists on startup. Set `PUBLIC_BASE_URL` to your publicly reachable merchant URL when testing hosted returns. Use a publicly reachable HTTPS tunnel for webhook delivery. Register `/webhooks/tharabagate` with Tharaba Gate and configure the same webhook secret. Localhost itself cannot receive external deliveries.

```sh
npm test
npm run build
npm start
```

Tests mock SDK operations and require no credentials or external API. Invalid signatures also exercise the real SDK verifier.

## Try the flows

Examples use a POSIX shell; on Windows use `curl.exe` with shell-appropriate quoting. Copy the returned order `id` into `ORDER_ID`. Use a separate order for each flow.

```sh
curl -X POST http://localhost:3000/api/orders -H 'Content-Type: application/json' -d '{"orderNumber":"ORDER-10001","description":"Demo order","amount":"10000.00","currency":"MMK"}'
curl -X POST http://localhost:3000/api/orders/ORDER_ID/payments/hosted
curl http://localhost:3000/payment/result?orderId=ORDER_ID
curl http://localhost:3000/api/orders/ORDER_ID
```

HOSTED returns `paymentId`, `status`, `paymentFlow` and, when supplied by the API, `checkoutUrl`. The merchant frontend navigates with `window.location.href = checkoutUrl`. The SDK does not redirect a browser. **redirectUrl is UX navigation, not authoritative payment confirmation.** The return endpoint only displays local state.

```sh
curl -X POST http://localhost:3000/api/orders -H 'Content-Type: application/json' -d '{"orderNumber":"ORDER-10002","description":"QR demo","amount":"10000.00","currency":"MMK"}'
curl -X POST http://localhost:3000/api/orders/ORDER_ID/payments/qr
curl -X POST http://localhost:3000/api/orders/ORDER_ID/payments/refresh
curl http://localhost:3000/api/orders/ORDER_ID
```

DIRECT_QR returns `paymentId`, `status`, `paymentFlow` and, when provided, `qrPayload` and `expiresAt`. Render **only `qrPayload`** with a frontend QR rendering library, for example `QRCode.toCanvas(canvas, result.qrPayload)` using the `qrcode` library. This backend does not render QR images. API failures may omit QR fields; do not display a QR without a payload.

The explicit refresh endpoint calls `client.payments.get(paymentId)` and persists its authoritative result. GET order reads local state. Amounts remain decimal strings throughout; the app performs no floating-point money calculations.

## Webhooks and recovery

`POST /webhooks/tharabagate` uses `express.raw()` before any JSON parser, passing the original Buffer, headers and secret to `TharabaGate.webhooks.verifyAndParse`. Invalid signatures receive 401. Valid processing receives 200; repeated signed event IDs receive 200 without repeating changes. Signature generation belongs to Tharaba Gate, so a fabricated curl body will not simulate a valid delivery. Replay the exact captured signed body and signature to test duplicates:

```sh
curl -X POST http://localhost:3000/webhooks/tharabagate -H 'Content-Type: application/json' -H 'x-webhook-signature: CAPTURED_SIGNATURE' --data-binary @captured-webhook.json
```

The order update and `ProcessedWebhookEvent` insertion commit in one immediate SQLite transaction. A webhook arriving before payment reference persistence returns 503 for redelivery. Mismatched payment references return 422. No fulfillment/email side effects are implemented; production integrations should enqueue them transactionally using an outbox and idempotent consumers.

One background task runs every minute with an overlap guard. It fetches only expired, associated DIRECT_QR payments and skips final statuses. It does not poll every active payment or create per-payment timers. SDK `expiresAt` is documented as bank wall-clock time; this example explicitly assumes Myanmar UTC+06:30 and stores UTC in `qrExpiresAt`. Confirm this bank timezone for your deployment. An expired QR is **not** automatically marked failed: only SDK Get Payment or a verified webhook changes its payment status. A still-pending result is retried on the next minute; request failures are isolated per order. Missing expiry means no expiry recovery is possible; use explicit refresh and operational reconciliation.

Final states are sticky: SUCCEEDED → PAID; FAILED/EXPIRED → PAYMENT_FAILED; CANCELLED → CANCELLED. Original paymentStatus is stored separately. REFUNDED/PARTIALLY_REFUNDED map to PAID when observed initially. This example freezes final statuses, including against conflicting terminal snapshots, so webhook/recovery races cannot regress them. Full refund lifecycle and conflicting terminal-state reconciliation require a separate production policy.

## Persistence and responsibilities

Schema is in `src/db.ts`: `OrderRecord` holds the Order model, string amount, unique order number/payment reference, separate order/payment statuses, timestamps, expiry, and persisted creation response and idempotency key. `ProcessedWebhookEvent(eventId PRIMARY KEY, processedAt)` deduplicates deliveries. Creation reserves its flow and key transactionally before calling the SDK; retries reuse the same immutable order request and key. The create response is saved because Get Payment cannot recover checkout URLs or QR payloads. One payment attempt per order is intentional; create a new order for another attempt.

SQLite with `better-sqlite3` keeps the schema and transactions small and explicit. It may require native build tooling if no prebuilt binary exists for your Node/platform. For PostgreSQL, replace the repository, migrate string money to a suitable DECIMAL column, preserve unique constraints, and use row locks or conditional updates for status transitions and idempotency. Use a versioned migration tool when evolving this schema.

**@tharabagate/sdk is stateless.** It does not create merchant DB tables, store order/payment state, track webhook receipt, or run expiry fallback jobs. Those responsibilities belong to the merchant application. The SDK owns API transport, SDK request validation and webhook verification.

This is a local example, not a complete e-commerce application. Run one application process. Before exposing merchant order routes publicly, add authentication, order ownership checks, rate limits and a durable distributed recovery worker. Persisted checkout/QR responses are sensitive: protect database access and apply appropriate retention. Credentials are never stored in merchant tables.
