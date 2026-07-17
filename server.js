const express = require('express');
const cors = require('cors');
const { PluggyClient } = require('pluggy-sdk');

const app = express();
app.use(cors());

const client = new PluggyClient({
  clientId: process.env.PLUGGY_CLIENT_ID,
  clientSecret: process.env.PLUGGY_CLIENT_SECRET,
});

app.get('/connect-token', async (req, res) => {
  try {
    const { accessToken } = await client.createConnectToken();
    res.json({ token: accessToken });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/dados/:itemId', async (req, res) => {
  try {
    const accounts = await client.fetchAccounts(req.params.itemId);
    const transactions = await client.fetchTransactions(accounts.results[0].id);
    res.json({ accounts: accounts.results, transactions: transactions.results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(3000, () => console.log('Servidor rodando'));
