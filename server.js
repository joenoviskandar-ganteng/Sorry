import express from 'express';
import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const db = new Database('finance.db');
const client = new Anthropic();

app.use(express.json());
app.use(express.static(__dirname));

// Init database
db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )
`);

// GET all transactions
app.get('/api/transactions', (req, res) => {
  const rows = db.prepare('SELECT * FROM transactions ORDER BY date DESC, created_at DESC').all();
  res.json(rows);
});

// POST new transaction with AI auto-categorization
app.post('/api/transactions', async (req, res) => {
  const { type, amount, description, date } = req.body;
  if (!type || !amount || !description || !date) {
    return res.status(400).json({ error: 'Semua field wajib diisi' });
  }

  try {
    const category = await categorizeTransaction(type, description, amount);
    const stmt = db.prepare(
      'INSERT INTO transactions (type, amount, description, category, date) VALUES (?, ?, ?, ?, ?)'
    );
    const result = stmt.run(type, parseFloat(amount), description, category, date);
    const newTx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid);
    res.json(newTx);
  } catch (err) {
    console.error('Error adding transaction:', err.message);
    res.status(500).json({ error: 'Gagal menyimpan transaksi' });
  }
});

// DELETE transaction
app.delete('/api/transactions/:id', (req, res) => {
  db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// GET AI financial analysis
app.get('/api/analysis', async (req, res) => {
  const transactions = db.prepare('SELECT * FROM transactions ORDER BY date DESC').all();
  if (transactions.length === 0) {
    return res.json({ analysis: 'Belum ada transaksi. Mulai catat keuanganmu untuk mendapatkan analisis!' });
  }

  try {
    const analysis = await analyzeFinances(transactions);
    res.json({ analysis });
  } catch (err) {
    console.error('Error analyzing:', err.message);
    res.status(500).json({ error: 'Gagal menganalisis keuangan' });
  }
});

// GET summary stats
app.get('/api/summary', (req, res) => {
  const totalIncome = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE type='income'").get().total;
  const totalExpense = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE type='expense'").get().total;
  const byCategory = db.prepare(`
    SELECT category, type, SUM(amount) as total, COUNT(*) as count
    FROM transactions GROUP BY category, type ORDER BY total DESC
  `).all();
  res.json({ totalIncome, totalExpense, balance: totalIncome - totalExpense, byCategory });
});

async function categorizeTransaction(type, description, amount) {
  const categories = type === 'income'
    ? ['Gaji', 'Bonus', 'Freelance', 'Investasi', 'Bisnis', 'Hadiah', 'Lainnya']
    : ['Makanan & Minuman', 'Transportasi', 'Belanja', 'Hiburan', 'Kesehatan', 'Tagihan', 'Pendidikan', 'Tabungan', 'Lainnya'];

  const stream = await client.messages.stream({
    model: 'claude-opus-5-5',
    max_tokens: 64,
    messages: [{
      role: 'user',
      content: `Kategorikan transaksi ini ke dalam SATU kategori yang paling tepat.
Tipe: ${type === 'income' ? 'Pemasukan' : 'Pengeluaran'}
Deskripsi: "${description}"
Jumlah: Rp ${Number(amount).toLocaleString('id-ID')}
Pilihan kategori: ${categories.join(', ')}
Jawab HANYA dengan nama kategori, tanpa penjelasan.`
    }],
    system: 'Kamu adalah asisten kategorisasi keuangan. Jawab hanya dengan nama kategori yang paling tepat dari pilihan yang diberikan.'
  });

  const response = await stream.finalMessage();
  const category = response.content[0]?.text?.trim() || 'Lainnya';
  return categories.includes(category) ? category : 'Lainnya';
}

async function analyzeFinances(transactions) {
  const totalIncome = transactions.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const totalExpense = transactions.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const balance = totalIncome - totalExpense;
  const savingsRate = totalIncome > 0 ? ((balance / totalIncome) * 100).toFixed(1) : 0;

  const expenseByCategory = {};
  transactions.filter(t => t.type === 'expense').forEach(t => {
    expenseByCategory[t.category] = (expenseByCategory[t.category] || 0) + t.amount;
  });

  const summary = `Total Pemasukan: Rp ${totalIncome.toLocaleString('id-ID')}
Total Pengeluaran: Rp ${totalExpense.toLocaleString('id-ID')}
Saldo: Rp ${balance.toLocaleString('id-ID')}
Tingkat Tabungan: ${savingsRate}%
Pengeluaran per kategori: ${JSON.stringify(expenseByCategory, null, 2)}
Jumlah transaksi: ${transactions.length}`;

  const stream = await client.messages.stream({
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Analisis kondisi keuangan berdasarkan data berikut:\n\n${summary}\n\nBerikan analisis dalam format:\n1. ✅ Yang Baik: (hal positif dari keuangan ini)\n2. ⚠️ Yang Perlu Diperhatikan: (hal yang kurang baik)\n3. 💡 Rekomendasi: (saran konkret untuk perbaikan)\n\nGunakan bahasa Indonesia yang mudah dimengerti dan ramah. Langsung ke poin, tidak perlu pembuka panjang.`
    }],
    system: 'Kamu adalah konsultan keuangan pribadi yang berpengalaman. Berikan analisis yang jujur, informatif, dan mudah dipahami dalam bahasa Indonesia.'
  });

  const response = await stream.finalMessage();
  return response.content[0]?.text || 'Tidak dapat menganalisis saat ini.';
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server berjalan di http://localhost:${PORT}`));
