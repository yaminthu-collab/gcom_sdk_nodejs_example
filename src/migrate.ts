import 'dotenv/config';
import { openDb } from './db.js';
const db = openDb(process.env.DATABASE_URL ?? 'file:./data/merchant.sqlite');
db.close();
console.log('SQLite schema ready');
