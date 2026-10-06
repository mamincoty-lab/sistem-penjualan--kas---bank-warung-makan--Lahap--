# Maji Rasa

Aplikasi sederhana untuk penjualan serta pencatatan kas dan bank warung makan.

## Struktur

```text
frontend/
  index.html
  styles.css
  app.js
backend/
  app.js
  schema.sql
```

## ERD tiga entitas

```text
menu_items (1) ──────< sales (1) ──────< cash_bank_transactions
                         menu_item_id       sale_id (opsional)
```

- `menu_items`: daftar menu dan harga.
- `sales`: transaksi penjualan dan metode pembayaran.
- `cash_bank_transactions`: pemasukan/pengeluaran di akun Kas atau Bank.

## Menjalankan

1. Buka Supabase SQL Editor, jalankan seluruh isi `backend/schema.sql`.
2. Pastikan Node.js versi 18 atau lebih baru tersedia karena backend memakai `fetch` bawaan Node.
3. Buka atau buat file `.env` di folder proyek. Isi URL proyek dan `service_role` key dari **Supabase Dashboard → Project Settings → API**, lalu tentukan PIN owner. File `.env` hanya dibaca backend; jangan unggah atau kirim file ini.

```powershell
code .env
node backend/app.js
```

Isi `.env` dengan format berikut:

```dotenv
SUPABASE_URL=https://project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=service-role-key-anda
OWNER_APPROVAL_PIN=pin-owner-anda
```

4. Buka `http://localhost:3000`.

Gunakan `service_role` key hanya di `.env` backend. Jangan pernah memasukkannya ke frontend atau membagikannya. Jika key pernah terekspos, segera rotasi dari Supabase Dashboard.

`OWNER_APPROVAL_PIN` diperlukan untuk menghapus/void transaksi atau menu. PIN diverifikasi di backend, bukan di browser.

