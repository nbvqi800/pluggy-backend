/* Backend Pluggy — versão segura.
   - Credenciais e Item IDs ficam SÓ aqui (variáveis de ambiente no Render).
   - Login por senha (feito no servidor) devolve um token assinado.
   - /meus-dados só responde com token válido; busca os dados frescos do Pluggy
     e devolve no formato do site (carregarOpenFinance).

   Variáveis de ambiente necessárias (Render -> Environment):
     PLUGGY_CLIENT_ID       (já tem)
     PLUGGY_CLIENT_SECRET   (já tem)
     ITEM_IDS               o id do item do Pluggy (vírgula para vários)
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

/* Health-check: responde rápido (usado para "acordar" o serviço free e checar status). */
app.get('/', (_req, res) => res.json({ ok: true, servico: 'pluggy-backend', hora: new Date().toISOString() }));

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
/* Janela de histórico. A doc não garante um padrão quando dateFrom é omitido,
   então mandamos sempre — assim o resultado é o mesmo a cada chamada. */
const MESES_HISTORICO = 24;
function desdeISO(meses) {
  const d = new Date();
  d.setMonth(d.getMonth() - meses);
  return d.toISOString().slice(0, 10);
}

async function coletar(itemId) {
  const accounts = (await client.fetchAccounts(itemId)).results || [];
  const dateFrom = desdeISO(MESES_HISTORICO);

  const txsPorConta = {};
  for (const acc of accounts) {
    const tr = await client.fetchAllTransactions(acc.id, { dateFrom });
    txsPorConta[acc.id] = Array.isArray(tr) ? tr : (tr.results || []);
  }

  let investments = [];
  try { investments = (await client.fetchInvestments(itemId)).results || []; } catch (_) {}

  // Nome do titular — usado na saudação e no cartão.
  let identidade = null;
  try { identidade = await client.fetchIdentityByItemId(itemId); } catch (_) {}

  return mapear(accounts, txsPorConta, investments, identidade);
}

app.get('/meus-dados', exigirAuth, async (req, res) => {
  try {
    if (!ITEM_IDS.length) return res.status(500).json({ error: 'ITEM_IDS nao configurada' });
    const partes = [];
    for (const itemId of ITEM_IDS) partes.push(await coletar(itemId));
    res.json(mesclar(partes));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Conferência: mostra o que o Pluggy devolveu, sem inventar nada. Serve para
   comparar campo a campo com o app do banco quando algum número não fecha. */
app.get('/diagnostico', exigirAuth, async (_req, res) => {
  try {
    const saida = [];
    for (const itemId of ITEM_IDS) {
      const accounts = (await client.fetchAccounts(itemId)).results || [];
      const contas = [];
      for (const acc of accounts) {
        const tx = await client.fetchAllTransactions(acc.id, { dateFrom: desdeISO(MESES_HISTORICO) });
        const lista = Array.isArray(tx) ? tx : (tx.results || []);
        const datas = lista.map((t) => String(t.date || '')).sort();
        contas.push({
          nome: acc.marketingName || acc.name,
          type: acc.type,
          subtype: acc.subtype,
          balance: acc.balance,
          creditData: acc.creditData || null,
          transacoes: lista.length,
          periodo: datas.length ? [datas[0].slice(0, 10), datas[datas.length - 1].slice(0, 10)] : null,
          comMCC: lista.filter((t) => t.creditCardMetadata && t.creditCardMetadata.payeeMCC != null).length,
          comCategoriaPluggy: lista.filter((t) => t.category).length,
          parceladas: lista.filter((t) => t.creditCardMetadata && t.creditCardMetadata.totalInstallments > 1).length,
          somaCreditos: +lista.filter((t) => t.type === 'CREDIT').reduce((s, t) => s + Math.abs(t.amount || 0), 0).toFixed(2),
          somaDebitos: +lista.filter((t) => t.type !== 'CREDIT').reduce((s, t) => s + Math.abs(t.amount || 0), 0).toFixed(2),
        });
      }
      saida.push({ itemId: itemId.slice(0, 8) + '…', contas });
    }
    res.json({ ok: true, itens: saida });
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

/* O Pluggy entrega a data em ISO UTC. Uma compra às 22h de 31/07 em Brasília
   vira 01/08 em UTC e cairia no mês errado. Convertemos para o fuso de São
   Paulo (UTC-3, sem horário de verão desde 2019) antes de cortar o dia.
   Quando vem só a data (sem hora), não há o que converter. */
function dataLocal(iso) {
  const s = String(iso || '');
  if (!s) return '';
  if (!s.includes('T')) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d.getTime())) return s.slice(0, 10);
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/* Rendimento do investimento, em fração (0,012 = 1,2%).
   Preferimos a taxa que o próprio provedor informa; só calculamos quando não
   vier nenhuma. NÃO usamos (balance - amount): amount é bruto e balance é
   líquido, então a diferença é imposto/taxa, não lucro. */
function rendimentoInv(i) {
  const taxa = [i.lastMonthRate, i.lastTwelveMonthsRate, i.annualRate]
    .find((v) => typeof v === 'number' && isFinite(v));
  if (typeof taxa === 'number') return Math.abs(taxa) > 1 ? taxa / 100 : taxa;
  if (typeof i.amountProfit === 'number' && i.amountOriginal > 0) return i.amountProfit / i.amountOriginal;
  return 0;
}

/* Parcelamentos em aberto, a partir dos metadados do cartão. Cada compra
   parcelada aparece uma vez por parcela; ficamos com a parcela mais recente
   de cada compra e só mantemos as que ainda têm parcelas a vencer. */
function extrairParcelamentos(transacoes) {
  const porCompra = new Map();
  for (const t of transacoes) {
    const m = t.creditCardMetadata;
    if (!m || !(m.totalInstallments > 1)) continue;
    const chave = `${t.description || ''}|${m.totalInstallments}|${m.purchaseDate || ''}`;
    const atual = porCompra.get(chave);
    if (!atual || (m.installmentNumber || 0) > (atual.creditCardMetadata.installmentNumber || 0)) {
      porCompra.set(chave, t);
    }
  }
  return [...porCompra.values()]
    .filter((t) => (t.creditCardMetadata.installmentNumber || 0) < t.creditCardMetadata.totalInstallments)
    .map((t) => ({
      item: t.description || 'Compra parcelada',
      loja: (t.merchant && (t.merchant.name || t.merchant.businessName)) || '',
      parcela: t.creditCardMetadata.installmentNumber || 1,
      total: t.creditCardMetadata.totalInstallments,
      valor: Math.abs(t.amount || 0),
    }));
}

function mapear(accounts, txsPorConta, investments, identidade) {
  const contas = [];
  const cartoes = [];
  const transacoes = [];
  const brutasCartao = [];
  const avisos = [];
  let idTx = 1;

  // O cartão principal é o titular (MAIN); no empate, o de maior limite.
  const doCartao = accounts.filter((a) => a.type === 'CREDIT');
  const principal = doCartao.slice().sort((a, b) => {
    const ma = (a.creditData && a.creditData.holderType) === 'MAIN' ? 1 : 0;
    const mb = (b.creditData && b.creditData.holderType) === 'MAIN' ? 1 : 0;
    if (ma !== mb) return mb - ma;
    return ((b.creditData && b.creditData.creditLimit) || 0) - ((a.creditData && a.creditData.creditLimit) || 0);
  })[0] || null;

  if (doCartao.length > 1) {
    avisos.push(`${doCartao.length} cartões encontrados; o site mostra o principal (${
      principal.marketingName || principal.name}). Os demais entram como conta.`);
  }

  for (const acc of accounts) {
    const cd = acc.creditData || null;
    const ehPrincipal = principal && acc.id === principal.id;

    if (acc.type === 'CREDIT' && ehPrincipal) {
      cartoes.push({
        nome: acc.marketingName || acc.name || 'Cartão',
        banco: acc.name || '',
        titular: acc.owner || (identidade && identidade.fullName) || '',
        bandeira: (cd && cd.brand) || '',
        nivel: (cd && cd.level) || '',
        final: String(acc.number || '').slice(-4),
        limite: (cd && cd.creditLimit) || 0,
        // Valores que o banco informa direto — não recalculamos por cima deles.
        faturaAtual: typeof acc.balance === 'number' ? acc.balance : null,
        limiteDisponivel: (cd && typeof cd.availableCreditLimit === 'number') ? cd.availableCreditLimit : null,
        pagamentoMinimo: (cd && cd.minimumPayment) || null,
        fechamento: String((cd && cd.balanceCloseDate) || '').slice(0, 10),
        vencimento: String((cd && cd.balanceDueDate) || '').slice(0, 10),
        faturaAnterior: null,
      });
    } else if (acc.type === 'CREDIT') {
      // Cartão adicional: é dívida, entra como saldo negativo.
      contas.push({
        id: acc.id,
        nome: `${acc.marketingName || acc.name || 'Cartão'} (adicional)`,
        banco: acc.name || '',
        saldo: -Math.abs(acc.balance || 0),
      });
    } else {
      contas.push({
        id: acc.id,
        nome: acc.marketingName || acc.name || 'Conta',
        banco: acc.name || '',
        saldo: acc.balance || 0,
      });
    }

    for (const t of txsPorConta[acc.id] || []) {
      const m = t.creditCardMetadata || null;
      if (acc.type === 'CREDIT') brutasCartao.push(t);

      // `type` normaliza o sinal: no cartão uma despesa vem positiva, na conta
      // corrente vem negativa. Usar só o sinal de `amount` erraria em um dos dois.
      const valor = t.type === 'CREDIT' ? Math.abs(t.amount || 0) : -Math.abs(t.amount || 0);

      transacoes.push({
        id: idTx++,
        data: dataLocal(t.date),
        desc: t.description || t.descriptionRaw || '',
        // O MCC vive em creditCardMetadata.payeeMCC. NÃO existe merchant.mcc —
        // era isso que deixava o motor de categorização por MCC sem sinal.
        mcc: (m && typeof m.payeeMCC === 'number') ? m.payeeMCC : null,
        // Categoria própria do Pluggy, quando o plano fornece; o site usa como
        // desempate antes de cair nas regras de palavra-chave.
        categoriaPluggy: t.category || null,
        valor,
        meio: (acc.type === 'CREDIT' && ehPrincipal) ? 'cartao' : acc.id,
      });
    }
  }

  const investimentos = (investments || []).map((i) => ({
    nome: i.name || i.issuer || i.type || 'Investimento',
    classe: i.type || 'Investimento',
    valor: typeof i.balance === 'number' ? i.balance : (i.amount || 0),
    rendimento: rendimentoInv(i),
  }));

  return {
    perfil: { nome: primeiroNome((identidade && identidade.fullName) || '') },
    contas,
    cartao: cartoes[0] || null,
    transacoes,
    investimentos,
    parcelamentos: extrairParcelamentos(brutasCartao),
    avisos,
  };
}

const primeiroNome = (nome) => String(nome || '').trim().split(/\s+/)[0] || '';

/* Junta vários itens num payload só. */
function mesclar(partes) {
  const out = {
    perfil: { nome: '' }, contas: [], cartao: null,
    transacoes: [], investimentos: [], parcelamentos: [], avisos: [],
  };
  let tid = 1;
  for (const p of partes) {
    if (!out.perfil.nome && p.perfil && p.perfil.nome) out.perfil = p.perfil;
    out.contas.push(...p.contas);
    out.investimentos.push(...p.investimentos);
    out.parcelamentos.push(...p.parcelamentos);
    out.avisos.push(...p.avisos);
    if (!out.cartao && p.cartao) out.cartao = p.cartao;
    for (const t of p.transacoes) out.transacoes.push({ ...t, id: tid++ });
  }
  return out;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`pluggy-backend (seguro) na porta ${PORT}`));
