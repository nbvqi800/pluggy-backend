/* Backend Pluggy — versão segura.
   - Credenciais e Item IDs ficam SÓ aqui (variáveis de ambiente no Render).
   - Login por senha (feito no servidor) devolve um token assinado.
   - /meus-dados só responde com token válido; busca os dados frescos do Pluggy
     e devolve no formato do site (carregarOpenFinance).

   Variáveis de ambiente necessárias (Render -> Environment):
     PLUGGY_CLIENT_ID       (já tem)
     PLUGGY_CLIENT_SECRET   (já tem)
     ITEM_IDS               ex.: f5010e3e-ddad-4991-affc-6310008b4203  (vírgula p/ vários)
     APP_PASSWORD           a senha que você vai digitar no site
     SESSION_SECRET         qualquer texto aleatório longo (assina o token)
     CORS_ORIGIN            a URL do site (ex.: https://seusite.netlify.app)
*/

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { PluggyClient } = require('pluggy-sdk');

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

const client = new PluggyClient({
  clientId: process.env.PLUGGY_CLIENT_ID,
  clientSecret: process.env.PLUGGY_CLIENT_SECRET,
});

const ITEM_IDS = (process.env.ITEM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || 'troque-o-SESSION_SECRET';
const DIAS_TOKEN = 30;

/* ---------- token (HMAC, sem dependência extra) ---------- */
function assinar(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verificar(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const esperado = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (_) { return null; }
}
function exigirAuth(req, res, next) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!verificar(token)) return res.status(401).json({ error: 'nao_autorizado' });
  next();
}

/* ---------- login ---------- */
app.post('/login', (req, res) => {
  const senha = (req.body && (req.body.senha || req.body.password)) || '';
  if (!APP_PASSWORD) return res.status(500).json({ error: 'APP_PASSWORD nao configurada' });
  const ok = senha.length === APP_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(senha), Buffer.from(APP_PASSWORD));
  if (!ok) return res.status(401).json({ error: 'senha_incorreta' });
  res.json({ token: assinar({ exp: Date.now() + DIAS_TOKEN * 864e5 }) });
});

/* ---------- dados (protegido) ---------- */
app.get('/meus-dados', exigirAuth, async (req, res) => {
  try {
    if (!ITEM_IDS.length) return res.status(500).json({ error: 'ITEM_IDS nao configurada' });
    const partes = [];
    for (const itemId of ITEM_IDS) {
      const accounts = (await client.fetchAccounts(itemId)).results || [];
      const txsPorConta = {};
      for (const acc of accounts) {
        const tr = await client.fetchAllTransactions(acc.id);
        txsPorConta[acc.id] = Array.isArray(tr) ? tr : (tr.results || []);
      }
      let investments = [];
      try { investments = (await client.fetchInvestments(itemId)).results || []; } catch (_) {}
      partes.push(mapear(accounts, txsPorConta, investments));
    }
    res.json(mesclar(partes));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Opcional: força o Pluggy a sincronizar (dados mais novos) antes de buscar. */
app.post('/atualizar', exigirAuth, async (req, res) => {
  try {
    for (const itemId of ITEM_IDS) { try { await client.updateItem(itemId); } catch (_) {} }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Pluggy -> formato do site ---------- */
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
        fechamento: String((acc.creditData && acc.creditData.balanceCloseDate) || '').slice(0, 10),
        vencimento: String((acc.creditData && acc.creditData.balanceDueDate) || '').slice(0, 10),
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
      const valor = t.type === 'CREDIT' ? Math.abs(t.amount) : -Math.abs(t.amount);
      transacoes.push({
        id: idTx++,
        data: String(t.date || '').slice(0, 10),
        desc: t.description || t.descriptionRaw || '',
        mcc: (t.merchant && t.merchant.mcc) || null,
        valor,
        meio: ehCartao ? 'cartao' : acc.id,
      });
    }
  }

  const investimentos = (investments || []).map((i) => ({
    nome: i.name || i.type || 'Investimento',
    classe: i.type || 'Investimento',
    valor: i.balance || i.amount || 0,
    rendimento: 0,
  }));

  return { contas, cartao, transacoes, investimentos };
}

/* Junta vários itens num payload só. */
function mesclar(partes) {
  const out = { contas: [], cartao: null, transacoes: [], investimentos: [] };
  let tid = 1;
  for (const p of partes) {
    out.contas.push(...p.contas);
    out.investimentos.push(...p.investimentos);
    if (!out.cartao && p.cartao) out.cartao = p.cartao;
    for (const t of p.transacoes) out.transacoes.push({ ...t, id: tid++ });
  }
  return out;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`pluggy-backend (seguro) na porta ${PORT}`));
