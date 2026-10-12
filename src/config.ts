import 'dotenv/config';
export function config() {
  if (process.env.THARABA_GATE_ENVIRONMENT !== 'TEST') throw new Error('Set THARABA_GATE_ENVIRONMENT=TEST');
  const required = (key: string) => { const value = process.env[key]; if (!value?.trim()) throw new Error(`Set ${key} in .env`); return value; };
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const baseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
  new URL(baseUrl);
  return {apiKey:required('THARABA_GATE_API_KEY'),secret:required('THARABA_GATE_WEBHOOK_SECRET'),
    apiBaseUrl:required('THARABA_GATE_BASE_URL'), databaseUrl:process.env.DATABASE_URL ?? 'file:./data/merchant.sqlite',port,baseUrl:baseUrl.replace(/\/$/,'')};
}
