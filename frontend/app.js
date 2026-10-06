const state = { menu: [], combos: [], sales: [], cashBank: [], activities: [], auditLogs: [], reconciliations: [], closings: [], debts: [], budgets: [], pendingSync: [], cart: [], orders: [], posCategory: 'favorites' };
const currency = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
const $ = (selector) => document.querySelector(selector);
const API_BASE_URL = String(window.LAHAP_API_BASE || '').replace(/\/+$/, '');
function apiUrl(url) { return /^https?:\/\//i.test(url) ? url : `${API_BASE_URL}${url.startsWith('/') ? url : `/${url}`}`; }
let apiAccessPromise = null;

function formatDate(value) { return new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function showToast(message, isError = false) { const toast = $('#toast'); toast.textContent = message; toast.className = `toast show${isError ? ' error' : ''}`; setTimeout(() => { toast.className = 'toast'; }, 3000); }
async function authorizedFetch(url, request) {
  const headers = { ...request.headers };
  const accessPin = sessionStorage.getItem('lahap-api-access-pin');
  if (accessPin) headers['X-Lahap-Access-Pin'] = accessPin;
  let response = await fetch(apiUrl(url), { ...request, headers });
  if (response.status !== 401 || url.endsWith('/api/access') || !API_BASE_URL) return response;
  if (!apiAccessPromise) apiAccessPromise = (async () => {
    const pin = window.prompt('Masukkan PIN akses aplikasi untuk menghubungkan ke database:');
    if (!pin) throw new Error('PIN akses diperlukan untuk menghubungkan ke database.');
    const authorization = await fetch(apiUrl('/api/access'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    const authorizationData = await authorization.json();
    if (!authorization.ok) throw new Error(authorizationData.error || 'PIN akses tidak diterima.');
    sessionStorage.setItem('lahap-api-access-pin', pin);
    return pin;
  })().finally(() => { apiAccessPromise = null; });
  const authenticatedPin = await apiAccessPromise;
  response = await fetch(apiUrl(url), { ...request, headers: { ...headers, 'X-Lahap-Access-Pin': authenticatedPin } });
  return response;
}
async function api(url, options = {}) {
  const request = { ...options, headers: { ...(options.headers || {}) } };
  if (request.body && typeof request.body !== 'string') {
    request.body = JSON.stringify(request.body);
    request.headers['Content-Type'] = 'application/json';
  }
  const response = await authorizedFetch(url, request);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Permintaan gagal.');
  return data;
}
function isLocalMode() { return window.location.protocol === 'file:' || localStorage.getItem('lahap-offline-mode') === 'true'; }
let selectedCashReceipt = null;
const localDataKeys = ['menu', 'sales', 'cashBank', 'orders', 'auditLogs', 'reconciliations', 'closings', 'debts', 'budgets', 'pendingSync'];
let backupDatabasePromise;
function openBackupDatabase() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (!backupDatabasePromise) backupDatabasePromise = new Promise(resolve => {
    const request = indexedDB.open('lahap-backup-store', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('snapshots', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return backupDatabasePromise;
}
function appDataSnapshot() { return Object.fromEntries(localDataKeys.map(key => [key, state[key] || []])); }
async function saveAutomaticSnapshot(data) {
  const database = await openBackupDatabase();
  if (!database) return;
  const transaction = database.transaction('snapshots', 'readwrite');
  const store = transaction.objectStore('snapshots');
  store.put({ id: Date.now(), created_at: new Date().toISOString(), data });
  const getAll = store.getAll();
  getAll.onsuccess = () => getAll.result.sort((a, b) => b.id - a.id).slice(30).forEach(item => store.delete(item.id));
  transaction.oncomplete = () => updateBackupStatus();
}
function saveLocalData() {
  const data = appDataSnapshot();
  localStorage.setItem('dapur-arus-data', JSON.stringify(data));
  saveAutomaticSnapshot(data);
}
function loadLocalData() {
  try {
    const saved = JSON.parse(localStorage.getItem('dapur-arus-data')) || {};
    return Object.fromEntries(localDataKeys.map(key => [key, Array.isArray(saved[key]) ? saved[key] : []]));
  } catch { return Object.fromEntries(localDataKeys.map(key => [key, []])); }
}
async function loadLatestAutomaticSnapshot() {
  const database = await openBackupDatabase();
  if (!database) return null;
  return new Promise(resolve => {
    const request = database.transaction('snapshots', 'readonly').objectStore('snapshots').getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.id - a.id)[0]?.data || null);
    request.onerror = () => resolve(null);
  });
}
async function hydrateLocalState(localData = loadLocalData()) {
  if (!localData.menu.length && !localData.cashBank.length && !localData.orders.length) {
    const snapshot = await loadLatestAutomaticSnapshot();
    if (snapshot) localData = Object.fromEntries(localDataKeys.map(key => [key, Array.isArray(snapshot[key]) ? snapshot[key] : []]));
  }
  for (const key of localDataKeys) state[key] = localData[key] || [];
  if (!state.menu.length) state.menu = [
    { id: 1, name: 'Nasi Goreng', price: 18000, category: 'Makanan' },
    { id: 2, name: 'Ayam Geprek', price: 22000, category: 'Makanan' },
    { id: 3, name: 'Es Teh Manis', price: 6000, category: 'Minuman' },
    { id: 4, name: 'Kopi Susu', price: 12000, category: 'Minuman' }
  ];
  return localData;
}
function queueOfflineOperation(endpoint, body) {
  if (window.location.protocol === 'file:') return;
  const operation = { op_id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, endpoint, body: structuredClone(body), queued_at: new Date().toISOString() };
  state.pendingSync.push(operation);
  saveLocalData();
  updateConnectionStatus();
}
function updateConnectionStatus() {
  const label = $('#connection-state');
  if (window.location.protocol !== 'file:' && !navigator.onLine) localStorage.setItem('lahap-offline-mode', 'true');
  if (label) label.textContent = isLocalMode() ? `Mode lokal · ${state.pendingSync.length} menunggu sinkronisasi` : navigator.onLine ? 'Sistem aktif' : 'Offline';
}
async function flushOfflineQueue() {
  if (!navigator.onLine || !state.pendingSync?.length || window.location.protocol === 'file:') return;
  try {
    while (state.pendingSync.length) {
      const batch = state.pendingSync.slice(0, 100);
      const result = await authorizedFetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operations: batch }) });
      if (!result.ok) return;
      const response = await result.json();
      const completed = new Set((response.results || []).filter(item => item.ok).map(item => item.op_id));
      if (!completed.size) return;
      state.pendingSync = state.pendingSync.filter(item => !completed.has(item.op_id));
      saveLocalData();
    }
    if (!state.pendingSync.length) localStorage.removeItem('lahap-offline-mode');
    updateConnectionStatus();
  } catch {}
}
async function updateBackupStatus() {
  const target = $('#backup-status');
  if (!target) return;
  const database = await openBackupDatabase();
  if (!database) { target.textContent = 'Unduh backup JSON untuk menyimpan salinan di luar browser.'; return; }
  const request = database.transaction('snapshots', 'readonly').objectStore('snapshots').getAll();
  request.onsuccess = () => {
    const latest = request.result.sort((a, b) => b.id - a.id)[0];
    target.textContent = latest ? `Snapshot lokal terakhir ${formatDate(latest.created_at)} · ${request.result.length} tersimpan` : 'Snapshot otomatis aktif · unduh salinan berkala ke perangkat lain.';
  };
}
function downloadBackup() {
  const payload = { app: 'lahap', version: 1, created_at: new Date().toISOString(), data: appDataSnapshot() };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `lahap-backup-${new Date().toISOString().slice(0, 10)}.json`; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  showToast('Backup JSON berhasil diunduh. Simpan salinannya di perangkat atau cloud lain.');
}
async function restoreBackup(file) {
  try {
    const backup = JSON.parse(await file.text());
    if (backup.app !== 'lahap' || !backup.data || !localDataKeys.every(key => Array.isArray(backup.data[key]))) throw new Error('Berkas bukan backup lahap yang valid.');
    if (!window.confirm(`Pulihkan backup dari ${formatDate(backup.created_at)}? Data saat ini di browser akan diganti.`)) return;
    for (const key of localDataKeys) state[key] = backup.data[key];
    saveLocalData();
    renderMenu(); renderQuickMenu(); renderKitchenDisplay(); renderDashboard();
    showToast('Backup dipulihkan ke browser ini.');
  } catch (error) { showToast(error.message || 'Backup tidak dapat dibaca.', true); }
}
function menuIcon(category) { return category === 'Minuman' ? '🥤' : category === 'Snack' ? '🍟' : '🍛'; }
let featuredMenuIndex = 0;
function featuredMenuItems() {
  return (state.menu || []).slice().sort((a, b) => Number(Boolean(b.is_favorite)) - Number(Boolean(a.is_favorite))).slice(0, 4);
}
function renderFeaturedMenu() {
  const menuItems = featuredMenuItems();
  const featuredMenu = menuItems[featuredMenuIndex % menuItems.length];
  const image = $('#featured-menu-image');
  if (!featuredMenu) {
    $('#featured-category').textContent = 'Menu';
    $('#featured-menu-name').textContent = 'Belum ada menu tersedia';
    $('#featured-menu-price').textContent = '';
    $('#featured-menu-icon').textContent = '🍽️';
    $('#featured-position').textContent = '0 / 0';
    image.hidden = true;
    image.removeAttribute('src');
    return;
  }
  $('#featured-category').textContent = featuredMenu.category || 'Menu';
  $('#featured-menu-name').textContent = featuredMenu.name;
  $('#featured-menu-price').textContent = currency.format(featuredMenu.price);
  $('#featured-menu-icon').textContent = menuIcon(featuredMenu.category);
  $('#featured-position').textContent = `${featuredMenuIndex + 1} / ${menuItems.length}`;
  image.hidden = !featuredMenu.image_url;
  if (featuredMenu.image_url) image.src = featuredMenu.image_url;
  else image.removeAttribute('src');
}
function stepFeaturedMenu(direction) {
  const menuCount = featuredMenuItems().length;
  if (!menuCount) return;
  featuredMenuIndex = (featuredMenuIndex + direction + menuCount) % menuCount;
  renderFeaturedMenu();
}
let selectedMenuImage = null;
function compressImage(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => { const image = new Image(); image.onload = () => { const maxSize = 900; const ratio = Math.min(1, maxSize / Math.max(image.width, image.height)); const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * ratio); canvas.height = Math.round(image.height * ratio); canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height); resolve(canvas.toDataURL('image/jpeg', .82)); }; image.onerror = reject; image.src = reader.result; }; reader.onerror = reject; reader.readAsDataURL(file); }); }
function localDateTimeValue(date = new Date()) { const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return local.toISOString().slice(0, 16); }
function renderReceiptPreview(source) { const preview = $('#receipt-preview'); preview.classList.toggle('hidden', !source); preview.innerHTML = source ? `<img src="${source}" alt="Pratinjau bukti transaksi"><span>Bukti siap disimpan</span>` : ''; }
async function openReceipt(transactionId, localSource) { try { const url = localSource?.startsWith('data:') ? localSource : (await api(`/api/cash-bank/${transactionId}/receipt`)).url; window.open(url, '_blank', 'noopener'); } catch (error) { showToast(error.message, true); } }
function showMenuImagePreview(source) { $('#menu-image-preview').innerHTML = source ? `<img src="${source}" alt="Pratinjau foto makanan">` : '<span>Pratinjau foto akan muncul di sini</span>'; }
function renderQuickMenu() { const query = $('#pos-search').value.trim().toLowerCase(); const items = state.menu.filter(item => (state.posCategory === 'all' || item.category === state.posCategory) && (!query || `${item.name} ${item.code || ''}`.toLowerCase().includes(query))).sort((a, b) => Number(Boolean(b.is_favorite)) - Number(Boolean(a.is_favorite))); const combos = state.combos.filter(combo => !query || combo.name.toLowerCase().includes(query)); const comboHtml = combos.map(combo => `<button class="menu-tile combo-tile" type="button" data-combo-id="${combo.id}"><span class="menu-emoji">🎁</span><strong>${combo.name}</strong><small>${currency.format(combo.price)}</small><span class="menu-code">Paket hemat</span></button>`).join(''); const itemHtml = items.map(item => `<button class="menu-tile" type="button" data-menu-id="${item.id}">${item.image_url ? `<img class="menu-image" src="${item.image_url}" alt="${item.name}" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'">` : ''}<span class="menu-emoji"${item.image_url ? ' style="display:none"' : ''}>${menuIcon(item.category)}</span><strong>${item.name}</strong><small>${currency.format(item.price)}</small><span class="menu-code">${item.code || 'Menu aktif'}</span><span class="menu-favorite" data-menu-id="${item.id}" title="Pin favorit">${item.is_favorite ? '★' : '☆'}</span><span class="menu-delete" data-menu-id="${item.id}" title="Hapus menu">×</span></button>`).join(''); $('#pos-menu-count').textContent = `${state.menu.length} menu tersedia`; $('#menu-result-count').textContent = `${items.length + combos.length} menu`; $('#quick-menu-grid').innerHTML = comboHtml + itemHtml || '<p class="empty-state">Menu tidak ditemukan.</p>'; }
const renderQuickMenuBase = renderQuickMenu;
renderQuickMenu = function() {
  const showingFavorites = state.posCategory === 'favorites';
  const allMenuItems = state.menu;
  const allCombos = state.combos;
  if (showingFavorites) {
    state.menu = allMenuItems.filter(item => item.is_favorite);
    state.combos = [];
    state.posCategory = 'all';
  }
  renderQuickMenuBase();
  if (showingFavorites) {
    state.menu = allMenuItems;
    state.combos = allCombos;
    state.posCategory = 'favorites';
    $('#pos-menu-count').textContent = `${state.menu.length} menu tersedia`;
    if (!document.querySelector('#quick-menu-grid .menu-tile')) $('#quick-menu-grid').innerHTML = '<p class="empty-state">Belum ada menu berbintang.</p>';
  }
  document.querySelectorAll('#quick-menu-grid .menu-tile[data-menu-id]').forEach(tile => {
    if (tile.querySelector('.menu-edit')) return;
    const menuId = tile.dataset.menuId;
    const menu = state.menu.find(item => String(item.id) === menuId);
    const favorite = tile.querySelector('.menu-favorite');
    if (favorite) favorite.style.right = '62px';
    const edit = document.createElement('span');
    edit.className = 'menu-edit';
    edit.dataset.menuId = menuId;
    edit.title = 'Edit menu';
    edit.setAttribute('role', 'button');
    edit.setAttribute('tabindex', '0');
    edit.setAttribute('aria-label', `Edit ${menu?.name || 'menu'}`);
    edit.textContent = '✎';
    tile.append(edit);
  });
};

function getPaymentMethods() {
  const splitMode = $('#payment-split').value;
  const total = cartTotals().total;
  if (splitMode !== 'split') {
    const method = $('#pos-payment').value;
    return [{ method, amount: total }];
  }
  const methods = [
    { method: 'Cash', amount: Number($('#split-cash').value || 0) },
    { method: 'QRIS', amount: Number($('#split-qris').value || 0) },
    { method: 'Transfer', amount: Number($('#split-transfer').value || 0) }
  ].filter(item => item.amount > 0);
  if (!methods.length) return [{ method: $('#pos-payment').value, amount: total }];
  const sum = methods.reduce((acc, item) => acc + item.amount, 0);
  if (sum >= total) return methods;
  const primary = $('#pos-payment').value;
  return [...methods, { method: primary, amount: total - sum }];
}
function renderKitchenDisplay() {
  const active = (state.orders || []).filter(order => order.status !== 'paid').slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  $('#kitchen-display').innerHTML = active.length ? active.map(order => `<div class="kitchen-order"><strong>Meja ${order.table_number || 'Takeaway'} · ${order.source || 'Walk in'}</strong><small>${new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' }).format(new Date(order.created_at))}</small><small>${order.items.map(item => `${item.name} x${item.quantity}${item.note ? ` (${item.note})` : ''}`).join(', ')}</small><div class="kitchen-order-actions"><button class="primary-small-button" data-kitchen-id="${order.id}" data-kitchen-status="in_kitchen" type="button">Masuk dapur</button><button class="outline-button" data-kitchen-id="${order.id}" data-kitchen-status="served" type="button">Siap</button><button class="danger-button" data-kitchen-id="${order.id}" data-kitchen-status="paid" type="button">Lunas</button></div></div>`).join('') : '<p class="empty-state">Tidak ada pesanan masuk.</p>';
}
function cartSubtotal() { return state.cart.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0); }
function cartTotals() { const subtotal = cartSubtotal(); const type = $('#discount-type').value; const value = Number($('#discount-value').value || 0); const discount = type === 'percent' ? subtotal * Math.min(value, 100) / 100 : type === 'amount' ? Math.min(value, subtotal) : 0; return { subtotal, discount, tax: 0, service: 0, total: Math.round(subtotal - discount) }; }
function renderCart() { const totals = cartTotals(); $('#cart-count').textContent = `${state.cart.reduce((sum, item) => sum + item.quantity, 0)} item`; $('#cart-items').innerHTML = state.cart.length ? state.cart.map(item => `<div class="cart-row"><div><strong>${item.name}</strong><br><small>${currency.format(item.price)} x ${item.quantity}</small><br><input class="cart-note" data-id="${item.id}" value="${item.note || ''}" placeholder="Catatan item"></div><button type="button" class="remove-cart" data-id="${item.id}">×</button></div>`).join('') : '<p class="empty-state">Pilih menu untuk mulai.</p>'; $('#cart-subtotal').textContent = currency.format(totals.subtotal); $('#cart-discount').textContent = `- ${currency.format(totals.discount)}`; $('#cart-total').textContent = currency.format(totals.total); const received = Number($('#cash-received').value || 0); $('#change-label').textContent = `Kembalian: ${currency.format(Math.max(received - totals.total, 0))}`; }
async function saveQuickOrder() { if (!state.cart.length) return showToast('Pilih menu terlebih dahulu.', true); const totals = cartTotals(); const payments = getPaymentMethods(); const received = Number($('#cash-received').value || 0); const cashTotal = payments.filter(item => item.method === 'Cash').reduce((sum, item) => sum + item.amount, 0); if (cashTotal > 0 && received < cashTotal) return showToast('Uang diterima kurang dari total cash.', true); const payload = { order_type: $('#order-type').value, table_number: $('#table-number').value || null, cashier_name: $('#pos-cashier').value.trim() || 'Kasir', order_status: $('#order-status').value, note: $('#order-note').value.trim(), source: $('#order-source').value, platform_fee: Number($('#platform-fee').value || 0), discount_type: $('#discount-type').value, discount_value: Number($('#discount-value').value || 0), tax_percent: 0, service_percent: 0, items: state.cart.map(item => ({ menu_item_id: item.id, name: item.name, quantity: item.quantity, note: item.note || '', price: Number(item.price) })), payments: payments.map(item => ({ ...item, cash_received: item.method === 'Cash' ? received : 0 })) }; try { if (isLocalMode()) { const date = new Date().toISOString(); const orderId = Date.now(); const order = { id: orderId, created_at: date, status: $('#order-status').value, order_type: $('#order-type').value, table_number: $('#table-number').value || null, cashier_name: payload.cashier_name, source: $('#order-source').value, total_amount: totals.total, payments, note: $('#order-note').value.trim(), items: state.cart.map(item => ({ id: item.id, name: item.name, category: state.menu.find(menu => String(menu.id) === String(item.id))?.category || 'Lainnya', quantity: item.quantity, note: item.note || '', price: Number(item.price) })) }; state.orders.push(order); payments.forEach(({ method, amount }) => { const account = method === 'Cash' ? 'Kas' : 'Bank'; state.cashBank.unshift({ id: Date.now() + Math.random(), transaction_type: 'Income', account, category: 'Penjualan POS', amount, note: `${order.order_type} - ${order.table_number ? `Meja ${order.table_number}` : 'Takeaway'}`, transaction_date: date, cashier_name: payload.cashier_name, payment_method: method, approval_status: 'approved' }); }); if ($('#order-source').value !== 'walk_in' && Number($('#platform-fee').value || 0) > 0) { state.cashBank.unshift({ id: Date.now() + Math.random(), transaction_type: 'Expense', account: 'Bank', category: `Komisi ${$('#order-source').value}`, amount: Number($('#platform-fee').value || 0), note: `Komisi platform ${$('#order-source').value}`, transaction_date: date, approval_status: 'approved' }); } queueOfflineOperation('/api/orders', payload); saveLocalData(); } else await api('/api/orders', { method: 'POST', body: payload }); state.cart = []; $('#order-note').value = ''; $('#order-status').value = 'open'; $('#table-number').value = ''; $('#split-cash').value = 0; $('#split-qris').value = 0; $('#split-transfer').value = 0; $('#platform-fee').value = 0; renderCart(); renderKitchenDisplay(); showToast('Pesanan berhasil disimpan.'); renderDashboard(); if (!isLocalMode()) await loadData(); } catch (error) { showToast(error.message, true); } }
function exportCsv() {
  const rows = [['Tanggal', 'Keterangan', 'Akun', 'Pemasukan', 'Pengeluaran', 'Saldo'], ...getCashFlowRows().map(item => [new Date(item.date).toLocaleString('id-ID'), item.name, item.account, item.income, item.expense, item.balance])];
  const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
  const link = document.createElement('a'); const objectUrl = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8;' }));
  link.href = objectUrl; link.download = `laporan-lahap-${new Date().toISOString().slice(0, 10)}.csv`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); showToast('Laporan CSV lahap berhasil dibuat.');
}
function exportExcel() {
  const rows = getCashFlowRows();
  const income = rows.reduce((sum, item) => sum + item.income, 0);
  const expense = rows.reduce((sum, item) => sum + item.expense, 0);
  const balance = income - expense;
  const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  const tableRows = rows.slice().reverse().map(item => `<tr><td>${escapeHtml(new Date(item.date).toLocaleString('id-ID'))}</td><td>${escapeHtml(item.name)}${item.note ? `<br><small>${escapeHtml(item.note)}</small>` : ''}</td><td>${escapeHtml(item.account)}</td><td class="money income">${item.income ? currency.format(item.income) : '-'}</td><td class="money expense">${item.expense ? currency.format(item.expense) : '-'}</td><td class="money">${currency.format(item.balance)}</td></tr>`).join('');
  const html = `<html><head><meta charset="UTF-8"><style>body{font-family:Arial;color:#292622}h1{color:#d9653b;font-size:22px}p{color:#7f776e}.summary{border-collapse:separate;border-spacing:8px;margin:12px 0}.summary td{padding:12px 18px;background:#fff0e7;border:1px solid #eadfd4}.summary strong{display:block;font-size:17px}.report{border-collapse:collapse;width:100%;font-size:12px}.report th{padding:10px;background:#75618d;color:white;text-align:left}.report td{padding:9px;border:1px solid #eadfd4}.money{text-align:right}.income{color:#3e735d}.expense{color:#a54936}.report tr:nth-child(even){background:#fffaf5}small{color:#7f776e}</style></head><body><h1>Laporan Arus Kas - lahap</h1><p>Dicetak: ${escapeHtml(new Date().toLocaleString('id-ID'))} | Periode: ${escapeHtml($('#report-period').textContent)}</p><table class="summary"><tr><td>Pemasukan<strong>${currency.format(income)}</strong></td><td>Pengeluaran<strong>${currency.format(expense)}</strong></td><td>Saldo bersih<strong>${currency.format(balance)}</strong></td><td>Transaksi<strong>${rows.length}</strong></td></tr></table><table class="report"><thead><tr><th>Tanggal</th><th>Keterangan</th><th>Akun</th><th>Pemasukan</th><th>Pengeluaran</th><th>Saldo berjalan</th></tr></thead><tbody>${tableRows || '<tr><td colspan="6">Belum ada transaksi.</td></tr>'}</tbody></table></body></html>`;
  const link = document.createElement('a'); const objectUrl = URL.createObjectURL(new Blob([html], { type: 'application/vnd.ms-excel' }));
  link.href = objectUrl; link.download = `laporan-lahap-${new Date().toISOString().slice(0, 10)}.xls`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); showToast('Laporan Excel lahap berhasil dibuat.');
}

function renderMenu() { renderQuickMenu(); }
function getActivities() {
  return [...state.sales.map(item => ({ id: item.id, source: 'sale', date: item.sale_date, name: item.menu_items?.name || 'Penjualan', account: item.payment_method, amount: item.total_amount, type: 'Income', voided_at: item.voided_at, voided_by: item.voided_by, void_reason: item.void_reason })), ...state.cashBank.map(item => ({ id: item.id, source: 'cash', date: item.transaction_date, name: item.category, account: item.account, amount: item.amount, type: item.transaction_type, note: item.note, receipt_path: item.receipt_path, approval_status: item.approval_status, voided_at: item.voided_at, voided_by: item.voided_by, void_reason: item.void_reason }))].sort((a, b) => new Date(b.date) - new Date(a.date));
}
function getFilteredActivities() {
  const search = $('#activity-search').value.trim().toLowerCase();
  const type = $('#activity-type').value;
  const dateFilter = $('#activity-date').value;
  const now = Date.now();
  return state.activities.filter(item => {
    const date = new Date(item.date).getTime();
    const text = `${item.name} ${item.note || ''} ${item.account}`.toLowerCase();
    return (!search || text.includes(search)) && (type === 'all' || item.type === type) && (dateFilter === 'all' || (dateFilter === 'today' ? new Date(item.date).toDateString() === new Date().toDateString() : now - date <= 7 * 24 * 60 * 60 * 1000));
  }).slice(0, 100);
}
function getCashFlowRows() {
  const search = $('#activity-search').value.trim().toLowerCase();
  const type = $('#activity-type').value;
  const dateFilter = $('#activity-date').value;
  const now = Date.now();
  const filtered = approvedCashTransactions().filter(item => {
    const date = new Date(item.transaction_date).getTime();
    const text = `${item.category} ${item.note || ''} ${item.account}`.toLowerCase();
    return (!search || text.includes(search)) && (type === 'all' || item.transaction_type === type) && (dateFilter === 'all' || (dateFilter === 'today' ? new Date(item.transaction_date).toDateString() === new Date().toDateString() : now - date <= 7 * 24 * 60 * 60 * 1000));
  }).sort((a, b) => new Date(a.transaction_date) - new Date(b.transaction_date));
  let balance = 0;
  return filtered.map(item => {
    const income = item.transaction_type === 'Income' ? Number(item.amount) : 0;
    const expense = item.transaction_type === 'Expense' ? Number(item.amount) : 0;
    balance += income - expense;
    return { date: item.transaction_date, name: item.category, note: item.note, account: item.account, income, expense, balance };
  });
}
function renderCashFlowReport() {
  const rows = getCashFlowRows();
  const income = rows.reduce((sum, item) => sum + item.income, 0);
  const expense = rows.reduce((sum, item) => sum + item.expense, 0);
  $('#report-income').textContent = currency.format(income);
  $('#report-expense').textContent = currency.format(expense);
  $('#report-balance').textContent = currency.format(income - expense);
  $('#report-count').textContent = rows.length;
  $('#report-period').textContent = $('#activity-date').value === 'today' ? 'Hari ini' : $('#activity-date').value === 'week' ? '7 hari terakhir' : 'Semua transaksi';
  $('#report-body').innerHTML = rows.length ? rows.slice().reverse().map(item => `<tr><td>${formatDate(item.date)}</td><td><strong>${item.name}</strong>${item.note ? `<br><small>${item.note}</small>` : ''}</td><td>${item.account}</td><td class="align-right positive">${item.income ? currency.format(item.income) : '-'}</td><td class="align-right negative">${item.expense ? currency.format(item.expense) : '-'}</td><td class="align-right">${currency.format(item.balance)}</td></tr>`).join('') : '<tr><td colspan="6" class="empty-state">Belum ada data arus kas.</td></tr>';
}
function accountBalance(account) {
  return approvedCashTransactions().filter(item => item.account === account).reduce((sum, item) => sum + (item.transaction_type === 'Income' ? Number(item.amount) : -Number(item.amount)), 0);
}
function renderFinanceTools() {
  const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  const bankTransactions = state.cashBank.filter(item => item.account === 'Bank' && item.approval_status !== 'pending' && item.reconciliation_status !== 'matched');
  $('#reconcile-transactions').innerHTML = bankTransactions.map(item => `<option value="${item.id}">${formatDate(item.transaction_date)} · ${item.category} · ${item.transaction_type === 'Income' ? '+' : '-'}${currency.format(item.amount)}</option>`).join('');
  $('#reconciliation-history').innerHTML = state.reconciliations.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 8).map(item => `<div class="finance-list-row"><strong>${formatDate(item.statement_date)} · Selisih ${currency.format(item.difference)}</strong><small>Saldo aplikasi ${currency.format(item.app_balance)} · rekening koran ${currency.format(item.statement_balance)} · ${escapeHtml(item.actor)}</small></div>`).join('') || '<p class="empty-state">Belum ada rekonsiliasi.</p>';
  const cashNow = accountBalance('Kas');
  $('#cash-closing-history').innerHTML = state.closings.slice().sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at)).slice(0, 8).map(item => `<div class="finance-list-row"><strong>${escapeHtml(item.cashier_name)} · Selisih ${currency.format(item.difference)}</strong><small>${formatDate(item.closed_at)} · expected ${currency.format(item.expected_cash)} · aktual ${currency.format(item.actual_cash)}</small></div>`).join('') || `<p class="empty-state">Kas yang diharapkan saat ini ${currency.format(cashNow)}. Belum ada penutupan tersimpan.</p>`;
  $('#debt-list').innerHTML = state.debts.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map(debt => `<div class="finance-list-row"><strong>${debt.debt_type === 'receivable' ? 'Piutang' : 'Hutang'} · ${escapeHtml(debt.party_name)}</strong><small>${escapeHtml(debt.description)} · sisa ${currency.format(debt.remaining_amount)}${debt.due_date ? ` · jatuh tempo ${escapeHtml(debt.due_date)}` : ''}</small>${debt.status !== 'paid' ? `<button class="outline-button debt-settle" data-id="${debt.id}" data-remaining="${debt.remaining_amount}" type="button">Bayar / terima</button>` : '<small>Lunas</small>'}</div>`).join('') || '<p class="empty-state">Belum ada hutang atau piutang.</p>';
  const period = $('#budget-month').value || new Date().toISOString().slice(0, 7);
  const monthTransactions = state.cashBank.filter(item => item.transaction_type === 'Expense' && item.transaction_role !== 'transfer' && item.transaction_role !== 'settlement' && item.transaction_role !== 'void_reversal' && !item.voided_at && item.approval_status !== 'pending' && String(item.transaction_date).slice(0, 7) === period);
  $('#budget-list').innerHTML = state.budgets.filter(item => String(item.period_month).slice(0, 7) === period).map(budget => { const spent = monthTransactions.filter(item => item.category === budget.category).reduce((sum, item) => sum + Number(item.amount), 0); const ratio = Number(budget.amount) > 0 ? Math.min(100, spent / Number(budget.amount) * 100) : 0; return `<div class="finance-list-row"><div class="finance-list-line"><strong>${escapeHtml(budget.category)}</strong><small>${currency.format(spent)} / ${currency.format(budget.amount)}${spent > Number(budget.amount) ? ' · MELEBIHI' : ''}</small></div><div class="budget-track${spent > Number(budget.amount) ? ' over' : ''}"><i style="width:${ratio}%"></i></div></div>`; }).join('') || '<p class="empty-state">Belum ada anggaran untuk bulan ini.</p>';
  const periodIncome = state.cashBank.filter(item => item.transaction_type === 'Income' && item.transaction_role !== 'transfer' && item.transaction_role !== 'settlement' && item.transaction_role !== 'void_reversal' && item.approval_status !== 'pending' && item.approval_status !== 'rejected' && !item.voided_at && String(item.transaction_date).slice(0, 7) === period).reduce((sum, item) => sum + Number(item.amount), 0);
  const expenseRows = state.cashBank.filter(item => item.transaction_type === 'Expense' && item.transaction_role !== 'transfer' && item.transaction_role !== 'settlement' && item.transaction_role !== 'void_reversal' && item.approval_status !== 'pending' && item.approval_status !== 'rejected' && String(item.transaction_date).slice(0, 7) === period);
  const expenseTotal = expenseRows.reduce((sum, item) => sum + Number(item.amount), 0);
  $('#pl-income').textContent = currency.format(periodIncome);
  $('#pl-expenses').textContent = currency.format(expenseTotal);
  $('#pl-profit').textContent = currency.format(periodIncome - expenseTotal);
  $('#pl-margin').textContent = `${periodIncome ? Math.round((periodIncome - expenseTotal) / periodIncome * 100) : 0}%`;
  const categories = [...new Set(expenseRows.map(item => item.category))].map(category => ({ category, amount: expenseRows.filter(item => item.category === category).reduce((sum, item) => sum + Number(item.amount), 0) })).sort((a, b) => b.amount - a.amount);
  const maxExpense = Math.max(1, ...categories.map(item => item.amount));
  $('#expense-composition').innerHTML = categories.map(item => `<div class="expense-category"><div class="finance-list-line"><strong>${escapeHtml(item.category)}</strong><small>${currency.format(item.amount)}</small></div><div class="budget-track"><i style="width:${item.amount / maxExpense * 100}%"></i></div></div>`).join('') || '<p class="empty-state">Belum ada pengeluaran pada periode ini.</p>';
}
function renderInsights() {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();
  const monthRows = approvedCashTransactions().filter(item => { const date = new Date(item.transaction_date); return date.getMonth() === month && date.getFullYear() === year; });
  const monthlyIncome = monthRows.filter(item => item.transaction_type === 'Income').reduce((sum, item) => sum + Number(item.amount), 0);
  const monthlyExpense = monthRows.filter(item => item.transaction_type === 'Expense').reduce((sum, item) => sum + Number(item.amount), 0);
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const projection = (monthlyIncome - monthlyExpense) / Math.max(dayOfMonth, 1) * daysInMonth;
  const salesRows = monthRows.filter(item => item.transaction_type === 'Income' && /penjualan/i.test(item.category) && !item.voided_at);
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, total: 0 }));
  salesRows.forEach(item => { hours[new Date(item.transaction_date).getHours()].total += Number(item.amount); });
  const peak = hours.reduce((winner, item) => item.total > winner.total ? item : winner, { hour: 0, total: 0 });
  $('#monthly-revenue').textContent = currency.format(monthlyIncome);
  $('#monthly-orders').textContent = `${salesRows.length} transaksi penjualan`;
  $('#cash-projection').textContent = currency.format(projection);
  $('#peak-hour').textContent = peak.total ? `${String(peak.hour).padStart(2, '0')}:00 - ${String((peak.hour + 1) % 24).padStart(2, '0')}:00` : 'Belum ada data';
  $('#peak-hour-detail').textContent = peak.total ? `${currency.format(peak.total)} omzet pada jam tersibuk` : 'Catat penjualan untuk melihat pola jam sibuk.';
  const maxHour = Math.max(...hours.map(item => item.total), 1);
  $('#peak-chart').innerHTML = hours.filter((item, index) => index % 2 === 0).map(item => `<span class="peak-bar${item.hour === peak.hour ? ' active' : ''}" style="--height:${Math.max(4, item.total / maxHour * 28)}px" title="${String(item.hour).padStart(2, '0')}:00"></span>`).join('');
  $('#tax-estimate').textContent = $('#tax-toggle').checked ? currency.format(monthlyIncome * .005) : 'Nonaktif';
  $('#closing-summary').textContent = `Omzet periode ${$('#dashboard-period').selectedOptions[0].textContent.toLowerCase()} ${$('#sales-total').textContent} · Saldo bersih ${$('#balance-total').textContent}`;
}
function analyticsOrders() {
  const orders = (state.orders || []).filter(order => !['void', 'refunded'].includes(order.status)).map(order => ({ ...order, date: order.created_at || order.sale_date, total: Number(order.total_amount || 0), items: (order.items || order.order_items || []).map(item => ({ name: item.name || item.menu_items?.name || 'Menu', category: item.category || item.menu_items?.category || 'Lainnya', quantity: Number(item.quantity || 0), unit_price: Number(item.unit_price || item.price || 0) })), payments: order.payments || [] }));
  const legacy = (state.sales || []).filter(sale => !sale.voided_at).map(sale => ({ date: sale.sale_date, total: Number(sale.total_amount || 0), cashier_name: sale.cashier_name || 'Kasir', items: [{ name: sale.menu_items?.name || 'Penjualan', category: sale.menu_items?.category || 'Lainnya', quantity: Number(sale.quantity || 1), unit_price: Number(sale.unit_price || sale.total_amount || 0) }], payments: [{ method: sale.payment_method || 'Tidak diketahui', amount: Number(sale.total_amount || 0) }] }));
  return [...orders, ...legacy];
}
function renderSalesAnalytics() {
  const allOrders = analyticsOrders();
  const start = new Date(`${$('#dashboard-from').value}T00:00:00`);
  const end = new Date(`${$('#dashboard-to').value}T23:59:59.999`);
  const currentOrders = allOrders.filter(order => { const date = new Date(order.date); return date >= start && date <= end; });
  const previousType = $('#comparison-period').value;
  let previousStart = new Date(start);
  let previousEnd = new Date(end);
  if (previousType === 'day') { previousStart.setDate(previousStart.getDate() - 1); previousEnd.setDate(previousEnd.getDate() - 1); }
  else if (previousType === 'week') { previousStart.setDate(previousStart.getDate() - 7); previousEnd.setDate(previousEnd.getDate() - 7); }
  else { previousStart.setMonth(previousStart.getMonth() - 1); previousEnd.setMonth(previousEnd.getMonth() - 1); }
  const previousOrders = allOrders.filter(order => { const date = new Date(order.date); return date >= previousStart && date <= previousEnd; });
  const salesTotal = rows => rows.reduce((sum, order) => sum + order.total, 0);
  const currentTotal = salesTotal(currentOrders);
  const previousTotal = salesTotal(previousOrders);
  const change = previousTotal ? (currentTotal - previousTotal) / previousTotal * 100 : currentTotal ? 100 : 0;
  $('#comparison-current').textContent = currency.format(currentTotal);
  $('#comparison-previous').textContent = currency.format(previousTotal);
  $('#comparison-change').textContent = `${change > 0 ? '+' : ''}${Math.round(change)}%`;
  $('#comparison-change').className = change >= 0 ? 'positive' : 'negative';
  $('#average-ticket').textContent = currency.format(currentOrders.length ? currentTotal / currentOrders.length : 0);
  const groupTotals = (entries, keyFn, valueFn) => {
    const totals = new Map();
    entries.forEach(entry => { const key = keyFn(entry) || 'Lainnya'; totals.set(key, (totals.get(key) || 0) + valueFn(entry)); });
    return [...totals.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 6);
  };
  const breakdowns = [];
  breakdowns.push({ title: 'Penjualan per kategori', rows: groupTotals(currentOrders.flatMap(order => order.items.map(item => ({ ...item, total: item.quantity * item.unit_price }))), item => item.category, item => item.total) });
  breakdowns.push({ title: 'Penjualan per kasir', rows: groupTotals(currentOrders, order => order.cashier_name || 'Kasir', order => order.total) });
  breakdowns.push({ title: 'Metode pembayaran', rows: groupTotals(currentOrders.flatMap(order => order.payments.length ? order.payments.map(payment => ({ method: payment.method, amount: Number(payment.amount) })) : []), item => item.method, item => item.amount) });
  const timeMode = $('#comparison-period').value === 'day' ? 'hour' : 'weekday';
  breakdowns.push({ title: timeMode === 'hour' ? 'Penjualan per jam' : 'Penjualan per hari', rows: groupTotals(currentOrders, order => { const date = new Date(order.date); return timeMode === 'hour' ? `${String(date.getHours()).padStart(2, '0')}.00` : new Intl.DateTimeFormat('id-ID', { weekday: 'long' }).format(date); }, order => order.total) });
  const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  $('#sales-breakdowns').innerHTML = breakdowns.map(group => { const maximum = Math.max(1, ...group.rows.map(row => row.value)); return `<article class="analysis-panel"><h3>${group.title}</h3>${group.rows.length ? group.rows.map(row => `<div class="analysis-row"><div><span>${escapeHtml(row.label)}</span><strong>${currency.format(row.value)}</strong></div><i><b style="width:${row.value / maximum * 100}%"></b></i></div>`).join('') : '<p class="empty-state">Belum ada data untuk periode ini.</p>'}</article>`; }).join('');
  const month = $('#dashboard-to').value.slice(0, 7);
  const expenses = state.cashBank.filter(item => item.transaction_type === 'Expense' && !['transfer', 'settlement', 'void_reversal'].includes(item.transaction_role) && item.approval_status !== 'pending' && item.approval_status !== 'rejected' && !item.voided_at && String(item.transaction_date).slice(0, 7) === month);
  const fixed = expenses.filter(item => ['Gaji', 'Listrik', 'Sewa'].includes(item.category)).reduce((sum, item) => sum + Number(item.amount), 0);
  const variable = expenses.filter(item => ['Bahan baku', 'Gas', 'Operasional lain'].includes(item.category)).reduce((sum, item) => sum + Number(item.amount), 0);
  const monthOrders = allOrders.filter(order => String(order.date).slice(0, 7) === month);
  const revenue = salesTotal(monthOrders);
  const contributionRate = revenue ? Math.max(0, (revenue - variable) / revenue) : 0;
  const targetProfit = Number($('#break-even-target').value || 0);
  const breakEven = contributionRate > 0 ? (fixed + targetProfit) / contributionRate : 0;
  $('#break-even-value').textContent = breakEven ? currency.format(Math.ceil(breakEven)) : 'Belum cukup data';
  $('#break-even-detail').textContent = `Biaya tetap ${currency.format(fixed)} · margin kontribusi ${Math.round(contributionRate * 100)}%${targetProfit ? ` · target laba ${currency.format(targetProfit)}` : ''}. Estimasi berdasarkan kategori biaya yang dipilih.`;
}
function printDailyPdf() {
  const today = localDateInput(new Date());
  const orders = analyticsOrders().filter(order => localDateInput(new Date(order.date)) === today);
  const orderRevenue = orders.reduce((sum, order) => sum + order.total, 0);
  const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  const rows = orders.map(order => `<tr><td>${escapeHtml(formatDate(order.date))}</td><td>${order.items.map(item => `${escapeHtml(item.name)} ×${item.quantity}`).join(', ')}</td><td>${escapeHtml(order.cashier_name || 'Kasir')}</td><td class="amount">${currency.format(order.total)}</td></tr>`).join('');
  const income = approvedCashTransactions().filter(item => item.transaction_type === 'Income' && localDateInput(new Date(item.transaction_date)) === today).reduce((sum, item) => sum + Number(item.amount), 0);
  const expenses = approvedCashTransactions().filter(item => item.transaction_type === 'Expense' && localDateInput(new Date(item.transaction_date)) === today).reduce((sum, item) => sum + Number(item.amount), 0);
  const report = window.open('', '_blank', 'width=900,height=700');
  if (!report) return showToast('Izinkan pop-up untuk membuat laporan PDF.', true);
  report.document.write(`<!doctype html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Laporan Harian Lahap</title><style>
    :root{--ink:#292622;--muted:#716b78;--green:#75618d;--green-pale:#f2edf7;--orange:#a77bc4;--line:#e8e0ef;--paper:#fffefe}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 'DM Sans',Arial,sans-serif}.page{max-width:980px;margin:0 auto;padding:42px}.masthead{display:flex;align-items:center;justify-content:space-between;gap:20px;padding-bottom:22px;border-bottom:1px solid var(--line)}.brand{display:flex;align-items:center;gap:12px}.brand-mark{display:grid;place-items:center;width:44px;height:44px;border-radius:13px;background:var(--green);color:white;font:700 23px Georgia,serif}.brand-name{font:700 24px Georgia,serif;color:var(--green)}.brand-note,.report-date{color:var(--muted);font-size:12px}.report-date{text-align:right}.eyebrow{margin:0 0 6px;color:var(--orange);font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}.hero{display:flex;align-items:center;justify-content:space-between;gap:24px;margin:24px 0 14px;padding:22px 24px;border-left:5px solid var(--green);border-radius:9px;background:var(--green-pale)}.hero h1{margin:0;font:600 23px Georgia,serif}.hero-total{text-align:right}.hero-total span{display:block;color:var(--muted);font-size:11px}.hero-total strong{display:block;color:var(--green);font:700 30px Georgia,serif}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.metric{min-height:78px;padding:13px 15px;border:1px solid var(--line);border-radius:8px}.metric span{display:block;color:var(--muted);font-size:10px}.metric strong{display:block;margin-top:5px;font-size:15px}.section-head{display:flex;align-items:end;justify-content:space-between;margin:28px 0 10px}.section-head h2{margin:0;font:600 19px Georgia,serif}.section-head span{color:var(--muted);font-size:11px}table{width:100%;border-collapse:collapse;font-size:12px}thead{background:#f4f2eb}th{color:#58645a;font-size:10px;letter-spacing:.04em;text-transform:uppercase}th,td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}tbody tr:nth-child(even){background:#fcfbf7}.amount{text-align:right;font-weight:700;white-space:nowrap}.empty{text-align:center;color:var(--muted);padding:24px}.footer{display:flex;justify-content:space-between;gap:16px;margin-top:22px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:10px}@media(max-width:650px){.page{padding:22px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.hero{align-items:flex-start;flex-direction:column}.hero-total{text-align:left}.section-head{align-items:flex-start;flex-direction:column}table{font-size:10px}th,td{padding:8px 6px}}@page{size:A4;margin:14mm}@media print{body{background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}.page{max-width:none;padding:0}.metric,.hero,tbody tr{break-inside:avoid}}
  </style></head><body><main class="page"><header class="masthead"><div class="brand"><span class="brand-mark">L</span><div><div class="brand-name">lahap!</div><div class="brand-note">Rasa rumahan, setiap hari</div></div></div><div class="report-date"><p class="eyebrow">Laporan operasional</p>${new Intl.DateTimeFormat('id-ID', { dateStyle: 'full' }).format(new Date())}</div></header><section class="hero"><div><p class="eyebrow">Daily closing</p><h1>Ringkasan penjualan hari ini</h1></div><div class="hero-total"><span>Omzet penjualan</span><strong>${currency.format(orderRevenue)}</strong></div></section><section class="metrics"><div class="metric"><span>Kas masuk (POS + lainnya)</span><strong>${currency.format(income)}</strong></div><div class="metric"><span>Kas keluar</span><strong>${currency.format(expenses)}</strong></div><div class="metric"><span>Jumlah transaksi</span><strong>${orders.length}</strong></div><div class="metric"><span>Rata-rata transaksi</span><strong>${currency.format(orders.length ? orderRevenue / orders.length : 0)}</strong></div></section><section><div class="section-head"><h2>Rincian penjualan</h2><span>${orders.length} transaksi</span></div><table><thead><tr><th>Waktu</th><th>Menu</th><th>Kasir</th><th class="amount">Total</th></tr></thead><tbody>${rows || '<tr><td class="empty" colspan="4">Belum ada penjualan hari ini.</td></tr>'}</tbody></table></section><footer class="footer"><span>lahap! · Laporan internal</span><span>Dicetak ${new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date())}</span></footer></main><script>window.onload=()=>window.print();</script></body></html>`);
  report.document.close();
}
function renderActivities() {
  const activities = getFilteredActivities();
  $('#activity-body').innerHTML = activities.length ? activities.map(item => { const canMutate = !item.voided_at && !item.name.startsWith('Pembalik:'); return `<tr><td><strong>${item.name}</strong>${item.note ? `<br><small>${item.note}</small>` : ''}${item.voided_at ? `<br><small>Void oleh ${item.voided_by || 'Kasir'}: ${item.void_reason || ''}</small>` : ''}${item.approval_status === 'pending' ? '<br><small class="pending-label">Menunggu approval</small>' : ''}</td><td>${item.account}</td><td>${formatDate(item.date)}</td><td class="align-right ${item.type === 'Income' ? 'positive' : 'negative'}">${item.type === 'Income' ? '+' : '-'} ${currency.format(item.amount)}</td><td>${item.receipt_path ? `<button class="outline-button receipt-button" data-id="${item.id}" type="button">Nota</button> ` : ''}<button class="outline-button print-button" data-item='${JSON.stringify(item).replaceAll("'", '&#39;')}' title="Cetak ulang">Cetak</button> ${item.source === 'cash' && canMutate ? `<button class="outline-button edit-transaction-button" data-id="${item.id}" type="button">Edit</button> ` : ''}${canMutate ? `<button class="danger-button delete-button" data-id="${item.id}" data-source="${item.source}" title="Void/refund">Void</button>` : 'Dibatalkan'}</td></tr>`; }).join('') : '<tr><td colspan="5" class="empty-state">Tidak ada transaksi yang cocok.</td></tr>';
}
function renderAuditLog() {
  const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  const logs = (state.auditLogs || []).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 100);
  $('#audit-body').innerHTML = logs.length ? logs.map(item => `<tr><td><strong>${escapeHtml(item.action)}</strong></td><td>${escapeHtml(item.entity_type)} #${escapeHtml(item.entity_id)}</td><td>${escapeHtml(item.actor)}</td><td>${formatDate(item.created_at)}</td><td>${escapeHtml(item.reason)}${item.details ? `<br><small>${escapeHtml(JSON.stringify(item.details))}</small>` : ''}</td></tr>`).join('') : '<tr><td colspan="5" class="empty-state">Belum ada perubahan tercatat.</td></tr>';
}
function inDashboardPeriod(value) {
  const date = new Date(value);
  const startValue = $('#dashboard-from').value;
  const endValue = $('#dashboard-to').value;
  const start = startValue ? new Date(`${startValue}T00:00:00`) : new Date(0);
  const end = endValue ? new Date(`${endValue}T23:59:59.999`) : new Date(8640000000000000);
  return date >= start && date <= end;
}
function approvedCashTransactions() {
  const recorded = state.cashBank.filter(item => item.approval_status !== 'pending' && item.approval_status !== 'rejected' && item.transaction_role !== 'non_cash');
  const derived = (state.orders || []).filter(order => !['void', 'refunded'].includes(order.status) && order.order_number && !recorded.some(item => String(item.note || '').includes(order.order_number))).flatMap(order => (order.payments || []).map((payment, index) => ({
    id: `order-${order.id}-${index}`,
    transaction_type: 'Income',
    account: payment.method === 'Cash' ? 'Kas' : 'Bank',
    category: 'Penjualan POS',
    amount: Number(payment.amount || 0),
    note: `${order.order_number} - ${payment.method}`,
    transaction_date: order.created_at || order.sale_date,
    transaction_role: 'operating',
    approval_status: 'approved',
    derived_from_order: true
  })));
  return [...recorded, ...derived];
}
function localDateInput(date) { const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return local.toISOString().slice(0, 10); }
function setDashboardRange(preset) {
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let start = new Date(end);
  if (preset === 'week') start.setDate(start.getDate() - 6);
  else if (preset === 'month') start = new Date(today.getFullYear(), today.getMonth(), 1);
  else if (preset === 'all') {
    const dates = [...approvedCashTransactions().map(item => item.transaction_date), ...state.sales.map(item => item.sale_date)].map(value => new Date(value)).filter(date => !Number.isNaN(date.getTime()));
    if (dates.length) start = new Date(Math.min(...dates.map(date => date.getTime())));
    else start = new Date(end);
    start.setHours(0, 0, 0, 0);
  }
  if (preset !== 'custom') { $('#dashboard-from').value = localDateInput(start); $('#dashboard-to').value = localDateInput(end); }
}
function renderDashboardTrend() {
  const start = new Date(`${$('#dashboard-from').value}T00:00:00`);
  const end = new Date(`${$('#dashboard-to').value}T23:59:59.999`);
  const startTime = start.getTime();
  const endTime = Math.max(end.getTime(), startTime + 1);
  const interval = (endTime - startTime + 1) / 7;
  const days = Array.from({ length: 7 }, (_, index) => ({ start: new Date(startTime + interval * index), total: 0 }));
  const sales = approvedCashTransactions().filter(item => item.transaction_type === 'Income' && /penjualan/i.test(item.category) && !item.voided_at);
  sales.filter(item => inDashboardPeriod(item.transaction_date)).forEach(item => { const index = Math.min(6, Math.floor((new Date(item.transaction_date).getTime() - startTime) / interval)); if (index >= 0) days[index].total += Number(item.amount); });
  const maximum = Math.max(...days.map(day => day.total), 1);
  $('#trend-total').textContent = currency.format(days.reduce((sum, day) => sum + day.total, 0));
  $('#dashboard-trend').innerHTML = days.map((day, index) => `<div class="trend-column"><span class="trend-value">${day.total ? currency.format(day.total) : ''}</span><span class="trend-bar${index === 6 ? ' today' : ''}" style="--bar-height:${Math.max(day.total ? 8 : 3, day.total / maximum * 92)}%" title="${currency.format(day.total)}"></span><small>${new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short' }).format(day.start)}</small></div>`).join('');
}
function renderDashboardTransactions() {
  const transactions = approvedCashTransactions().filter(item => inDashboardPeriod(item.transaction_date)).slice().sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date)).slice(0, 5);
  $('#dashboard-transactions').innerHTML = transactions.length ? transactions.map(item => `<div class="dashboard-transaction"><span class="transaction-dot ${item.transaction_type === 'Income' ? 'in' : 'out'}"></span><div class="transaction-copy"><strong>${item.category}</strong><small>${item.account} · ${formatDate(item.transaction_date)}</small></div><strong class="${item.transaction_type === 'Income' ? 'positive' : 'negative'}">${item.transaction_type === 'Income' ? '+' : '-'}${currency.format(item.amount)}</strong>${item.receipt_path ? `<button class="receipt-icon-button receipt-button" data-id="${item.id}" title="Buka bukti nota">▧</button>` : ''}</div>`).join('') : '<p class="empty-state">Belum ada transaksi tersimpan.</p>';
}
function renderDashboard() {
  const featuredMenuCount = featuredMenuItems().length;
  featuredMenuIndex = featuredMenuCount ? featuredMenuIndex % featuredMenuCount : 0;
  renderFeaturedMenu();
  const transactions = approvedCashTransactions().filter(item => inDashboardPeriod(item.transaction_date));
  const salesRows = transactions.filter(item => item.transaction_type === 'Income' && /penjualan/i.test(item.category) && !item.voided_at);
  const legacySales = state.sales.filter(item => inDashboardPeriod(item.sale_date) && !item.voided_at);
  const salesTotal = salesRows.length ? salesRows.reduce((sum, item) => sum + Number(item.amount), 0) : legacySales.reduce((sum, item) => sum + Number(item.total_amount), 0);
  const income = transactions.filter(item => item.transaction_type === 'Income').reduce((sum, item) => sum + Number(item.amount), 0);
  const expense = transactions.filter(item => item.transaction_type === 'Expense').reduce((sum, item) => sum + Number(item.amount), 0);
  $('#sales-total').textContent = currency.format(salesTotal);
  $('#sales-count').textContent = `${salesRows.length || legacySales.length} transaksi`;
  $('#income-total').textContent = currency.format(income); $('#expense-total').textContent = currency.format(expense); $('#balance-total').textContent = currency.format(income - expense);
  const cashBalance = accountBalance('Kas');
  const bankBalance = accountBalance('Bank');
  $('#cash-balance').textContent = currency.format(cashBalance); $('#bank-balance').textContent = currency.format(bankBalance); $('#menu-count').textContent = state.menu.length;
  renderDashboardTrend();
  renderDashboardTransactions();
  state.activities = getActivities();
  renderActivities();
  renderAuditLog();
  renderCashFlowReport();
  renderFinanceTools();
  renderInsights();
  renderSalesAnalytics();
}
async function loadFinanceControls() {
  if (isLocalMode()) { $('#cash-alert').textContent = 'Mode lokal'; return; }
  try {
    const [pending, recurring, setting] = await Promise.all([api('/api/cash-bank/pending'), api('/api/recurring-expenses'), api('/api/settings/minimum_cash_balance')]);
    const pendingItems = Array.isArray(pending) ? pending : [];
    $('#pending-expenses').innerHTML = pendingItems.length ? pendingItems.map(item => `<div class="pending-item"><div><strong>${item.category}</strong><small>${item.account} · ${currency.format(item.amount)}</small></div><div class="pending-actions"><button class="primary-small-button approve-expense" data-id="${item.id}">Setujui</button><button class="danger-button reject-expense" data-id="${item.id}">Tolak</button></div></div>`).join('') : '<p class="empty-state">Tidak ada pengeluaran pending.</p>';
    $('#recurring-list').innerHTML = recurring.length ? recurring.map(item => `<div class="recurring-item"><div><strong>${item.name}</strong><small>${item.frequency === 'monthly' ? 'Bulanan' : 'Mingguan'} · jatuh tempo ${item.next_due}</small></div><strong>${currency.format(item.amount)}</strong></div>`).join('') : '<p class="empty-state">Belum ada jadwal recurring.</p>';
    const minimum = Number(setting?.[0]?.value || 100000);
    const cash = state.cashBank.filter(item => item.account === 'Kas' && item.approval_status !== 'pending').reduce((sum, item) => sum + (item.transaction_type === 'Income' ? Number(item.amount) : -Number(item.amount)), 0);
    $('#cash-alert').textContent = cash < minimum ? `Saldo kas menipis: ${currency.format(cash)}` : `Saldo aman: ${currency.format(cash)}`;
    $('#cash-alert').classList.toggle('cash-alert-low', cash < minimum);
  } catch (error) { showToast(error.message, true); }
}
async function loadData() {
  if (window.location.protocol === 'file:') {
    await hydrateLocalState();
    renderMenu();
    renderKitchenDisplay();
    renderDashboard();
    await loadFinanceControls();
    showToast('Mode pratinjau lokal aktif. Jalankan backend untuk menyimpan data.');
    return true;
  }
  try {
    const cached = loadLocalData();
    if (cached.pendingSync.length) {
      for (const key of localDataKeys) state[key] = cached[key];
      localStorage.setItem('lahap-offline-mode', 'true');
      renderMenu(); renderKitchenDisplay(); renderDashboard(); updateConnectionStatus();
    }
    if (navigator.onLine) await flushOfflineQueue();
    if (state.pendingSync.length) throw new Error('Ada perubahan offline yang belum berhasil disinkronkan.');
    const [menu, dashboard, combos] = await Promise.all([api('/api/menu'), api('/api/dashboard'), api('/api/combos')]);
    state.menu = menu;
    state.combos = combos;
    state.sales = dashboard.sales;
    state.orders = dashboard.orders || [];
    state.cashBank = dashboard.cashBank;
    state.auditLogs = dashboard.auditLogs || [];
    state.reconciliations = dashboard.reconciliations || [];
    state.closings = dashboard.closings || [];
    state.debts = dashboard.debts || [];
    state.budgets = dashboard.budgets || [];
    if ($('#dashboard-period').value === 'all') setDashboardRange('all');
    localStorage.removeItem('lahap-offline-mode');
    saveLocalData();
    renderMenu();
    renderDashboard();
    await loadFinanceControls();
    updateConnectionStatus();
    return true;
  } catch (error) {
    if (!navigator.onLine || state.pendingSync.length || error instanceof TypeError || /fetch|network|koneksi|offline|sinkronisasi|SUPABASE_URL/i.test(error.message)) {
      await hydrateLocalState();
      localStorage.setItem('lahap-offline-mode', 'true');
      renderMenu(); renderKitchenDisplay(); renderDashboard(); updateConnectionStatus();
      showToast(`Offline aktif. ${state.pendingSync.length} perubahan menunggu sinkronisasi.`);
      return true;
    }
    showToast(error.message, true);
    $('#activity-body').innerHTML = `<tr><td colspan="5" class="empty-state">${error.message}</td></tr>`;
    return false;
  }
}

async function toggleFavorite(id) {
  const menu = state.menu.find(item => String(item.id) === String(id));
  if (!menu) return;
  menu.is_favorite = !menu.is_favorite;
  try { if (isLocalMode()) saveLocalData(); else await api(`/api/menu/${id}/favorite`, { method: 'PATCH', body: { is_favorite: menu.is_favorite } }); renderQuickMenu(); showToast(menu.is_favorite ? 'Menu dipin ke favorit.' : 'Menu dilepas dari favorit.'); } catch (error) { menu.is_favorite = !menu.is_favorite; showToast(error.message, true); }
}

let editingMenuId = null;
function beginMenuEdit(menuId) {
  const menu = state.menu.find(item => String(item.id) === String(menuId));
  if (!menu) return;
  editingMenuId = String(menu.id);
  selectedMenuImage = menu.image_url || null;
  $('#menu-name').value = menu.name;
  $('#menu-category').value = menu.category || 'Makanan';
  $('#menu-price').value = menu.price;
  $('#menu-image-file').value = '';
  showMenuImagePreview(selectedMenuImage);
  $('#menu-form-submit').textContent = 'Simpan perubahan';
  $('#menu-edit-cancel').classList.remove('hidden');
  showPage('cash');
  $('#menu-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('#menu-name').focus({ preventScroll: true });
}
function cancelMenuEdit() {
  editingMenuId = null;
  selectedMenuImage = null;
  $('#menu-form').reset();
  $('#menu-category').value = 'Makanan';
  $('#menu-form-submit').textContent = '＋ Tambah menu';
  $('#menu-edit-cancel').classList.add('hidden');
  showMenuImagePreview(null);
}
async function saveMenuEdit() {
  const submit = $('#menu-form-submit');
  const menu = { name: $('#menu-name').value.trim(), category: $('#menu-category').value, price: Number($('#menu-price').value), image_url: selectedMenuImage || null };
  const existing = state.menu.find(item => String(item.id) === editingMenuId);
  if (!existing) throw new Error('Menu yang diedit sudah tidak tersedia.');
  if (!menu.name || !Number.isFinite(menu.price) || menu.price <= 0) throw new Error('Isi nama dan harga menu dengan benar.');
  menu.is_favorite = Boolean(existing.is_favorite);
  submit.disabled = true;
  try {
    if (isLocalMode()) {
      Object.assign(existing, menu);
      queueOfflineOperation(`/api/menu/${editingMenuId}`, menu);
      saveLocalData();
      renderMenu();
      renderDashboard();
    } else await api(`/api/menu/${editingMenuId}`, { method: 'PATCH', body: menu });
    cancelMenuEdit();
    if (!isLocalMode()) await loadData();
    renderQuickMenu();
    showToast('Perubahan menu tersimpan.');
  } finally { submit.disabled = false; }
}
$('#menu-form').addEventListener('submit', async event => {
  if (!editingMenuId) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  try { await saveMenuEdit(); }
  catch (error) { showToast(error.message, true); }
}, true);
$('#menu-edit-cancel').addEventListener('click', cancelMenuEdit);
$('#quick-menu-grid').addEventListener('click', event => {
  const edit = event.target.closest('.menu-edit');
  if (!edit) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  beginMenuEdit(edit.dataset.menuId);
}, true);
$('#quick-menu-grid').addEventListener('keydown', event => {
  const edit = event.target.closest('.menu-edit');
  if (!edit || !['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  edit.click();
}, true);

function receiptStyles() { return `:root{--green:#75618d;--orange:#a77bc4;--ink:#292622;--muted:#716b78;--line:#e8e0ef;--paper:#fffefe}*{box-sizing:border-box}body{width:72mm;margin:0 auto;padding:7mm 2mm;color:var(--ink);font:12px/1.45 'DM Sans',Arial,sans-serif}.brand{display:flex;justify-content:center;align-items:center;gap:8px;color:var(--green)}.brand-mark{display:grid;place-items:center;width:28px;height:28px;border-radius:9px;background:var(--green);color:white;font:700 16px Georgia,serif}.brand-name{font:700 22px Georgia,serif}.tagline{text-align:center;margin:3px 0 12px;color:var(--muted);font-size:9px}.receipt-type{text-align:center;color:var(--orange);font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}.meta{margin:10px 0;color:var(--muted);font-size:10px}.rule{border:0;border-top:1px dashed #a9aaa0;margin:10px 0}.row{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin:6px 0}.row span:first-child{min-width:0}.row span:last-child{text-align:right;white-space:nowrap}.muted{color:var(--muted);font-size:10px}.total-box{margin-top:10px;padding:10px;border-radius:7px;background:#f2edf7}.total{display:flex;justify-content:space-between;gap:8px;color:var(--green);font-size:15px;font-weight:700}.thanks{margin-top:15px;text-align:center;color:var(--green);font:600 13px Georgia,serif}.footer{text-align:center;margin-top:3px;color:var(--muted);font-size:9px}@page{size:80mm auto;margin:3mm}@media print{body{width:auto;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}}`; }
function receiptDescription(item) {
  if (item.name !== 'Penjualan POS' && item.category !== 'Penjualan POS') return item.name;
  const orderNumber = String(item.note || '').match(/\bORD-[\w-]+\b/)?.[0];
  const order = (state.orders || []).find(entry => entry.order_number === orderNumber);
  const orderItems = order?.order_items || order?.items || [];
  const menuItems = orderItems.map(orderItem => ({ name: orderItem.menu_items?.name || orderItem.name, quantity: Number(orderItem.quantity || 1) })).filter(orderItem => orderItem.name);
  if (menuItems.length) return `Pembelian menu: ${menuItems.map(orderItem => `${orderItem.name} ×${orderItem.quantity}`).join(', ')}`;
  return orderNumber ? `Pembelian menu (${orderNumber})` : 'Pembelian menu';
}
function printReceipt(item) { const receipt = window.open('', '_blank', 'width=380,height=600'); if (!receipt) return showToast('Izinkan pop-up untuk mencetak struk.', true); const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); const description = receiptDescription(item); receipt.document.write(`<!doctype html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Struk Lahap</title><style>${receiptStyles()}</style></head><body><header class="brand"><span class="brand-mark">L</span><span class="brand-name">lahap!</span></header><p class="tagline">Rasa rumahan, setiap hari</p><div class="receipt-type">Bukti transaksi</div><div class="meta">Waktu <strong>${escapeHtml(formatDate(item.date))}</strong><br>${escapeHtml(item.account || 'Kasir')}</div><hr class="rule"><div class="row"><span>${escapeHtml(description)}${item.note && item.name !== 'Penjualan POS' ? `<br><span class="muted">${escapeHtml(item.note)}</span>` : ''}</span><strong>${currency.format(item.amount)}</strong></div><div class="total-box"><div class="total"><span>Total</span><span>${currency.format(item.amount)}</span></div></div><p class="thanks">Terima kasih sudah makan di lahap</p><div class="footer">Simpan struk ini sebagai bukti transaksi</div><script>window.onload=()=>window.print();</script></body></html>`);
  receipt.document.close();
}
function printOrderReceipt() { const receipt = window.open('', '_blank', 'width=380,height=700'); if (!receipt) return showToast('Izinkan pop-up untuk mencetak struk.', true); const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); const totals = cartTotals(); const payments = getPaymentMethods(); const received = Number($('#cash-received').value || 0); const cashTotal = payments.filter(payment => payment.method === 'Cash').reduce((sum, payment) => sum + payment.amount, 0); const items = state.cart.map(item => `<div class="row"><span>${escapeHtml(item.name)}<br><span class="muted">${item.quantity} × ${currency.format(item.price)}</span>${item.note ? `<br><span class="muted">${escapeHtml(item.note)}</span>` : ''}</span><span>${currency.format(item.price * item.quantity)}</span></div>`).join(''); const paymentRows = payments.map(payment => `<div class="row muted"><span>${escapeHtml(payment.method)}</span><span>${currency.format(payment.amount)}</span></div>`).join(''); receipt.document.write(`<!doctype html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Struk Pesanan Lahap</title><style>${receiptStyles()}</style></head><body><header class="brand"><span class="brand-mark">L</span><span class="brand-name">lahap!</span></header><p class="tagline">Rasa rumahan, setiap hari</p><div class="receipt-type">Struk pesanan</div><div class="meta">${escapeHtml(formatDate(new Date()))}<br>Kasir: ${escapeHtml($('#pos-cashier').value.trim() || 'Kasir')}<br>Mode: ${escapeHtml($('#order-type').selectedOptions[0].textContent)}${$('#order-type').value === 'dine-in' ? `<br>Meja: ${escapeHtml($('#table-number').value || '-')}` : ''}</div><hr class="rule">${items}<hr class="rule"><div class="row muted"><span>Subtotal</span><span>${currency.format(totals.subtotal)}</span></div>${totals.discount ? `<div class="row muted"><span>Diskon</span><span>− ${currency.format(totals.discount)}</span></div>` : ''}<div class="total-box"><div class="total"><span>Total</span><span>${currency.format(totals.total)}</span></div></div><div class="meta"><strong>Pembayaran</strong>${paymentRows}${cashTotal ? `<div class="row muted"><span>Uang diterima</span><span>${currency.format(received)}</span></div><div class="row muted"><span>Kembalian</span><span>${currency.format(Math.max(received - cashTotal, 0))}</span></div>` : ''}</div>${$('#order-note').value.trim() ? `<hr class="rule"><div class="muted">Catatan: ${escapeHtml($('#order-note').value.trim())}</div>` : ''}<p class="thanks">Terima kasih sudah makan di lahap</p><div class="footer">Sampai jumpa kembali!</div><script>window.onload=()=>window.print();</script></body></html>`); receipt.document.close(); }

function addComboToCart(comboId) { const combo = state.combos.find(item => String(item.id) === String(comboId)); if (!combo || !Array.isArray(combo.combo_items)) return showToast('Item paket belum tersedia.', true); combo.combo_items.forEach(comboItem => { const menu = state.menu.find(item => Number(item.id) === Number(comboItem.menu_item_id));
    if (!menu) return;
    const existing = state.cart.find(item => item.id === menu.id);
    if (existing) existing.quantity += Number(comboItem.quantity || 1);
    else state.cart.push({ id: menu.id, name: menu.name, price: Number(menu.price), quantity: Number(comboItem.quantity || 1), note: combo.name });
  });
  renderCart();
  showToast(`${combo.name} masuk ke keranjang.`); }

function recordLocalAudit(action, entityType, entityId, reason, actor, details = null) {
  state.auditLogs.unshift({ id: Date.now() + Math.random(), action, entity_type: entityType, entity_id: String(entityId), reason, actor, details, created_at: new Date().toISOString() });
}
function reverseLocalTransaction(original, reference, actor, reason) {
  original.voided_at = new Date().toISOString();
  original.voided_by = actor;
  original.void_reason = reason;
  const reversal = { id: Date.now() + Math.random(), transaction_type: original.transaction_type === 'Income' ? 'Expense' : 'Income', account: original.account, category: `Pembalik: ${original.category}`, amount: Number(original.amount), note: `Void ${reference} oleh ${actor}: ${reason}`, transaction_date: new Date().toISOString(), transaction_role: 'void_reversal', approval_status: 'approved' };
  state.cashBank.unshift(reversal);
  return reversal;
}
async function deleteActivity(id, source) {
  const approval = await requestOwnerApproval('Void / refund transaksi', 'Transaksi asli tetap tersimpan dan dibuatkan transaksi pembalik. PIN owner, nama pelaku, dan alasan wajib.');
  if (!approval) return;
  const { pin, reason, actor } = approval;
  try {
    if (isLocalMode()) {
      if (source === 'sale') {
        const sale = state.sales.find(item => String(item.id) === String(id));
        if (!sale || sale.voided_at) throw new Error('Penjualan tidak ditemukan atau sudah di-void.');
        sale.voided_at = new Date().toISOString(); sale.voided_by = actor; sale.void_reason = reason;
        const originals = state.cashBank.filter(item => String(item.sale_id) === String(id) && !item.voided_at);
        const reversals = originals.map(item => reverseLocalTransaction(item, `penjualan #${id}`, actor, reason));
        recordLocalAudit('VOID_REFUND', 'sales', id, reason, actor, { original: sale, reversals });
        queueOfflineOperation(`/api/sales/${id}/void`, approval);
      } else {
        const original = state.cashBank.find(item => String(item.id) === String(id));
        if (!original || original.voided_at) throw new Error('Transaksi tidak ditemukan atau sudah di-void.');
        const before = { ...original };
        const reversal = reverseLocalTransaction(original, `transaksi #${id}`, actor, reason);
        recordLocalAudit('VOID_REFUND', 'cash_bank_transactions', id, reason, actor, { original: before, reversal });
        queueOfflineOperation(`/api/cash-bank/${id}/void`, approval);
      }
      saveLocalData();
    } else await api(`/api/${source === 'sale' ? 'sales' : 'cash-bank'}/${id}/void`, { method: 'POST', body: approval });
    showToast('Transaksi dibalik; jejak aslinya tetap tersimpan.');
    if (isLocalMode()) renderDashboard(); else await loadData();
  } catch (error) { showToast(error.message, true); }
}

let editingTransactionId = null;
function openEditTransaction(id) {
  const item = state.cashBank.find(row => String(row.id) === String(id));
  if (!item || item.voided_at) return showToast('Transaksi tidak dapat diedit.', true);
  editingTransactionId = id;
  $('#edit-type').value = item.transaction_type;
  $('#edit-account').value = item.account;
  $('#edit-category').value = item.category;
  $('#edit-amount').value = item.amount;
  $('#edit-date').value = localDateTimeValue(new Date(item.transaction_date));
  $('#edit-note').value = item.note || '';
  $('#edit-transaction-modal').classList.add('open');
  $('#edit-transaction-modal').setAttribute('aria-hidden', 'false');
}
function closeEditTransaction() {
  $('#edit-transaction-modal').classList.remove('open');
  $('#edit-transaction-modal').setAttribute('aria-hidden', 'true');
  editingTransactionId = null;
}
async function saveEditedTransaction(event) {
  event.preventDefault();
  const item = state.cashBank.find(row => String(row.id) === String(editingTransactionId));
  if (!item) return closeEditTransaction();
  const before = { transaction_type: item.transaction_type, account: item.account, category: item.category, amount: Number(item.amount), note: item.note || null, transaction_date: item.transaction_date };
  const update = { transaction_type: $('#edit-type').value, account: $('#edit-account').value, category: $('#edit-category').value.trim(), amount: Number($('#edit-amount').value), note: $('#edit-note').value.trim(), transaction_date: new Date($('#edit-date').value).toISOString() };
  if (!update.category || !Number.isFinite(update.amount) || update.amount <= 0 || Number.isNaN(new Date(update.transaction_date).getTime())) return showToast('Periksa kategori, nominal, dan tanggal transaksi.', true);
  const id = editingTransactionId;
  closeEditTransaction();
  const approval = await requestOwnerApproval('Setujui edit transaksi', 'Perubahan transaksi akan direkam bersama nilai sebelum dan sesudah.');
  if (!approval) return;
  try {
    if (isLocalMode()) {
      Object.assign(item, update);
      recordLocalAudit('EDIT_TRANSACTION', 'cash_bank_transactions', id, approval.reason, approval.actor, { before, after: update });
      queueOfflineOperation(`/api/cash-bank/${id}/edit`, { ...update, ...approval });
      saveLocalData();
    } else await api(`/api/cash-bank/${id}/edit`, { method: 'POST', body: { ...update, ...approval } });
    showToast('Transaksi diperbarui dan perubahan dicatat.');
    if (isLocalMode()) renderDashboard(); else await loadData();
  } catch (error) { showToast(error.message, true); }
}

async function ownerDelete(url, pin, reason) {
  try { return await api(`${url}/delete`, { method: 'POST', body: { pin, reason } }); }
  catch (error) { return api(url, { method: 'DELETE', body: { pin, reason } }); }
}

async function deleteMenu(id) {
  const menu = state.menu.find(item => String(item.id) === String(id));
  if (!menu) return;
  const approval = await requestOwnerApproval(`Hapus menu ${menu.name}`, 'Menu akan dinonaktifkan dari daftar penjualan.');
  if (!approval) return;
  const { pin, reason } = approval;
  try {
    if (isLocalMode()) {
      state.menu = state.menu.filter(item => String(item.id) !== String(id));
      state.cart = state.cart.filter(item => String(item.id) !== String(id));
      saveLocalData();
    } else {
      await ownerDelete(`/api/menu/${id}`, pin, reason);
      state.menu = state.menu.filter(item => String(item.id) !== String(id));
      state.cart = state.cart.filter(item => String(item.id) !== String(id));
    }
    renderQuickMenu();
    renderCart();
    renderDashboard();
    showToast('Menu berhasil dihapus.');
  } catch (error) { showToast(error.message, true); }
}

let approvalResolver = null;
function requestOwnerApproval(title, message) {
  return new Promise(resolve => {
    approvalResolver = resolve;
    $('#approval-title').textContent = title;
    $('#approval-message').textContent = message;
    $('#approval-actor').value = localStorage.getItem('lahap-actor') || '';
    $('#approval-pin').value = '';
    $('#approval-reason').value = '';
    $('#approval-modal').classList.add('open');
    $('#approval-modal').setAttribute('aria-hidden', 'false');
    $('#approval-pin').focus();
  });
}
function closeApproval(result) {
  $('#approval-modal').classList.remove('open');
  $('#approval-modal').setAttribute('aria-hidden', 'true');
  if (approvalResolver) approvalResolver(result);
  approvalResolver = null;
}

$('#menu-image-file').addEventListener('change', async (event) => { const file = event.target.files[0]; if (!file) return; if (file.size > 2 * 1024 * 1024) { event.target.value = ''; return showToast('Ukuran foto maksimal 2 MB.', true); } try { selectedMenuImage = await compressImage(file); showMenuImagePreview(selectedMenuImage); } catch { showToast('Foto tidak dapat dibaca.', true); } });
$('#menu-form').addEventListener('submit', async (event) => { event.preventDefault(); const button = event.submitter; button.disabled = true; try { const menu = { name: $('#menu-name').value.trim(), category: $('#menu-category').value, price: Number($('#menu-price').value), image_url: selectedMenuImage || null }; if (!menu.name || !menu.price || menu.price <= 0) throw new Error('Isi nama dan harga menu dengan benar.'); if (isLocalMode()) { menu.id = Date.now(); state.menu.push(menu); saveLocalData(); renderMenu(); renderQuickMenu(); } else { await api('/api/menu', { method: 'POST', body: menu }); await loadData(); renderQuickMenu(); } event.target.reset(); selectedMenuImage = null; showMenuImagePreview(null); $('#menu-category').value = 'Makanan'; showToast('Menu baru berhasil ditambahkan.'); } catch (error) { showToast(error.message, true); } finally { button.disabled = false; } });
$('#activity-body').addEventListener('click', (event) => { const button = event.target.closest('.delete-button'); const printButton = event.target.closest('.print-button'); const receiptButton = event.target.closest('.receipt-button'); if (button) deleteActivity(button.dataset.id, button.dataset.source); if (printButton) printReceipt(JSON.parse(printButton.dataset.item)); if (receiptButton) { const item = state.cashBank.find(row => String(row.id) === receiptButton.dataset.id); openReceipt(receiptButton.dataset.id, item?.receipt_path); } });
$('#activity-body').addEventListener('click', event => { const button = event.target.closest('.edit-transaction-button'); if (button) openEditTransaction(button.dataset.id); });
$('#edit-transaction-form').addEventListener('submit', saveEditedTransaction);
$('#edit-cancel').addEventListener('click', closeEditTransaction);
$('#edit-transaction-modal').addEventListener('click', event => { if (event.target.id === 'edit-transaction-modal') closeEditTransaction(); });
$('#dashboard-transactions').addEventListener('click', event => { const button = event.target.closest('.receipt-button'); if (button) { const item = state.cashBank.find(row => String(row.id) === button.dataset.id); openReceipt(button.dataset.id, item?.receipt_path); } });
$('#pending-expenses').addEventListener('click', async event => { const approve = event.target.closest('.approve-expense'); const reject = event.target.closest('.reject-expense'); const button = approve || reject; if (!button) return; const approval = await requestOwnerApproval(approve ? 'Setujui pengeluaran' : 'Tolak pengeluaran', 'Masukkan PIN owner dan alasan untuk mencatat keputusan.'); if (!approval) return; try { await api(`/api/cash-bank/${button.dataset.id}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: approval }); showToast(approve ? 'Pengeluaran disetujui.' : 'Pengeluaran ditolak.'); await loadData(); } catch (error) { showToast(error.message, true); } });
$('#recurring-form').addEventListener('submit', async event => { event.preventDefault(); try { await api('/api/recurring-expenses', { method: 'POST', body: { name: $('#recurring-name').value, category: $('#recurring-category').value, account: $('#recurring-account').value, amount: Number($('#recurring-amount').value), frequency: $('#recurring-frequency').value, next_due: $('#recurring-due').value } }); event.target.reset(); $('#recurring-category').value = 'Bahan baku'; showToast('Pengeluaran berulang dijadwalkan.'); await loadFinanceControls(); } catch (error) { showToast(error.message, true); } });

$('#transfer-form').addEventListener('submit', async event => {
  event.preventDefault();
  const payload = { from_account: $('#transfer-from').value, to_account: $('#transfer-to').value, amount: Number($('#transfer-amount').value), actor: $('#transfer-actor').value.trim(), transaction_date: new Date($('#transfer-date').value).toISOString() };
  if (!payload.actor || !Number.isFinite(payload.amount) || payload.amount <= 0 || payload.from_account === payload.to_account) return showToast('Pilih dua akun berbeda, nama pelaku, dan nominal valid.', true);
  if (payload.amount > accountBalance(payload.from_account)) return showToast(`Saldo ${payload.from_account} tidak cukup.`, true);
  try {
    if (isLocalMode()) {
      const ref = `TRF-${Date.now()}`;
      const localIds = [Date.now() + Math.random(), Date.now() + Math.random()];
      state.cashBank.unshift({ id: localIds[0], transaction_type: 'Expense', account: payload.from_account, category: 'Transfer antar akun', amount: payload.amount, note: `${ref} ke ${payload.to_account} oleh ${payload.actor}`, transaction_date: payload.transaction_date, transaction_role: 'transfer', approval_status: 'approved' }, { id: localIds[1], transaction_type: 'Income', account: payload.to_account, category: 'Transfer antar akun', amount: payload.amount, note: `${ref} dari ${payload.from_account} oleh ${payload.actor}`, transaction_date: payload.transaction_date, transaction_role: 'transfer', approval_status: 'approved' });
      payload.offline_ids = localIds;
      recordLocalAudit('ACCOUNT_TRANSFER', 'cash_bank_transactions', ref, 'Transfer antar akun', payload.actor, { from: payload.from_account, to: payload.to_account, amount: payload.amount }); queueOfflineOperation('/api/transfers', payload); saveLocalData();
    } else await api('/api/transfers', { method: 'POST', body: payload });
    event.target.reset(); $('#transfer-date').value = localDateTimeValue(); showToast('Transfer antar akun tercatat.'); if (isLocalMode()) renderDashboard(); else await loadData();
  } catch (error) { showToast(error.message, true); }
});

$('#reconcile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const payload = { statement_date: $('#reconcile-date').value, statement_balance: Number($('#statement-balance').value), note: $('#reconcile-note').value.trim(), actor: $('#reconcile-actor').value.trim(), matched_ids: [...$('#reconcile-transactions').selectedOptions].map(option => Number(option.value)) };
  if (!payload.statement_date || !payload.actor || !Number.isFinite(payload.statement_balance) || payload.statement_balance < 0) return showToast('Lengkapi tanggal, saldo rekening, dan nama pemeriksa.', true);
  try {
    if (isLocalMode()) {
      const appBalance = accountBalance('Bank'); const reconciliation = { id: Date.now(), statement_date: payload.statement_date, app_balance: appBalance, statement_balance: payload.statement_balance, difference: payload.statement_balance - appBalance, note: payload.note, actor: payload.actor, created_at: new Date().toISOString() }; state.reconciliations.unshift(reconciliation); state.cashBank.filter(item => payload.matched_ids.includes(Number(item.id))).forEach(item => { item.reconciliation_status = 'matched'; }); recordLocalAudit('BANK_RECONCILIATION', 'bank_reconciliations', reconciliation.id, `Selisih ${currency.format(reconciliation.difference)}`, payload.actor, { appBalance, statementBalance: payload.statement_balance, matchedIds: payload.matched_ids }); queueOfflineOperation('/api/bank-reconciliations', payload); saveLocalData();
    } else await api('/api/bank-reconciliations', { method: 'POST', body: payload });
    event.target.reset(); $('#reconcile-date').value = localDateInput(new Date()); showToast('Rekonsiliasi bank tersimpan.'); if (isLocalMode()) renderDashboard(); else await loadData();
  } catch (error) { showToast(error.message, true); }
});

$('#cash-closing-form').addEventListener('submit', async event => {
  event.preventDefault();
  const payload = { actor: $('#closing-cashier').value.trim(), actual_cash: Number($('#closing-actual').value), note: $('#closing-note').value.trim() };
  if (!payload.actor || !Number.isFinite(payload.actual_cash) || payload.actual_cash < 0) return showToast('Nama kasir dan jumlah kas aktual wajib valid.', true);
  try {
    const expected = accountBalance('Kas');
    let closing;
    if (isLocalMode()) { closing = { id: Date.now(), cashier_name: payload.actor, actual_cash: payload.actual_cash, expected_cash: expected, difference: payload.actual_cash - expected, note: payload.note, closed_at: new Date().toISOString() }; state.closings.unshift(closing); recordLocalAudit('CASH_CLOSING', 'cash_closings', closing.id, `Selisih ${currency.format(closing.difference)}`, payload.actor, { expectedCash: expected, actualCash: payload.actual_cash }); queueOfflineOperation('/api/cash-closings', payload); saveLocalData(); }
    else closing = await api('/api/cash-closings', { method: 'POST', body: payload });
    $('#closing-result').innerHTML = `<strong>Expected ${currency.format(closing.expected_cash)} · Aktual ${currency.format(closing.actual_cash)} · Selisih ${currency.format(closing.difference)}</strong>`; $('#closing-result').classList.remove('hidden'); showToast('Penutupan kasir tersimpan.'); if (isLocalMode()) renderDashboard(); else await loadData();
  } catch (error) { showToast(error.message, true); }
});

$('#debt-form').addEventListener('submit', async event => {
  event.preventDefault();
  const payload = { debt_type: $('#debt-type').value, party_name: $('#debt-party').value.trim(), description: $('#debt-description').value.trim(), amount: Number($('#debt-amount').value), due_date: $('#debt-due').value || null, account: $('#debt-account').value };
  try {
    if (isLocalMode()) { const debt = { ...payload, id: Date.now(), offline_id: `offline-${Date.now()}`, original_amount: payload.amount, remaining_amount: payload.amount, status: 'open', created_at: new Date().toISOString() }; payload.offline_id = debt.offline_id; state.debts.unshift(debt); state.cashBank.unshift({ id: Date.now() + Math.random(), transaction_type: payload.debt_type === 'receivable' ? 'Income' : 'Expense', account: payload.account, category: payload.debt_type === 'receivable' ? 'Penjualan bon' : 'Bahan baku', amount: payload.amount, note: `${payload.party_name} · ${payload.description} · belum dibayar`, transaction_role: 'non_cash', approval_status: 'approved', transaction_date: debt.created_at }); queueOfflineOperation('/api/debts', payload); saveLocalData(); }
    else await api('/api/debts', { method: 'POST', body: payload });
    event.target.reset(); showToast('Hutang/piutang tersimpan.'); if (isLocalMode()) renderDashboard(); else await loadData();
  } catch (error) { showToast(error.message, true); }
});
let settlingDebtId = null;
$('#debt-list').addEventListener('click', event => {
  const button = event.target.closest('.debt-settle'); if (!button) return;
  settlingDebtId = button.dataset.id;
  $('#debt-settle-amount').max = button.dataset.remaining;
  $('#debt-settle-amount').value = button.dataset.remaining;
  $('#debt-settle-actor').value = localStorage.getItem('lahap-actor') || '';
  $('#debt-settle-modal').classList.add('open');
  $('#debt-settle-modal').setAttribute('aria-hidden', 'false');
});
function closeDebtSettlement() { $('#debt-settle-modal').classList.remove('open'); $('#debt-settle-modal').setAttribute('aria-hidden', 'true'); settlingDebtId = null; }
$('#debt-settle-cancel').addEventListener('click', closeDebtSettlement);
$('#debt-settle-modal').addEventListener('click', event => { if (event.target.id === 'debt-settle-modal') closeDebtSettlement(); });
$('#debt-settle-form').addEventListener('submit', async event => {
  event.preventDefault(); const amount = Number($('#debt-settle-amount').value); const actor = $('#debt-settle-actor').value.trim(); const id = settlingDebtId;
  const debt = state.debts.find(item => String(item.id) === String(id));
  if (!debt || !actor || !Number.isFinite(amount) || amount <= 0 || amount > Number(debt.remaining_amount)) return showToast('Nominal dan kasir harus valid, maksimal sebesar sisa tagihan.', true);
  try {
    if (isLocalMode()) { if (debt.debt_type === 'payable' && amount > accountBalance(debt.account)) throw new Error(`Saldo ${debt.account} tidak cukup untuk membayar hutang.`); debt.remaining_amount = Number(debt.remaining_amount) - amount; debt.status = debt.remaining_amount === 0 ? 'paid' : 'partial'; const date = new Date().toISOString(); state.cashBank.unshift({ id: Date.now() + Math.random(), transaction_type: debt.debt_type === 'receivable' ? 'Income' : 'Expense', account: debt.account, category: debt.debt_type === 'receivable' ? 'Penerimaan piutang' : 'Pembayaran hutang', amount, note: `${debt.party_name} · ${debt.description} · oleh ${actor}`, transaction_role: 'settlement', approval_status: 'approved', transaction_date: date }); recordLocalAudit('SETTLE_DEBT', 'debts', debt.id, `Pembayaran ${amount}`, actor, { remaining: debt.remaining_amount }); queueOfflineOperation(`/api/debts/${debt.offline_id || debt.id}/settle`, { amount, actor }); saveLocalData(); }
    else await api(`/api/debts/${id}/settle`, { method: 'POST', body: { amount, actor } });
    localStorage.setItem('lahap-actor', actor); closeDebtSettlement(); showToast('Pembayaran tagihan tercatat.'); if (isLocalMode()) renderDashboard(); else await loadData();
  } catch (error) { showToast(error.message, true); }
});
$('#budget-form').addEventListener('submit', async event => {
  event.preventDefault(); const payload = { category: $('#budget-category').value, period_month: $('#budget-month').value, amount: Number($('#budget-amount').value) };
  try { if (isLocalMode()) { const current = state.budgets.find(item => item.category === payload.category && String(item.period_month).slice(0, 7) === payload.period_month); if (current) current.amount = payload.amount; else state.budgets.unshift({ id: Date.now(), ...payload, period_month: `${payload.period_month}-01` }); queueOfflineOperation('/api/budgets', payload); saveLocalData(); } else await api('/api/budgets', { method: 'POST', body: payload }); showToast('Anggaran tersimpan.'); renderDashboard(); } catch (error) { showToast(error.message, true); }
});

$('#receipt-file').addEventListener('change', async event => { const file = event.target.files[0]; if (!file) { selectedCashReceipt = null; renderReceiptPreview(null); return; } if (file.size > 2 * 1024 * 1024) { event.target.value = ''; selectedCashReceipt = null; renderReceiptPreview(null); return showToast('Ukuran bukti maksimal 2 MB.', true); } try { selectedCashReceipt = await compressImage(file); renderReceiptPreview(selectedCashReceipt); } catch { showToast('Foto nota tidak dapat dibaca.', true); } });
$('#cash-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.submitter; const amount = Number($('#amount').value); if (!Number.isFinite(amount) || amount <= 0) return showToast('Masukkan nominal lebih besar dari Rp 0.', true); if (!$('#transaction-date').value) return showToast('Pilih tanggal transaksi.', true); button.disabled = true; try { const transaction = { transaction_type: $('#transaction-type').value, account: $('#account').value, category: $('#category').value, amount, note: $('#note').value.trim(), transaction_date: new Date($('#transaction-date').value).toISOString(), transaction_role: 'operating', receipt_data: selectedCashReceipt }; if (isLocalMode()) { transaction.id = Date.now(); transaction.approval_status = 'approved'; transaction.receipt_path = selectedCashReceipt; state.cashBank.unshift(transaction); queueOfflineOperation('/api/cash-bank', transaction); saveLocalData(); } else await api('/api/cash-bank', { method: 'POST', body: transaction }); event.target.reset(); $('#category').value = 'Bahan baku'; $('#transaction-date').value = localDateTimeValue(); selectedCashReceipt = null; renderReceiptPreview(null); showToast('Arus dana tersimpan.'); if (isLocalMode()) renderDashboard(); else await loadData(); } catch (error) { showToast(error.message, true); } finally { button.disabled = false; } });
const favoriteFilterTab = document.createElement('button');
favoriteFilterTab.className = 'category-tab';
favoriteFilterTab.dataset.category = 'favorites';
favoriteFilterTab.textContent = '★ Favorit';
$('.category-tabs').append(favoriteFilterTab);
document.querySelectorAll('.category-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.category === state.posCategory));
$('#quick-menu-grid').addEventListener('click', (event) => { const deleteButton = event.target.closest('.menu-delete'); if (deleteButton) { event.preventDefault(); event.stopPropagation(); deleteMenu(deleteButton.dataset.menuId); return; } const favoriteButton = event.target.closest('.menu-favorite'); if (favoriteButton) { event.preventDefault(); event.stopPropagation(); toggleFavorite(favoriteButton.dataset.menuId); return; } const comboTile = event.target.closest('[data-combo-id]'); if (comboTile) { event.preventDefault(); addComboToCart(comboTile.dataset.comboId); return; } const tile = event.target.closest('.menu-tile'); if (!tile) return; const menu = state.menu.find(item => String(item.id) === tile.dataset.menuId); if (!menu) return; const existing = state.cart.find(item => item.id === menu.id); if (existing) existing.quantity += 1; else state.cart.push({ id: menu.id, name: menu.name, price: Number(menu.price), quantity: 1, note: '' }); renderCart(); });
$('#cart-items').addEventListener('click', (event) => { const button = event.target.closest('.remove-cart'); if (button) { state.cart = state.cart.filter(item => String(item.id) !== button.dataset.id); renderCart(); } });
$('#cart-items').addEventListener('input', (event) => { if (!event.target.classList.contains('cart-note')) return; const item = state.cart.find(entry => String(entry.id) === event.target.dataset.id); if (item) item.note = event.target.value; });
$('#approval-cancel').addEventListener('click', () => closeApproval(null)); $('#approval-submit').addEventListener('click', () => { const pin = $('#approval-pin').value.trim(); const reason = $('#approval-reason').value.trim(); const actor = $('#approval-actor').value.trim(); if (!pin || !reason || !actor) return showToast('Nama pelaku, PIN, dan alasan wajib diisi.', true); localStorage.setItem('lahap-actor', actor); closeApproval({ pin, reason, actor }); }); $('#approval-modal').addEventListener('click', event => { if (event.target.id === 'approval-modal') closeApproval(null); }); document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('#approval-modal').classList.contains('open')) closeApproval(null); if (event.key === 'Escape' && $('#edit-transaction-modal').classList.contains('open')) closeEditTransaction(); if (event.key === 'Escape' && $('#debt-settle-modal').classList.contains('open')) closeDebtSettlement(); });
$('#clear-cart').addEventListener('click', () => { state.cart = []; renderCart(); }); $('#save-order').addEventListener('click', saveQuickOrder); $('#print-order').addEventListener('click', () => { if (!state.cart.length) return showToast('Pilih menu terlebih dahulu.', true); printOrderReceipt(); }); $('#share-order').addEventListener('click', () => { if (!state.cart.length) return showToast('Belum ada pesanan untuk dikirim.', true); const body = encodeURIComponent(`Halo, ini struk lahap\n${state.cart.map(item => `- ${item.name} x${item.quantity} ${currency.format(item.price * item.quantity)}`).join('\n')}\nTotal: ${currency.format(cartTotals().total)}`); window.open(`https://wa.me/?text=${body}`, '_blank', 'noopener'); }); $('#pos-search').addEventListener('input', renderQuickMenu);
['discount-type', 'discount-value', 'pos-payment', 'payment-split', 'split-cash', 'split-qris', 'split-transfer', 'order-source', 'platform-fee'].forEach(id => $(`#${id}`).addEventListener('input', renderCart));
$('#order-type').addEventListener('change', () => { $('#table-field').classList.toggle('hidden', $('#order-type').value !== 'dine-in'); }); $('#payment-split').addEventListener('change', () => { $('#split-payments').classList.toggle('hidden', $('#payment-split').value !== 'split'); }); document.querySelectorAll('.category-tab').forEach(button => button.addEventListener('click', () => { document.querySelectorAll('.category-tab').forEach(tab => tab.classList.remove('active')); button.classList.add('active'); state.posCategory = button.dataset.category; renderQuickMenu(); }));
const pageCopy = { summary: ['lahap · Dashboard', 'Rasa hangat, kas tetap rapi.'], orders: ['lahap · Kasir', 'Buat pesanan baru.'], cash: ['lahap · Administrasi', 'Kas tertata, arus uang terlihat.'], audit: ['lahap · Catatan perubahan', 'Riwayat perubahan tercatat.'] };
$('#dashboard-from').value = localDateInput(new Date());
$('#dashboard-to').value = localDateInput(new Date());
$('#dashboard-period').value = 'all';
setDashboardRange('all');
$('#dashboard-period').addEventListener('change', () => { setDashboardRange($('#dashboard-period').value); renderDashboard(); });
['dashboard-from', 'dashboard-to'].forEach(id => $(`#${id}`).addEventListener('change', () => { if ($('#dashboard-from').value && $('#dashboard-to').value && $('#dashboard-from').value > $('#dashboard-to').value) { if (id === 'dashboard-from') $('#dashboard-to').value = $('#dashboard-from').value; else $('#dashboard-from').value = $('#dashboard-to').value; } $('#dashboard-period').value = 'custom'; renderDashboard(); }));
function showPage(page) { const selected = pageCopy[page] ? page : 'summary'; document.body.classList.toggle('view-cash', selected === 'cash'); document.querySelectorAll('.page-view').forEach(section => section.classList.toggle('hidden', section.dataset.view !== selected)); document.querySelectorAll('.nav-link[data-page]').forEach(link => link.classList.toggle('active', link.dataset.page === selected)); $('#page-eyebrow').textContent = pageCopy[selected][0]; $('#page-title').textContent = pageCopy[selected][1]; history.replaceState(null, '', `#${selected}`); window.scrollTo({ top: 0, behavior: 'smooth' }); }
document.querySelectorAll('.nav-link[data-page]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); showPage(link.dataset.page); }));
const initialPage = location.hash === '#orders' || location.hash === '#pos-cepat' ? 'orders' : location.hash === '#cash' || location.hash === '#arus-kas' ? 'cash' : location.hash === '#audit' ? 'audit' : 'summary';
showPage(initialPage);
$('#featured-previous').addEventListener('click', () => stepFeaturedMenu(-1));
$('#featured-next').addEventListener('click', () => stepFeaturedMenu(1));
$('#featured-order-button').addEventListener('click', () => showPage('orders'));
window.setInterval(() => { if (!document.hidden) stepFeaturedMenu(1); }, 5000);
$('#refresh-button').addEventListener('click', async () => { const button = $('#refresh-button'); button.disabled = true; button.textContent = '↻ Memuat...'; try { const loaded = await loadData(); if (loaded !== false) { renderQuickMenu(); renderCart(); showToast('Data berhasil disegarkan.'); } } finally { button.disabled = false; button.textContent = '↻ Segarkan'; } }); $('#export-button').addEventListener('click', exportCsv); $('#export-excel-button').addEventListener('click', exportExcel); $('#backup-export').addEventListener('click', downloadBackup); $('#backup-import-trigger').addEventListener('click', () => $('#backup-import').click()); $('#backup-import').addEventListener('change', event => { const file = event.target.files[0]; if (file) restoreBackup(file); event.target.value = ''; }); $('#daily-pdf').addEventListener('click', printDailyPdf); $('#comparison-period').addEventListener('change', renderSalesAnalytics); $('#break-even-target').addEventListener('input', renderSalesAnalytics); $('#pos-cashier').value = localStorage.getItem('lahap-cashier') || 'Kasir'; $('#pos-cashier').addEventListener('change', () => localStorage.setItem('lahap-cashier', $('#pos-cashier').value.trim())); $('#tax-toggle').checked = localStorage.getItem('maji-rasa-tax-enabled') === 'true'; $('#tax-toggle').addEventListener('change', event => { localStorage.setItem('maji-rasa-tax-enabled', event.target.checked); renderInsights(); }); $('#whatsapp-closing').addEventListener('click', () => { const text = `Daily closing lahap\n${$('#closing-summary').textContent}\nPemasukan bulan ini: ${$('#monthly-revenue').textContent}\nProyeksi akhir bulan: ${$('#cash-projection').textContent}`; window.open(`https://wa.me/6285772442798?text=${encodeURIComponent(text)}`, '_blank', 'noopener'); }); ['activity-search', 'activity-type', 'activity-date'].forEach(id => { $(`#${id}`).addEventListener(id === 'activity-search' ? 'input' : 'change', () => { renderActivities(); renderCashFlowReport(); }); }); $('#transaction-date').value = localDateTimeValue(); $('#transfer-date').value = localDateTimeValue(); $('#reconcile-date').value = localDateInput(new Date()); $('#budget-month').value = new Date().toISOString().slice(0, 7); $('#budget-month').addEventListener('change', renderFinanceTools); $('#today-label').textContent = new Intl.DateTimeFormat('id-ID', { dateStyle: 'full' }).format(new Date()); window.addEventListener('online', async () => { updateConnectionStatus(); await flushOfflineQueue(); if (window.location.protocol !== 'file:') await loadData(); }); window.addEventListener('offline', updateConnectionStatus); updateBackupStatus(); updateConnectionStatus(); loadData().then(() => { renderQuickMenu(); renderCart(); updateBackupStatus(); });