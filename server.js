/* Backend mínimo Pluggy -> formato do site (carregarOpenFinance).
   As credenciais ficam SÓ aqui (variáveis de ambiente no Render), nunca no site.

   Rotas:
     GET /connect-token      -> token para o widget Pluggy Connect abrir
     GET /dados/:itemId      -> payload já no formato de js/dados.js

   IMPORTANTE: os nomes dos campos da resposta do Pluggy (marketingName,
   creditData, merchant.mcc, type CREDIT/DEBIT…) podem variar por versão do SDK.
   Confira contra a doc oficial no primeiro teste: https://docs.pluggy.ai
*/

const express = require('express');
const cors = require('cors');
const { PluggyClient } = require('pluggy-sdk');

const app = express();

// Em produção, troque '*' pelo domínio do seu site (ex.: https://seuuser.github.io).
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

const client = new PluggyClient({
  clientId: process.env.PLUGGY_CLIENT_ID,
  clientSecret: process.env.PLUGGY_CLIENT_SECRET,
});

/* Token para o widget conectar o banco no navegador. */
app.get('/connect-token', async (req, res) => {
  try {
    const { accessToken } = await client.createConnectToken();
    res.json({ token: accessToken });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Busca tudo de um item conectado e devolve no formato do site. */
app.get('/dados/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;

    const contasResp = await client.fetchAccounts(itemId);
    const accounts = contasResp.results || [];

    // Transações de cada conta (cursor /v2/transactions — método novo do SDK).
    const txsPorConta = {};
    for (const acc of accounts) {
      const tr = await client.fetchAllTransactions(acc.id);
      txsPorConta[acc.id] = Array.isArray(tr) ? tr : (tr.results || []);
    }

    // Investimentos (pode não existir para todo item).
    let investments = [];
    try {
      const inv = await client.fetchInvestments(itemId);
      investments = inv.results || [];
    } catch (_) { /* item sem investimentos */ }

    res.json(mapear(accounts, txsPorConta, investments));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Pluggy -> formato carregarOpenFinance ---------- */
function mapear(accounts, txsPorConta, investments) {
  const contas = [];
  let cartao = null;
  const transacoes = [];
  let idTx = 1;

  for (const acc of accounts) {
    const ehCartao = acc.type === 'CREDIT';

    if (ehCartao) {
      cartao = {
        nome: acc.marketingName || acc.name || 'Cartão',
        final: String(acc.number || '').slice(-4),
        limite: (acc.creditData && acc.creditData.creditLimit) || 0,
        fechamento: (acc.creditData && acc.creditData.balanceCloseDate || '').slice(0, 10),
        vencimento: (acc.creditData && acc.creditData.balanceDueDate || '').slice(0, 10),
        faturaAnterior: null,
      };
    } else {
      contas.push({
        id: acc.id,
        nome: acc.marketingName || acc.name || 'Conta',
        banco: acc.name || '',
        saldo: acc.balance || 0,
      });
    }

    for (const t of txsPorConta[acc.id] || []) {
      // Pluggy usa type CREDIT (entrada) / DEBIT (saída). Normaliza o sinal:
      const valor = t.type === 'CREDIT' ? Math.abs(t.amount) : -Math.abs(t.amount);
      transacoes.push({
        id: idTx++,
        data: String(t.date || '').slice(0, 10),
        desc: t.description || t.descriptionRaw || '',
        mcc: (t.merchant && t.merchant.mcc) || null, // MCC quando o Pluggy fornece
        valor,
        meio: ehCartao ? 'cartao' : acc.id,
      });
    }
  }

  const investimentos = (investments || []).map((i) => ({
    nome: i.name || i.type || 'Investimento',
    classe: i.type || 'Investimento',
    valor: i.balance || i.amount || 0,
    rendimento: 0, // Pluggy nem sempre traz rentabilidade no mês; ajuste se precisar
  }));

  return { contas, cartao, transacoes, investimentos };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`pluggy-backend rodando na porta ${PORT}`));
