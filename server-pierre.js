/* Backend Pierre — híbrido.
   ----------------------------------------------------------------------------
   Contas, transações, cartão e parcelamentos vêm da API do Pierre
   (https://www.pierre.finance/tools/api). Os INVESTIMENTOS continuam vindo do
   Pluggy: o Pierre não expõe a carteira detalhada (ativo a ativo), só o saldo
   agregado — então a tela de Carteira ficaria vazia se dependesse só dele.

   A saída (`carregarOpenFinance`) é EXATAMENTE a mesma do server.js do Pluggy,
   então o site não muda em nada. Só a origem dos dados muda.

   Variáveis de ambiente (Render -> Environment):
     PIERRE_API_KEY         a chave sk-... do Pierre            (obrigatória)
     APP_PASSWORD           a senha que você digita no site     (obrigatória)
     SESSION_SECRET         texto aleatório longo (assina token)(obrigatória)
     CORS_ORIGIN            a URL do site
     PLUGGY_CLIENT_ID       só para os investimentos            (opcional)
     PLUGGY_CLIENT_SECRET   só para os investimentos            (opcional)
     ITEM_IDS               item(ns) do Pluggy p/ investimentos (opcional)
*/

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { PluggyClient } = require('pluggy-sdk');

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

app.get('/', (_req, res) => res.json({ ok: true, servico: 'pierre-backend', hora: new Date().toISOString() }));

/* ---------- Pierre ---------- */
const PIERRE_BASE = 'https://www.pierre.finance/tools/api';
const PIERRE_KEY = process.env.PIERRE_API_KEY || '';

async function pierreGet(caminho) {
  const r = await fetch(`${PIERRE_BASE}/${caminho}`, {
    headers: { Authorization: `Bearer ${PIERRE_KEY}`, 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error(`Pierre ${caminho}: HTTP ${r.status}`);
  const j = await r.json();
  if (!j || j.success !== true) throw new Error(`Pierre ${caminho}: resposta sem success`);
  return j.data;
}

/* ---------- Pluggy (só investimentos) ---------- */
const temPluggy = !!(process.env.PLUGGY_CLIENT_ID && process.env.PLUGGY_CLIENT_SECRET);
const pluggy = temPluggy
  ? new PluggyClient({ clientId: process.env.PLUGGY_CLIENT_ID, clientSecret: process.env.PLUGGY_CLIENT_SECRET })
  : null;
const ITEM_IDS = (process.env.ITEM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

async function coletarInvestimentos() {
  if (!pluggy || !ITEM_IDS.length) return [];
  const todos = [];
  for (const itemId of ITEM_IDS) {
    try { todos.push(...((await pluggy.fetchInvestments(itemId)).results || [])); } catch (_) {}
  }
  return todos;
}

/* ---------- token (idêntico ao server.js) ---------- */
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || 'troque-o-SESSION_SECRET';
const DIAS_TOKEN = 30;

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

app.post('/login', (req, res) => {
  const senha = (req.body && (req.body.senha || req.body.password)) || '';
  if (!APP_PASSWORD) return res.status(500).json({ error: 'APP_PASSWORD nao configurada' });
  const ok = senha.length === APP_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(senha), Buffer.from(APP_PASSWORD));
  if (!ok) return res.status(401).json({ error: 'senha_incorreta' });
  res.json({ token: assinar({ exp: Date.now() + DIAS_TOKEN * 864e5 }) });
});

/* ---------- dados (protegido) ---------- */
app.get('/meus-dados', exigirAuth, async (_req, res) => {
  try {
    if (!PIERRE_KEY) return res.status(500).json({ error: 'PIERRE_API_KEY nao configurada' });
    const [accounts, transactions, bills, installments, investments] = await Promise.all([
      pierreGet('get-accounts'),
      pierreGet('get-transactions'),
      pierreGet('get-bills'),
      pierreGet('get-installments'),
      coletarInvestimentos(),
    ]);
    res.json(mapear(accounts, transactions, bills, installments, investments));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* TEMPORÁRIO — descobre se a Pluggy/BTG fornece as movimentações (aportes) dos
   investimentos. NÃO expõe nomes de ativos nem valores: só contagens, tipos e a
   LISTA de campos disponíveis. Aberto (sem token) só para você abrir no
   navegador. Remover depois de decidir sobre a tela de aportes. */
app.get('/teste-aportes', async (_req, res) => {
  try {
    if (!pluggy || !ITEM_IDS.length) return res.json({ erro: 'sem_pluggy_ou_itemids' });
    if (typeof pluggy.fetchInvestmentTransactions !== 'function') {
      return res.json({ erro: 'metodo_indisponivel_no_sdk' });
    }
    const detalhe = [];
    for (const itemId of ITEM_IDS) {
      const invs = (await pluggy.fetchInvestments(itemId)).results || [];
      for (const inv of invs) {
        let txs = [];
        let falhou = null;
        try { txs = (await pluggy.fetchInvestmentTransactions(inv.id)).results || []; }
        catch (e) { falhou = e.message; }
        detalhe.push({
          classe: inv.type || null,
          qtdMovimentos: txs.length,
          tipos: [...new Set(txs.map((t) => t.type).filter(Boolean))],
          movimentos: [...new Set(txs.map((t) => t.movementType).filter(Boolean))],
          campos: txs[0] ? Object.keys(txs[0]) : [],
          erro: falhou,
        });
      }
    }
    res.json({
      totalInvestimentos: detalhe.length,
      comMovimentacoes: detalhe.filter((d) => d.qtdMovimentos > 0).length,
      detalhe,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Sincroniza no Pierre antes de buscar (equivale ao "atualizar" do Pluggy). */
app.post('/atualizar', exigirAuth, async (_req, res) => {
  try {
    await fetch(`${PIERRE_BASE}/manual-update`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${PIERRE_KEY}`, 'Content-Type': 'application/json' },
    });
  } catch (_) {}
  res.json({ ok: true });
});

/* Conferência campo a campo — para comparar com o app do banco. */
app.get('/diagnostico', exigirAuth, async (_req, res) => {
  try {
    const [accounts, transactions, bills] = await Promise.all([
      pierreGet('get-accounts'), pierreGet('get-transactions'), pierreGet('get-bills'),
    ]);
    const porConta = {};
    for (const t of transactions) (porConta[t.account_id] ||= []).push(t);
    const contas = accounts.map((a) => {
      const lista = porConta[a.id] || [];
      const datas = lista.map((t) => String(t.date || '').slice(0, 10)).sort();
      return {
        nome: a.customName || a.marketingName || a.name,
        type: a.type, subtype: a.subtype, balance: num(a.balance),
        transacoes: lista.length,
        periodo: datas.length ? [datas[0], datas[datas.length - 1]] : null,
        comCategoria: lista.filter((t) => t.category).length,
        somaCreditos: +lista.filter((t) => t.type === 'CREDIT').reduce((s, t) => s + Math.abs(num(t.amount)), 0).toFixed(2),
        somaDebitos: +lista.filter((t) => t.type !== 'CREDIT').reduce((s, t) => s + Math.abs(num(t.amount)), 0).toFixed(2),
      };
    });
    res.json({ ok: true, totalTransacoes: transactions.length, faturas: bills.length, contas });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============ Pierre -> formato do site ============ */

const num = (v) => (typeof v === 'number' ? v : (parseFloat(String(v ?? '').replace(',', '.')) || 0));
const primeiroNome = (nome) => String(nome || '').trim().split(/\s+/)[0] || '';
function tituloCaso(nome) {
  return String(nome || '').toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/* ISO UTC -> dia local de São Paulo (UTC-3). Uma compra às 22h de 31/07 em
   Brasília chega como 01/08 em UTC e cairia no mês errado sem esta correção. */
function dataLocal(iso) {
  const s = String(iso || '');
  if (!s) return '';
  if (!s.includes('T')) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d.getTime())) return s.slice(0, 10);
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/* O BTG descreve um PIX só como "Pix"; quem enviou/recebeu vem em payment_data.
   Numa entrada interessa o pagador; numa saída, o recebedor. */
function descricaoRica(t) {
  const base = String(t.description || t.original_description || '').trim();
  const pd = t.payment_data || null;
  const outro = pd && (t.type === 'CREDIT' ? pd.payer : pd.receiver);
  const nome = String((outro && outro.name) || (t.merchant && (t.merchant.name || t.merchant.businessName)) || '').trim();
  if (!nome) return base;
  const j = base.toLowerCase();
  if (j && j.includes(nome.toLowerCase().slice(0, 12))) return base;
  return base ? `${base} - ${nome}` : nome;
}

/* Rendimento do investimento (fração). Mesma lógica do server.js do Pluggy. */
function rendimentoInv(i) {
  const taxa = [i.lastMonthRate, i.lastTwelveMonthsRate, i.annualRate]
    .find((v) => typeof v === 'number' && isFinite(v));
  if (typeof taxa === 'number') return Math.abs(taxa) > 1 ? taxa / 100 : taxa;
  if (typeof i.amountProfit === 'number' && i.amountOriginal > 0) return i.amountProfit / i.amountOriginal;
  return 0;
}

function mapear(accounts, transacoesRaw, bills, installmentsData, investments) {
  accounts = Array.isArray(accounts) ? accounts : [];
  transacoesRaw = Array.isArray(transacoesRaw) ? transacoesRaw : [];
  bills = Array.isArray(bills) ? bills : [];

  const contas = [];
  const cartoes = [];
  const transacoes = [];
  const avisos = [];

  // Cartão principal: o titular (MAIN); no empate, o de maior limite.
  const doCartao = accounts.filter((a) => a.type === 'CREDIT');
  const principal = doCartao.slice().sort((a, b) => {
    const ma = (a.creditData && a.creditData.holderType) === 'MAIN' ? 1 : 0;
    const mb = (b.creditData && b.creditData.holderType) === 'MAIN' ? 1 : 0;
    if (ma !== mb) return mb - ma;
    return ((b.creditData && b.creditData.creditLimit) || 0) - ((a.creditData && a.creditData.creditLimit) || 0);
  })[0] || null;

  if (doCartao.length > 1) {
    avisos.push(`${doCartao.length} cartões encontrados; o site mostra o principal (${
      principal.name}). Os demais entram como conta.`);
  }

  // Fatura anterior = fatura fechada mais recente com valor > 0.
  let faturaAnterior = null;
  if (principal) {
    const fechadas = bills
      .filter((b) => b.accountId === principal.id && num(b.totalAmount) > 0)
      .sort((a, b) => String(b.dueDate).localeCompare(String(a.dueDate)));
    if (fechadas[0]) {
      faturaAnterior = {
        valor: num(fechadas[0].totalAmount),
        vencimento: String(fechadas[0].dueDate).slice(0, 10),
        status: 'paga',
      };
    }
  }

  for (const acc of accounts) {
    const cd = acc.creditData || null;
    const ehPrincipal = principal && acc.id === principal.id;

    if (acc.type === 'CREDIT' && ehPrincipal) {
      cartoes.push({
        nome: acc.marketingName || acc.name || 'Cartão',
        banco: acc.connectorName || acc.name || '',
        titular: tituloCaso(acc.owner || ''),
        bandeira: (cd && cd.brand) || '',
        nivel: (cd && cd.level) || '',
        final: String(acc.number || '').slice(-4),
        limite: (cd && cd.creditLimit) || 0,
        faturaAtual: num(acc.balance),
        limiteDisponivel: (cd && typeof cd.availableCreditLimit === 'number') ? cd.availableCreditLimit : null,
        pagamentoMinimo: (cd && cd.minimumPayment) || null,
        fechamento: String((cd && cd.balanceCloseDate) || '').slice(0, 10),
        vencimento: String((cd && cd.balanceDueDate) || '').slice(0, 10),
        faturaAnterior,
      });
    } else if (acc.type === 'CREDIT') {
      contas.push({ id: acc.id, nome: `${acc.marketingName || acc.name || 'Cartão'} (adicional)`, banco: acc.connectorName || acc.name || '', saldo: -Math.abs(num(acc.balance)) });
    } else {
      contas.push({ id: acc.id, nome: acc.customName || acc.marketingName || acc.name || 'Conta', banco: acc.connectorName || acc.name || '', saldo: num(acc.balance) });
    }
  }

  let idTx = 1;
  for (const t of transacoesRaw) {
    // `type` normaliza o sinal: entrada positiva, saída negativa — em conta ou
    // cartão. Usar só o sinal cru de amount erraria num dos dois.
    const valor = t.type === 'CREDIT' ? Math.abs(num(t.amount)) : -Math.abs(num(t.amount));
    transacoes.push({
      id: idTx++,
      data: dataLocal(t.date),
      desc: descricaoRica(t),
      // O Pierre não entrega MCC, mas já manda a categoria pronta (t.category);
      // o site a traduz em categorias.js (traduzirCategoriaPluggy).
      mcc: null,
      categoriaPluggy: t.category || t.original_category || null,
      valor,
      meio: (principal && t.account_id === principal.id) ? 'cartao' : t.account_id,
    });
  }

  // Parcelamentos em aberto (compras com parcelas a vencer).
  const parcelamentos = [];
  const purchases = (installmentsData && Array.isArray(installmentsData.purchases)) ? installmentsData.purchases : [];
  for (const p of purchases) {
    if (!(p.installmentsRemaining > 0)) continue;
    parcelamentos.push({
      item: p.description || 'Compra parcelada',
      loja: p.accountName || '',
      parcela: p.installmentsPaid || 0,
      total: p.totalInstallments || 0,
      valor: num(p.installmentValue),
    });
  }

  const investimentos = (investments || []).map((i) => ({
    nome: i.name || i.issuer || i.type || 'Investimento',
    classe: i.type || 'Investimento',
    valor: typeof i.balance === 'number' ? i.balance : (i.amount || 0),
    rendimento: rendimentoInv(i),
  }));

  const dono = tituloCaso((accounts.find((a) => a.owner) || {}).owner || '');

  return {
    perfil: { nome: primeiroNome(dono) },
    contas,
    cartao: cartoes[0] || null,
    transacoes,
    investimentos,
    parcelamentos,
    avisos,
  };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`pierre-backend na porta ${PORT}`));
