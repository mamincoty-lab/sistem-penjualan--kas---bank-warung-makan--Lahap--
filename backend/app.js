const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

function loadLocalEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const entry = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!entry || process.env[entry[1]] !== undefined) continue;
    const value = entry[2].replace(/^(['"])(.*)\1$/, '$2');
    process.env[entry[1]] = value;
  }
}

loadLocalEnv();

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const OWNER_APPROVAL_PIN = process.env.OWNER_APPROVAL_PIN || '';
const API_ACCESS_PIN = process.env.API_ACCESS_PIN || '';
const API_ACCESS_REQUIRED = process.env.NODE_ENV === 'production' || Boolean(API_ACCESS_PIN);
const EXPENSE_APPROVAL_LIMIT = Number(process.env.EXPENSE_APPROVAL_LIMIT || 1000000);
const CORS_ORIGINS = new Set((process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000').split(',').map(origin => origin.trim()).filter(Boolean));
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend');

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function matchesSecret(value, expected) {
  const actualBuffer = Buffer.from(String(value || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (error) { reject(new Error('Body JSON tidak valid.')); }
    });
    request.on('error', reject);
  });
}

async function supabaseRequest(table, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY belum diatur.');
  }

  const query = options.query ? `?${new URLSearchParams(options.query)}` : '';
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: options.method || 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || (options.method === 'POST' ? 'return=representation' : 'return=minimal')
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(data?.message || data?.hint || 'Supabase mengembalikan error.');
  return data;
}

function validateSale(body) {
  const menuItemId = Number(body.menu_item_id);
  const quantity = Number(body.quantity);
  if (!Number.isInteger(menuItemId) || menuItemId < 1) throw new Error('Menu belum dipilih.');
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Jumlah harus minimal 1.');
  if (!['Cash', 'Transfer', 'QRIS'].includes(body.payment_method)) throw new Error('Metode pembayaran tidak valid.');
  return { menuItemId, quantity, paymentMethod: body.payment_method };
}

async function createSale(body) {
  const input = validateSale(body);
  const menu = await supabaseRequest('menu_items', {
    query: { select: 'id,name,price', id: `eq.${input.menuItemId}`, is_active: 'eq.true' }
  });
  if (!menu.length) throw new Error('Menu tidak ditemukan atau sedang nonaktif.');

  const sale = await supabaseRequest('sales', {
    method: 'POST',
    body: {
      menu_item_id: input.menuItemId,
      quantity: input.quantity,
      unit_price: menu[0].price,
      payment_method: input.paymentMethod
    }
  });
  const createdSale = sale[0];
  await supabaseRequest('cash_bank_transactions', {
    method: 'POST',
    body: {
      sale_id: createdSale.id,
      transaction_type: 'Income',
      account: input.paymentMethod === 'Cash' ? 'Kas' : 'Bank',
      category: 'Penjualan',
      amount: createdSale.total_amount,
      note: `${menu[0].name} x${input.quantity}`
    }
  });
  return createdSale;
}

function validateCashTransaction(body) {
  const amount = Number(body.amount);
  if (!['Income', 'Expense'].includes(body.transaction_type)) throw new Error('Jenis transaksi tidak valid.');
  if (!['Kas', 'Bank'].includes(body.account)) throw new Error('Akun tidak valid.');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Nominal harus lebih besar dari 0.');
  const transactionDate = body.transaction_date ? new Date(body.transaction_date) : new Date();
  if (Number.isNaN(transactionDate.getTime())) throw new Error('Tanggal transaksi tidak valid.');
  return { ...body, transaction_date: transactionDate.toISOString(), amount, approval_status: body.transaction_type === 'Expense' && amount >= EXPENSE_APPROVAL_LIMIT ? 'pending' : 'approved' };
}

async function uploadCashReceipt(dataUrl) {
  if (!dataUrl) return null;
  const match = String(dataUrl).match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('Bukti harus berupa JPG, PNG, atau WebP.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 2 * 1024 * 1024) throw new Error('Ukuran bukti maksimal 2 MB.');
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[match[1]];
  const objectPath = `${new Date().toISOString().slice(0, 10)}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${extension}`;
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/cash-receipts/${objectPath}`, { method: 'POST', headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': match[1], 'x-upsert': 'false' }, body: bytes });
  if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.message || 'Gagal mengunggah bukti ke Supabase Storage.'); }
  return objectPath;
}

async function getReceiptUrl(transactionId) {
  const rows = await supabaseRequest('cash_bank_transactions', { query: { select: 'receipt_path', id: `eq.${transactionId}`, limit: '1' } });
  const objectPath = rows[0]?.receipt_path;
  if (!objectPath) throw new Error('Transaksi ini tidak memiliki bukti nota.');
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/cash-receipts/${objectPath}`, { method: 'POST', headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 600 }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || 'Gagal membuka bukti nota.');
  return `${SUPABASE_URL}/storage/v1${result.signedURL}`;
}

function validateRecurringExpense(body) {
  const amount = Number(body.amount);
  if (!String(body.name || '').trim() || !Number.isFinite(amount) || amount <= 0) throw new Error('Nama dan nominal recurring wajib valid.');
  if (!['Kas', 'Bank'].includes(body.account) || !['weekly', 'monthly'].includes(body.frequency)) throw new Error('Akun atau frekuensi recurring tidak valid.');
  if (!body.next_due) throw new Error('Tanggal jatuh tempo wajib diisi.');
  return { name: String(body.name).trim(), category: String(body.category || 'Operasional').trim(), account: body.account, amount, frequency: body.frequency, next_due: body.next_due };
}

async function approveCashTransaction(id, body, status) {
  requireOwnerPin(body);
  const updated = await supabaseRequest('cash_bank_transactions', { method: 'PATCH', query: { id: `eq.${id}`, approval_status: 'eq.pending' }, body: { approval_status: status, approved_by: body.actor || 'Owner' } });
  await writeAudit(status === 'approved' ? 'APPROVE_EXPENSE' : 'REJECT_EXPENSE', 'cash_bank_transactions', id, body.reason, body.actor || 'Owner');
  return updated;
}

async function getApprovedTransactions(account = null) {
  const query = { select: 'id,transaction_type,account,category,amount,note,transaction_date,transaction_role,reconciliation_status,approval_status,voided_at', approval_status: 'eq.approved', transaction_role: 'neq.non_cash', order: 'transaction_date.asc', limit: '5000' };
  if (account) query.account = `eq.${account}`;
  return supabaseRequest('cash_bank_transactions', { query });
}

function validateFinanceActor(body) {
  const actor = String(body.actor || '').trim();
  if (!actor) throw new Error('Nama kasir/pelaku wajib diisi.');
  return actor;
}

async function createAccountTransfer(body) {
  const amount = Number(body.amount);
  if (!['Kas', 'Bank'].includes(body.from_account) || !['Kas', 'Bank'].includes(body.to_account) || body.from_account === body.to_account || !Number.isFinite(amount) || amount <= 0) throw new Error('Akun asal, tujuan, dan nominal transfer harus valid.');
  const actor = validateFinanceActor(body);
  const currentRows = await getApprovedTransactions(body.from_account);
  const available = currentRows.reduce((sum, item) => sum + (item.transaction_type === 'Income' ? Number(item.amount) : -Number(item.amount)), 0);
  if (amount > available) throw new Error(`Saldo ${body.from_account} tidak cukup. Tersedia ${available}.`);
  const at = body.transaction_date ? new Date(body.transaction_date) : new Date();
  if (Number.isNaN(at.getTime())) throw new Error('Tanggal transfer tidak valid.');
  const reference = `TRF-${Date.now()}`;
  const rows = await supabaseRequest('cash_bank_transactions', { method: 'POST', body: [
    { transaction_type: 'Expense', account: body.from_account, category: 'Transfer antar akun', amount, note: `${reference} ke ${body.to_account} oleh ${actor}`, transaction_date: at.toISOString(), transaction_role: 'transfer' },
    { transaction_type: 'Income', account: body.to_account, category: 'Transfer antar akun', amount, note: `${reference} dari ${body.from_account} oleh ${actor}`, transaction_date: at.toISOString(), transaction_role: 'transfer' }
  ] });
  await writeAudit('ACCOUNT_TRANSFER', 'cash_bank_transactions', reference, 'Transfer antar akun', actor, { from: body.from_account, to: body.to_account, amount });
  return rows;
}

async function createBankReconciliation(body) {
  const statementDate = new Date(body.statement_date);
  const statementBalance = Number(body.statement_balance);
  if (Number.isNaN(statementDate.getTime()) || !Number.isFinite(statementBalance) || statementBalance < 0) throw new Error('Tanggal dan saldo rekening koran tidak valid.');
  const transactions = await getApprovedTransactions('Bank');
  const appBalance = transactions.reduce((sum, item) => sum + (item.transaction_type === 'Income' ? Number(item.amount) : -Number(item.amount)), 0);
  const difference = statementBalance - appBalance;
  const actor = validateFinanceActor(body);
  const created = await supabaseRequest('bank_reconciliations', { method: 'POST', body: { statement_date: statementDate.toISOString().slice(0, 10), app_balance: appBalance, statement_balance: statementBalance, difference, note: String(body.note || '').trim() || null, actor } });
  if (body.matched_ids?.length) await supabaseRequest('cash_bank_transactions', { method: 'PATCH', query: { id: `in.(${body.matched_ids.map(Number).filter(Number.isInteger).join(',')})`, account: 'eq.Bank' }, body: { reconciliation_status: 'matched' } });
  await writeAudit('BANK_RECONCILIATION', 'bank_reconciliations', created[0]?.id, `Selisih: ${difference}`, actor, { appBalance, statementBalance, matchedIds: body.matched_ids || [] });
  return created[0];
}

async function createCashClosing(body) {
  const actualCash = Number(body.actual_cash);
  if (!Number.isFinite(actualCash) || actualCash < 0) throw new Error('Kas aktual tidak valid.');
  const cashier = validateFinanceActor(body);
  const transactions = await getApprovedTransactions('Kas');
  const expectedCash = transactions.reduce((sum, item) => sum + (item.transaction_type === 'Income' ? Number(item.amount) : -Number(item.amount)), 0);
  const created = await supabaseRequest('cash_closings', { method: 'POST', body: { cashier_name: cashier, actual_cash: actualCash, expected_cash: expectedCash, difference: actualCash - expectedCash, note: String(body.note || '').trim() || null } });
  await writeAudit('CASH_CLOSING', 'cash_closings', created[0]?.id, `Selisih: ${actualCash - expectedCash}`, cashier, { expectedCash, actualCash });
  return created[0];
}

async function createDebt(body) {
  const amount = Number(body.amount);
  if (!['receivable', 'payable'].includes(body.debt_type) || !String(body.party_name || '').trim() || !String(body.description || '').trim() || !Number.isFinite(amount) || amount <= 0 || !['Kas', 'Bank'].includes(body.account)) throw new Error('Data hutang/piutang tidak valid.');
  const debt = (await supabaseRequest('debts', { method: 'POST', body: { debt_type: body.debt_type, party_name: String(body.party_name).trim(), description: String(body.description).trim(), original_amount: amount, remaining_amount: amount, due_date: body.due_date || null, account: body.account, offline_id: body.offline_id || null } }))[0];
  await supabaseRequest('cash_bank_transactions', { method: 'POST', body: { transaction_type: body.debt_type === 'receivable' ? 'Income' : 'Expense', account: body.account, category: body.debt_type === 'receivable' ? 'Penjualan bon' : 'Bahan baku', amount, note: `${debt.party_name} · ${debt.description} · belum dibayar`, transaction_role: 'non_cash' } });
  return debt;
}

async function settleDebt(id, body) {
  const amount = Number(body.amount);
  const actor = validateFinanceActor(body);
  const debtQuery = String(id).startsWith('offline-') ? { offline_id: `eq.${id}` } : { id: `eq.${id}` };
  const rows = await supabaseRequest('debts', { query: { select: 'id,debt_type,party_name,description,remaining_amount,account,status', ...debtQuery, limit: '1' } });
  const debt = rows[0];
  if (!debt || debt.status === 'paid' || !Number.isFinite(amount) || amount <= 0 || amount > Number(debt.remaining_amount)) throw new Error('Nominal pembayaran tidak valid atau tagihan sudah lunas.');
  if (debt.debt_type === 'payable') {
    const transactions = await getApprovedTransactions(debt.account);
    const available = transactions.reduce((sum, item) => sum + (item.transaction_type === 'Income' ? Number(item.amount) : -Number(item.amount)), 0);
    if (amount > available) throw new Error(`Saldo ${debt.account} tidak cukup untuk membayar hutang.`);
  }
  const remaining = Number(debt.remaining_amount) - amount;
  await supabaseRequest('debts', { method: 'PATCH', query: { id: `eq.${id}` }, body: { remaining_amount: remaining, status: remaining === 0 ? 'paid' : 'partial', settled_at: remaining === 0 ? new Date().toISOString() : null } });
  await supabaseRequest('cash_bank_transactions', { method: 'POST', body: { transaction_type: debt.debt_type === 'receivable' ? 'Income' : 'Expense', account: debt.account, category: debt.debt_type === 'receivable' ? 'Penerimaan piutang' : 'Pembayaran hutang', amount, note: `${debt.party_name} · ${debt.description} · oleh ${actor}`, transaction_role: 'settlement' } });
  await writeAudit('SETTLE_DEBT', 'debts', id, `Pembayaran ${amount}`, actor, { paid: amount, remaining });
  return { message: 'Pembayaran tagihan dicatat.', remaining_amount: remaining };
}

async function saveBudget(body) {
  const amount = Number(body.amount);
  const period = new Date(`${body.period_month}-01T00:00:00`);
  const category = String(body.category || '').trim();
  if (!category || !Number.isFinite(amount) || amount <= 0 || Number.isNaN(period.getTime())) throw new Error('Kategori, bulan, dan anggaran wajib valid.');
  return (await supabaseRequest('budgets', { method: 'POST', prefer: 'resolution=merge-duplicates,return=representation', query: { on_conflict: 'category,period_month' }, body: { category, period_month: period.toISOString().slice(0, 10), amount } }))[0];
}

function validateMenu(body) {
  const price = Number(body.price);
  const name = String(body.name || '').trim();
  const category = String(body.category || 'Makanan').trim();
  if (!name) throw new Error('Nama menu wajib diisi.');
  if (!Number.isFinite(price) || price <= 0) throw new Error('Harga menu harus lebih besar dari 0.');
  const imageUrl = body.image_url ? String(body.image_url).trim() : null;
  return { name, category: category || 'Makanan', price, image_url: imageUrl, is_favorite: Boolean(body.is_favorite) };
}

function requireOwnerPin(body) {
  if (!OWNER_APPROVAL_PIN) throw new Error('PIN owner belum aktif. Jalankan backend dengan $env:OWNER_APPROVAL_PIN terlebih dahulu.');
  if (!body || String(body.pin || '').trim() !== OWNER_APPROVAL_PIN) throw new Error('PIN owner salah.');
}

async function writeAudit(action, entityType, entityId, reason, actor = 'Kasir', details = null) {
  await supabaseRequest('audit_logs', { method: 'POST', body: { action, entity_type: entityType, entity_id: String(entityId || ''), reason: reason || null, actor, details } });
}

function validateAuditActor(body) {
  const actor = String(body.actor || '').trim();
  const reason = String(body.reason || '').trim();
  if (!actor || !reason) throw new Error('Nama pelaku dan alasan wajib diisi.');
  return { actor, reason };
}

async function voidCashTransaction(id, body) {
  requireOwnerPin(body);
  const { actor, reason } = validateAuditActor(body);
  const rows = await supabaseRequest('cash_bank_transactions', { query: { select: 'id,transaction_type,account,category,amount,note,transaction_date,voided_at', id: `eq.${id}`, limit: '1' } });
  const original = rows[0];
  if (!original) throw new Error('Transaksi tidak ditemukan.');
  if (original.voided_at) throw new Error('Transaksi sudah pernah di-void.');
  const voidedAt = new Date().toISOString();
  await supabaseRequest('cash_bank_transactions', { method: 'PATCH', query: { id: `eq.${id}` }, body: { voided_at: voidedAt, voided_by: actor, void_reason: reason } });
  const reversal = await supabaseRequest('cash_bank_transactions', { method: 'POST', body: { transaction_type: original.transaction_type === 'Income' ? 'Expense' : 'Income', account: original.account, category: `Pembalik: ${original.category}`, amount: original.amount, note: `Void transaksi #${id} oleh ${actor}: ${reason}`, transaction_date: voidedAt, transaction_role: 'void_reversal', approval_status: 'approved' } });
  await writeAudit('VOID_REFUND', 'cash_bank_transactions', id, reason, actor, { original, reversal: reversal?.[0] || null });
  return { message: 'Transaksi dibalik dan dicatat dalam audit log.', reversal: reversal?.[0] || null };
}

async function editCashTransaction(id, body) {
  requireOwnerPin(body);
  const { actor, reason } = validateAuditActor(body);
  const rows = await supabaseRequest('cash_bank_transactions', { query: { select: 'id,transaction_type,account,category,amount,note,transaction_date,voided_at', id: `eq.${id}`, limit: '1' } });
  const original = rows[0];
  if (!original) throw new Error('Transaksi tidak ditemukan.');
  if (original.voided_at) throw new Error('Transaksi yang sudah di-void tidak dapat diedit.');
  const amount = Number(body.amount);
  const transactionDate = new Date(body.transaction_date);
  const updated = { transaction_type: body.transaction_type, account: body.account, category: String(body.category || '').trim(), amount, note: String(body.note || '').trim() || null, transaction_date: transactionDate.toISOString() };
  if (!['Income', 'Expense'].includes(updated.transaction_type) || !['Kas', 'Bank'].includes(updated.account) || !updated.category || !Number.isFinite(amount) || amount <= 0 || Number.isNaN(transactionDate.getTime())) throw new Error('Data transaksi baru tidak valid.');
  await supabaseRequest('cash_bank_transactions', { method: 'PATCH', query: { id: `eq.${id}` }, body: updated });
  await writeAudit('EDIT_TRANSACTION', 'cash_bank_transactions', id, reason, actor, { before: original, after: updated });
  return { message: 'Transaksi diperbarui dan perubahan dicatat.' };
}

async function voidSale(id, body) {
  requireOwnerPin(body);
  const { actor, reason } = validateAuditActor(body);
  const sales = await supabaseRequest('sales', { query: { select: 'id,menu_item_id,quantity,unit_price,total_amount,payment_method,sale_date,voided_at', id: `eq.${id}`, limit: '1' } });
  const sale = sales[0];
  if (!sale) throw new Error('Penjualan tidak ditemukan.');
  if (sale.voided_at) throw new Error('Penjualan sudah pernah di-void.');
  const cashRows = await supabaseRequest('cash_bank_transactions', { query: { select: 'id,transaction_type,account,category,amount,note,transaction_date', sale_id: `eq.${id}` } });
  const voidedAt = new Date().toISOString();
  await supabaseRequest('sales', { method: 'PATCH', query: { id: `eq.${id}` }, body: { voided_at: voidedAt, voided_by: actor, void_reason: reason } });
  const reversals = [];
  for (const original of cashRows) {
    await supabaseRequest('cash_bank_transactions', { method: 'PATCH', query: { id: `eq.${original.id}` }, body: { voided_at: voidedAt, voided_by: actor, void_reason: reason } });
    const reverse = await supabaseRequest('cash_bank_transactions', { method: 'POST', body: { transaction_type: original.transaction_type === 'Income' ? 'Expense' : 'Income', account: original.account, category: `Pembalik: ${original.category}`, amount: original.amount, note: `Void penjualan #${id} oleh ${actor}: ${reason}`, transaction_date: voidedAt, transaction_role: 'void_reversal', approval_status: 'approved' } });
    reversals.push(reverse?.[0] || null);
  }
  await writeAudit('VOID_REFUND', 'sales', id, reason, actor, { original: sale, reversals });
  return { message: 'Penjualan dibalik dan dicatat dalam audit log.' };
}

function validateCombo(body) {
  const name = String(body.name || '').trim();
  const price = Number(body.price);
  const items = Array.isArray(body.items) ? body.items.map(item => ({ menuItemId: Number(item.menu_item_id), quantity: Number(item.quantity || 1) })) : [];
  if (!name || !Number.isFinite(price) || price <= 0 || !items.length || items.some(item => !Number.isInteger(item.menuItemId) || item.quantity < 1)) throw new Error('Data paket kombo tidak valid.');
  return { name, price, items };
}

async function createCombo(body) {
  const input = validateCombo(body);
  const combo = (await supabaseRequest('combos', { method: 'POST', body: { name: input.name, price: input.price } }))[0];
  await supabaseRequest('combo_items', { method: 'POST', body: input.items.map(item => ({ combo_id: combo.id, menu_item_id: item.menuItemId, quantity: item.quantity })) });
  return combo;
}

function validateOrder(body) {
  if (!Array.isArray(body.items) || body.items.length === 0) throw new Error('Keranjang masih kosong.');
  if (!['dine-in', 'takeaway', 'delivery'].includes(body.order_type)) throw new Error('Mode pesanan tidak valid.');
  if (body.order_type === 'dine-in' && !String(body.table_number || '').trim()) throw new Error('Nomor meja wajib untuk dine-in.');
  const discountType = body.discount_type || 'none';
  const discountValue = Number(body.discount_value || 0);
  const taxPercent = Number(body.tax_percent || 0);
  const servicePercent = Number(body.service_percent || 0);
  if (!['none', 'percent', 'amount'].includes(discountType) || discountValue < 0 || taxPercent < 0 || servicePercent < 0) throw new Error('Diskon atau biaya tidak valid.');
  const items = body.items.map(item => ({ menuItemId: Number(item.menu_item_id), quantity: Number(item.quantity), note: String(item.note || '').trim() }));
  if (items.some(item => !Number.isInteger(item.menuItemId) || !Number.isInteger(item.quantity) || item.quantity < 1)) throw new Error('Item pesanan tidak valid.');
  const payments = Array.isArray(body.payments) ? body.payments.map(payment => ({ method: payment.method, amount: Number(payment.amount), cashReceived: Number(payment.cash_received || 0) })) : [];
  if (!payments.length || payments.some(payment => !['Cash', 'QRIS', 'Transfer', 'E-Wallet', 'Debit', 'Credit'].includes(payment.method) || payment.amount <= 0)) throw new Error('Pembayaran tidak valid.');
  return { ...body, discountType, discountValue, taxPercent, servicePercent, items, payments };
}

async function createOrder(body) {
  const input = validateOrder(body);
  const ids = input.items.map(item => item.menuItemId);
  const menus = await supabaseRequest('menu_items', { query: { select: 'id,name,price', id: `in.(${ids.join(',')})`, is_active: 'eq.true' } });
  const menuById = new Map(menus.map(menu => [Number(menu.id), menu]));
  if (menus.length !== new Set(ids).size) throw new Error('Ada menu yang tidak ditemukan.');
  const subtotal = input.items.reduce((sum, item) => sum + Number(menuById.get(item.menuItemId).price) * item.quantity, 0);
  const discount = input.discountType === 'percent' ? subtotal * Math.min(input.discountValue, 100) / 100 : input.discountType === 'amount' ? Math.min(input.discountValue, subtotal) : 0;
  const afterDiscount = subtotal - discount;
  const tax = afterDiscount * input.taxPercent / 100;
  const service = afterDiscount * input.servicePercent / 100;
  const total = Math.round(afterDiscount + tax + service);
  const paymentTotal = input.payments.reduce((sum, payment) => sum + payment.amount, 0);
  if (Math.abs(paymentTotal - total) > 0.01) throw new Error(`Total pembayaran harus ${total}.`);
  const orderNumber = `ORD-${Date.now()}`;
  const created = await supabaseRequest('orders', { method: 'POST', body: { order_number: orderNumber, order_type: input.order_type, table_number: input.table_number || null, subtotal, discount_type: input.discountType, discount_value: input.discountValue, tax_percent: input.taxPercent, service_percent: input.servicePercent, total_amount: total, cashier_name: input.cashier_name || 'Kasir', source: input.source || 'walk_in', platform_fee: Number(input.platform_fee || 0), kitchen_status: input.order_status || 'open' } });
  const order = created[0];
  await supabaseRequest('order_items', { method: 'POST', body: input.items.map(item => ({ order_id: order.id, menu_item_id: item.menuItemId, quantity: item.quantity, unit_price: menuById.get(item.menuItemId).price, special_note: item.note || null })) });
  await supabaseRequest('payments', { method: 'POST', body: input.payments.map(payment => ({ order_id: order.id, method: payment.method, amount: payment.amount, cash_received: payment.method === 'Cash' ? payment.cashReceived : null, change_amount: payment.method === 'Cash' ? Math.max(payment.cashReceived - payment.amount, 0) : 0 })) });
  for (const payment of input.payments) await supabaseRequest('cash_bank_transactions', { method: 'POST', body: { transaction_type: 'Income', account: payment.method === 'Cash' ? 'Kas' : 'Bank', category: 'Penjualan POS', amount: payment.amount, note: `${orderNumber} - ${payment.method}` } });
  const platformFee = Number(input.platform_fee || 0);
  if (platformFee > 0 && ['GoFood', 'GrabFood', 'ShopeeFood'].includes(input.source)) await supabaseRequest('cash_bank_transactions', { method: 'POST', body: { transaction_type: 'Expense', account: 'Bank', category: `Komisi ${input.source}`, amount: platformFee, note: `${orderNumber} · komisi platform`, transaction_role: 'operating' } });
  return { ...order, discount, tax, service, total_amount: total };
}

async function replayOfflineOperations(operations) {
  if (!Array.isArray(operations) || operations.length > 100) throw new Error('Batch sinkronisasi tidak valid.');
  const results = [];
  const idMap = new Map();
  for (const operation of operations) {
    const opId = String(operation.op_id || '').trim();
    if (!opId || !operation.endpoint) { results.push({ op_id: opId, ok: false, error: 'ID operasi atau endpoint kosong.' }); continue; }
    try {
      const previous = await supabaseRequest('sync_operations', { query: { select: 'op_id,result', op_id: `eq.${opId}`, limit: '1' } });
      if (previous.length) {
        const priorResult = previous[0].result;
        const localId = operation.body?.id;
        const remoteId = Array.isArray(priorResult) ? priorResult[0]?.id : priorResult?.id;
        if (operation.endpoint === '/api/cash-bank' && localId && remoteId) idMap.set(String(localId), String(remoteId));
        if (operation.endpoint === '/api/transfers' && Array.isArray(operation.body?.offline_ids) && Array.isArray(priorResult)) operation.body.offline_ids.forEach((offlineId, index) => { if (priorResult[index]?.id) idMap.set(String(offlineId), String(priorResult[index].id)); });
        results.push({ op_id: opId, ok: true, duplicate: true, result: priorResult });
        continue;
      }
      const body = { ...(operation.body || {}) };
      if (Array.isArray(body.matched_ids)) body.matched_ids = body.matched_ids.map(id => Number(idMap.get(String(id)) || id));
      const endpoint = operation.endpoint.replace(/(\/api\/(?:cash-bank|sales)\/)([\d.]+)(?=\/)/, (match, prefix, id) => `${prefix}${idMap.get(id) || id}`);
      let result;
      if (endpoint === '/api/orders') result = await createOrder(body);
      else if (endpoint === '/api/cash-bank') {
        const localId = body.id;
        delete body.id;
        const receiptPath = await uploadCashReceipt(body.receipt_data);
        const { receipt_data: ignoredReceiptData, ...transactionBody } = body;
        result = await supabaseRequest('cash_bank_transactions', { method: 'POST', body: validateCashTransaction({ ...transactionBody, receipt_path: receiptPath }) });
        if (localId && result?.[0]?.id) idMap.set(String(localId), String(result[0].id));
      } else if (endpoint === '/api/transfers') result = await createAccountTransfer(body);
      else if (endpoint === '/api/bank-reconciliations') result = await createBankReconciliation(body);
      else if (endpoint === '/api/cash-closings') result = await createCashClosing(body);
      else if (endpoint === '/api/debts') result = await createDebt(body);
      else if (endpoint === '/api/budgets') result = await saveBudget(body);
      else {
        const debtMatch = endpoint.match(/^\/api\/debts\/([^/]+)\/settle$/);
        const cashEditMatch = endpoint.match(/^\/api\/cash-bank\/(\d+)\/edit$/);
        const cashVoidMatch = endpoint.match(/^\/api\/cash-bank\/(\d+)\/void$/);
        const saleVoidMatch = endpoint.match(/^\/api\/sales\/(\d+)\/void$/);
        const menuEditMatch = endpoint.match(/^\/api\/menu\/(\d+)$/);
        if (debtMatch) result = await settleDebt(debtMatch[1], body);
        else if (cashEditMatch) result = await editCashTransaction(cashEditMatch[1], body);
        else if (cashVoidMatch) result = await voidCashTransaction(cashVoidMatch[1], body);
        else if (saleVoidMatch) result = await voidSale(saleVoidMatch[1], body);
        else if (menuEditMatch) {
          const existing = await supabaseRequest('menu_items', { query: { select: 'id,image_url,is_favorite', id: `eq.${menuEditMatch[1]}`, is_active: 'eq.true', limit: '1' } });
          if (!existing.length) throw new Error('Menu tidak ditemukan atau sedang nonaktif.');
          const updated = validateMenu({ ...body, image_url: body.image_url || existing[0].image_url, is_favorite: body.is_favorite ?? existing[0].is_favorite });
          result = await supabaseRequest('menu_items', { method: 'PATCH', query: { id: `eq.${menuEditMatch[1]}` }, body: updated });
          await writeAudit('EDIT', 'menu_items', menuEditMatch[1], 'Menu diperbarui setelah sinkronisasi offline.', 'Kasir', { after: updated });
        }
        else throw new Error('Operasi ini belum didukung sinkronisasi offline.');
      }
      if (endpoint === '/api/transfers' && Array.isArray(body.offline_ids) && Array.isArray(result)) body.offline_ids.forEach((localId, index) => { if (result[index]?.id) idMap.set(String(localId), String(result[index].id)); });
      await supabaseRequest('sync_operations', { method: 'POST', body: { op_id: opId, result } });
      results.push({ op_id: opId, ok: true, result });
    } catch (error) { results.push({ op_id: opId, ok: false, error: error.message }); }
  }
  return results;
}

function serveStatic(request, response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const isLogoAsset = requested === '/logo%20lahap.png';
  const filePath = isLogoAsset ? path.resolve(FRONTEND_DIR, '..', 'logo lahap.png') : path.resolve(FRONTEND_DIR, `.${requested}`);
  if ((!isLogoAsset && !filePath.startsWith(FRONTEND_DIR)) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendJson(response, 404, { error: 'Halaman tidak ditemukan.' });
    return;
  }
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
  response.writeHead(200, { 'Content-Type': `${types[path.extname(filePath)] || 'application/octet-stream'}; charset=utf-8` });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const origin = request.headers.origin;
  const allowedOrigin = !origin || CORS_ORIGINS.has(origin);
  if (origin && allowedOrigin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Lahap-Access-Pin');
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(allowedOrigin ? 204 : 403);
    return response.end();
  }
  try {
    if (url.pathname === '/api/access' && request.method === 'POST') {
      if (!API_ACCESS_PIN) return sendJson(response, 503, { error: 'PIN akses aplikasi belum dikonfigurasi.' });
      const body = await readBody(request);
      if (!matchesSecret(body.pin, API_ACCESS_PIN)) return sendJson(response, 401, { error: 'PIN akses salah.' });
      return sendJson(response, 200, { authenticated: true });
    }
    if (API_ACCESS_REQUIRED && url.pathname.startsWith('/api/') && url.pathname !== '/api/status' && request.headers['x-lahap-access-pin'] !== API_ACCESS_PIN) {
      return sendJson(response, 401, { error: 'PIN akses aplikasi diperlukan.' });
    }
    if (url.pathname === '/api/menu' && request.method === 'GET') {
      return sendJson(response, 200, await supabaseRequest('menu_items', { query: { select: 'id,name,code,category,price,image_url,is_favorite', is_active: 'eq.true', order: 'is_favorite.desc,name.asc' } }));
    }
    if (url.pathname === '/api/status' && request.method === 'GET') {
      return sendJson(response, 200, { server: true, ownerPinConfigured: Boolean(OWNER_APPROVAL_PIN), supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) });
    }
    if (url.pathname === '/api/sync' && request.method === 'POST') {
      const body = await readBody(request);
      return sendJson(response, 200, { results: await replayOfflineOperations(body.operations) });
    }
    if (url.pathname === '/api/menu' && request.method === 'POST') {
      return sendJson(response, 201, await supabaseRequest('menu_items', { method: 'POST', body: validateMenu(await readBody(request)) }));
    }
    if (url.pathname.match(/^\/api\/menu\/\d+$/) && request.method === 'PATCH') {
      const menuId = url.pathname.split('/')[3];
      const body = await readBody(request);
      const existing = await supabaseRequest('menu_items', { query: { select: 'id,name,category,price,image_url,is_favorite', id: `eq.${menuId}`, is_active: 'eq.true', limit: '1' } });
      if (!existing.length) throw new Error('Menu tidak ditemukan atau sedang nonaktif.');
      const updated = validateMenu({ ...body, image_url: body.image_url || existing[0].image_url, is_favorite: body.is_favorite ?? existing[0].is_favorite });
      const result = await supabaseRequest('menu_items', { method: 'PATCH', query: { id: `eq.${menuId}` }, body: updated });
      await writeAudit('EDIT', 'menu_items', menuId, 'Menu diperbarui.', 'Kasir', { before: existing[0], after: updated });
      return sendJson(response, 200, result);
    }
    if (url.pathname.match(/^\/api\/menu\/\d+\/favorite$/) && request.method === 'PATCH') {
      const menuId = url.pathname.split('/')[3];
      const body = await readBody(request);
      return sendJson(response, 200, await supabaseRequest('menu_items', { method: 'PATCH', query: { id: `eq.${menuId}` }, body: { is_favorite: Boolean(body.is_favorite) } }));
    }
    if (url.pathname === '/api/combos' && request.method === 'GET') {
      return sendJson(response, 200, await supabaseRequest('combos', { query: { select: 'id,name,price,combo_items(menu_item_id,quantity)', is_active: 'eq.true', order: 'name.asc' } }));
    }
    if (url.pathname === '/api/combos' && request.method === 'POST') {
      return sendJson(response, 201, await createCombo(await readBody(request)));
    }
    if (url.pathname === '/api/dashboard' && request.method === 'GET') {
      const [sales, cashBank] = await Promise.all([
        supabaseRequest('sales', { query: { select: 'id,menu_item_id,quantity,unit_price,total_amount,payment_method,sale_date,voided_at,voided_by,void_reason,menu_items(name,category)', order: 'sale_date.desc', limit: '100' } }),
        supabaseRequest('cash_bank_transactions', { query: { select: 'id,sale_id,transaction_type,account,category,amount,note,receipt_path,approval_status,transaction_date,voided_at,voided_by,void_reason', order: 'transaction_date.desc', limit: '1000' } })
      ]);
      const orders = await supabaseRequest('orders', { query: { select: 'id,order_number,order_type,table_number,status,total_amount,cashier_name,source,platform_fee,created_at,order_items(quantity,unit_price,special_note,menu_items(name,category)),payments(method,amount)', order: 'created_at.desc', limit: '1000' } });
      const [auditLogs, reconciliations, closings, debts, budgets] = await Promise.all([
        supabaseRequest('audit_logs', { query: { select: 'id,action,entity_type,entity_id,reason,actor,created_at,details', order: 'created_at.desc', limit: '500' } }),
        supabaseRequest('bank_reconciliations', { query: { select: '*', order: 'created_at.desc', limit: '100' } }),
        supabaseRequest('cash_closings', { query: { select: '*', order: 'closed_at.desc', limit: '100' } }),
        supabaseRequest('debts', { query: { select: '*', order: 'created_at.desc', limit: '500' } }),
        supabaseRequest('budgets', { query: { select: '*', order: 'period_month.desc', limit: '500' } })
      ]);
      return sendJson(response, 200, { sales, orders, cashBank, auditLogs, reconciliations, closings, debts, budgets });
    }
    if (url.pathname === '/api/sales' && request.method === 'POST') {
      return sendJson(response, 201, await createSale(await readBody(request)));
    }
    if (url.pathname === '/api/orders' && request.method === 'POST') {
      return sendJson(response, 201, await createOrder(await readBody(request)));
    }
    if (url.pathname === '/api/cash-bank' && request.method === 'POST') {
      const body = await readBody(request);
      const receiptPath = await uploadCashReceipt(body.receipt_data);
      const { receipt_data: ignoredReceiptData, ...transactionBody } = body;
      const transaction = validateCashTransaction({ ...transactionBody, receipt_path: receiptPath });
      return sendJson(response, 201, await supabaseRequest('cash_bank_transactions', { method: 'POST', body: transaction }));
    }
    if (url.pathname === '/api/transfers' && request.method === 'POST') return sendJson(response, 201, await createAccountTransfer(await readBody(request)));
    if (url.pathname === '/api/bank-reconciliations' && request.method === 'POST') return sendJson(response, 201, await createBankReconciliation(await readBody(request)));
    if (url.pathname === '/api/cash-closings' && request.method === 'GET') return sendJson(response, 200, await supabaseRequest('cash_closings', { query: { select: '*', order: 'closed_at.desc', limit: '100' } }));
    if (url.pathname === '/api/cash-closings' && request.method === 'POST') return sendJson(response, 201, await createCashClosing(await readBody(request)));
    if (url.pathname === '/api/debts' && request.method === 'GET') return sendJson(response, 200, await supabaseRequest('debts', { query: { select: '*', order: 'created_at.desc', limit: '500' } }));
    if (url.pathname === '/api/debts' && request.method === 'POST') return sendJson(response, 201, await createDebt(await readBody(request)));
    if (url.pathname.match(/^\/api\/debts\/[^/]+\/settle$/) && request.method === 'POST') return sendJson(response, 200, await settleDebt(url.pathname.split('/')[3], await readBody(request)));
    if (url.pathname === '/api/budgets' && request.method === 'POST') return sendJson(response, 201, await saveBudget(await readBody(request)));
    if (url.pathname.match(/^\/api\/cash-bank\/\d+\/receipt$/) && request.method === 'GET') {
      return sendJson(response, 200, { url: await getReceiptUrl(url.pathname.split('/')[3]) });
    }
    if (url.pathname === '/api/cash-bank/pending' && request.method === 'GET') {
      return sendJson(response, 200, await supabaseRequest('cash_bank_transactions', { query: { select: 'id,transaction_type,account,category,amount,note,transaction_date,approval_status', approval_status: 'eq.pending', order: 'transaction_date.desc' } }));
    }
    if (url.pathname.match(/^\/api\/cash-bank\/\d+\/approve$/) && request.method === 'POST') {
      return sendJson(response, 200, await approveCashTransaction(url.pathname.split('/')[3], await readBody(request), 'approved'));
    }
    if (url.pathname.match(/^\/api\/cash-bank\/\d+\/reject$/) && request.method === 'POST') {
      return sendJson(response, 200, await approveCashTransaction(url.pathname.split('/')[3], await readBody(request), 'rejected'));
    }
    if (url.pathname === '/api/recurring-expenses' && request.method === 'GET') {
      return sendJson(response, 200, await supabaseRequest('recurring_expenses', { query: { select: 'id,name,category,account,amount,frequency,next_due,is_active', is_active: 'eq.true', order: 'next_due.asc' } }));
    }
    if (url.pathname === '/api/recurring-expenses' && request.method === 'POST') {
      return sendJson(response, 201, await supabaseRequest('recurring_expenses', { method: 'POST', body: validateRecurringExpense(await readBody(request)) }));
    }
    if (url.pathname.match(/^\/api\/settings\/[^/]+$/) && (request.method === 'GET' || request.method === 'PATCH')) {
      const key = decodeURIComponent(url.pathname.split('/')[3]);
      if (request.method === 'GET') return sendJson(response, 200, await supabaseRequest('app_settings', { query: { select: 'key,value', key: `eq.${key}` } }));
      const body = await readBody(request);
      const value = String(body.value || '').trim();
      if (!value || !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error('Nilai pengaturan tidak valid.');
      return sendJson(response, 200, await supabaseRequest('app_settings', { method: 'POST', query: { on_conflict: 'key' }, body: { key, value, updated_at: new Date().toISOString() } }));
    }
    if ((url.pathname.match(/^\/api\/sales\/\d+\/(?:delete|void)$/) && request.method === 'POST') || (url.pathname.match(/^\/api\/sales\/\d+$/) && request.method === 'DELETE')) {
      const saleId = url.pathname.split('/')[3];
      const body = await readBody(request);
      return sendJson(response, 200, await voidSale(saleId, body));
    }
    if (url.pathname.match(/^\/api\/cash-bank\/\d+\/edit$/) && request.method === 'POST') {
      return sendJson(response, 200, await editCashTransaction(url.pathname.split('/')[3], await readBody(request)));
    }
    if ((url.pathname.match(/^\/api\/cash-bank\/\d+\/(?:delete|void)$/) && request.method === 'POST') || (url.pathname.match(/^\/api\/cash-bank\/\d+$/) && request.method === 'DELETE')) {
      const transactionId = url.pathname.split('/')[3];
      return sendJson(response, 200, await voidCashTransaction(transactionId, await readBody(request)));
    }
    if (url.pathname.match(/^\/api\/menu\/\d+\/delete$/) && request.method === 'POST' || url.pathname.match(/^\/api\/menu\/\d+$/) && request.method === 'DELETE') {
      const menuId = url.pathname.split('/').pop();
      const body = await readBody(request);
      requireOwnerPin(body);
      await supabaseRequest('menu_items', { method: 'PATCH', query: { id: `eq.${menuId}` }, body: { is_active: false } });
      await writeAudit('DELETE', 'menu_items', menuId, body.reason);
      return sendJson(response, 200, { message: 'Menu dinonaktifkan.' });
    }
    if (request.method === 'GET') return serveStatic(request, response, url.pathname);
    return sendJson(response, 404, { error: 'Endpoint tidak ditemukan.' });
  } catch (error) {
    console.error(error);
    return sendJson(response, 400, { error: error.message || 'Terjadi kesalahan.' });
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} sedang dipakai. Hentikan server lama lalu jalankan backend ini lagi.`);
    process.exitCode = 1;
    return;
  }
  console.error(error);
});

server.listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`Warung app berjalan di http://127.0.0.1:${PORT}`));