'use strict';
/* ============================================================================
 * Proxy da IA de citações — para o site "Grupo de Estudos em Teoria Literária".
 * Roda de graça no Render. A chave da Anthropic fica AQUI (variável de ambiente),
 * nunca no navegador. Só o coordenador (felipevigneron@gmail.com) pode chamar —
 * validado pelo token de login do Firebase.
 *
 * Variáveis de ambiente no Render:
 *   ANTHROPIC_API_KEY   = sk-ant-...        (obrigatória p/ IA)
 *   ALLOWED_ORIGIN      = https://grupo-de-pesquisa-9e35f.web.app (padrão já aponta p/ ela)
 *   FIREBASE_PROJECT_ID = grupo-de-pesquisa-9e35f                 (padrão já correto)
 *   FIREBASE_SERVICE_ACCOUNT_JSON = { ... } (obrigatória p/ backup diário — ver COMO-ATIVAR.md)
 *   BACKUP_SECRET       = uma senha longa qualquer, só sua (protege o gatilho do backup)
 * ==========================================================================*/

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { google } = require('googleapis');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'grupo-de-pesquisa-9e35f';
admin.initializeApp({ projectId: PROJECT_ID }); // verifyIdToken não precisa de service account

// Segunda instância do Admin SDK, COM credenciais, só para o backup escrever no Firestore.
// (a instância padrão acima, sem credenciais, só serve para validar o token de login)
let _dbBackup = null;
function _getDbBackup() {
  if (_dbBackup) return _dbBackup;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const cred = admin.credential.cert(JSON.parse(raw));
    const app2 = admin.initializeApp({ credential: cred, projectId: PROJECT_ID }, 'backupApp');
    _dbBackup = app2.firestore();
    return _dbBackup;
  } catch (e) {
    console.error('FIREBASE_SERVICE_ACCOUNT_JSON inválida:', e.message);
    return null;
  }
}

/* ---------- Espelho em Google Sheets (planilha legível, sempre atualizada) ----------
 * Usa a MESMA chave de serviço do Firebase (é uma conta de serviço do Google Cloud,
 * serve para os dois). Para funcionar, o usuário precisa: (1) ativar a API do Google
 * Sheets no projeto, (2) compartilhar a planilha com o e-mail da conta de serviço
 * (endpoint /conta-servico devolve esse e-mail), (3) definir GOOGLE_SHEET_ID.
 * A planilha é um ESPELHO de leitura — a restauração oficial usa o JSON, não ela,
 * porque a planilha achata listas e datas em texto.
 * --------------------------------------------------------------------------------- */
function _credenciaisServico() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// Aceita o GOOGLE_SHEET_ID colado de qualquer jeito: só o ID, a URL inteira, com barra
// sobrando no fim, com espaços. Exigir o formato exato só rendia erro difícil de enxergar
// ("o arquivo que você solicitou não existe") por causa de um caractere invisível.
function _sheetId() {
  const bruto = (process.env.GOOGLE_SHEET_ID || '').trim();
  if (!bruto) return '';
  const daUrl = bruto.match(/\/d\/([a-zA-Z0-9_-]+)/); // URL completa da planilha
  if (daUrl) return daUrl[1];
  return bruto.replace(/^\/+|\/+$/g, '').split(/[/?#]/)[0];
}

let _sheetsApi = null;
function _getSheets() {
  if (_sheetsApi) return _sheetsApi;
  const cred = _credenciaisServico();
  if (!cred || !_sheetId()) return null;
  const auth = new google.auth.JWT({
    email: cred.client_email,
    key: cred.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  _sheetsApi = google.sheets({ version: 'v4', auth });
  return _sheetsApi;
}

const ABA_CITACOES = 'Citações';
const ABA_CRITICA  = 'Crítica Literária';
const ABA_AUTORES  = 'Correntes (autores)';

const COLUNAS_SHEET = [
  'tipo', 'id', 'citacao', 'pagina', 'autor_obra', 'obra', 'corrente_critica',
  'tema', 'comentario', 'referencia_abnt', 'pesquisador', 'data_insercao',
  'atualizado_por', 'atualizado_em'
];

// Timestamp do Firestore (ou string/Date) → texto legível AAAA-MM-DD HH:MM
function _dataLegivel(v) {
  if (!v) return '';
  try {
    if (typeof v.toDate === 'function') return v.toDate().toISOString().slice(0, 16).replace('T', ' ');
    if (v instanceof Date) return v.toISOString().slice(0, 16).replace('T', ' ');
    return String(v);
  } catch (_) { return ''; }
}

// Cria as abas que ainda não existem — assim o usuário só precisa criar a planilha vazia,
// sem ter que acertar nomes de aba na mão.
async function _garantirAbas(sheets, spreadsheetId, nomes) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existentes = (meta.data.sheets || []).map(s => s.properties.title);
  const faltando = nomes.filter(n => !existentes.includes(n));
  if (!faltando.length) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: faltando.map(title => ({ addSheet: { properties: { title } } })) }
  });
}

// Reescreve a planilha inteira com o estado atual (limpa e regrava — idempotente).
// Devolve { ok, erro } e NUNCA lança: falha na planilha não pode derrubar o backup real.
async function _exportarParaSheets({ citacoes = [], critica = [], autores = [] }) {
  const sheets = _getSheets();
  if (!sheets) return { ok: false, erro: 'Planilha não configurada (falta GOOGLE_SHEET_ID ou credencial).' };
  const spreadsheetId = _sheetId();
  const agora = new Date().toISOString().slice(0, 16).replace('T', ' ');

  // Uma linha por citação
  const linhasCitacoes = citacoes.map(c => [
    c.tipo || '', c.id || '', c.citacao || '', c.pagina || '', c.autor_obra || '',
    c.obra || '', c.corrente_critica || '', (c.tema || []).join('; '), c.comentario || '',
    c.referencia_abnt || '', c.pesquisador || '', _dataLegivel(c.data_insercao),
    c.atualizado_por || '', _dataLegivel(c.atualizado_em)
  ]);

  // Crítica Literária guarda `conceitos` como lista de objetos aninhados; a planilha é plana,
  // então cada conceito vira uma linha, repetindo corrente/período. Correntes sem nenhum
  // conceito ainda aparecem (uma linha), para não sumirem do espelho.
  const linhasCritica = [];
  critica.forEach(c => {
    const conceitos = Array.isArray(c.conceitos) && c.conceitos.length ? c.conceitos : [null];
    conceitos.forEach(k => linhasCritica.push([
      c.id || '', c.corrente || '', c.periodo || '', c.ordem ?? '',
      k ? (k.conceito || '') : '', k ? (k.definicao || '') : '',
      k ? (k.exemplo || '') : '', k ? (k.fonte || '') : '',
      c.atualizadoPor || '', _dataLegivel(c.atualizadoEm)
    ]));
  });

  // `correntes` é uma lista (um autor pode transitar por várias) — vira texto separado por ";"
  const linhasAutores = autores.map(a => [
    a.id || '', a.autor || '',
    Array.isArray(a.correntes) ? a.correntes.join('; ') : (a.correntes || ''),
    a.contribuicoes || ''
  ]);

  const blocos = [
    { aba: ABA_CITACOES, cabecalho: COLUNAS_SHEET, linhas: linhasCitacoes, rotulo: 'citações' },
    { aba: ABA_CRITICA, rotulo: 'linhas de conceito',
      cabecalho: ['id', 'corrente', 'periodo', 'ordem', 'conceito', 'definicao', 'exemplo', 'fonte', 'atualizadoPor', 'atualizadoEm'],
      linhas: linhasCritica },
    { aba: ABA_AUTORES, rotulo: 'autores',
      cabecalho: ['id', 'autor', 'correntes', 'contribuicoes'],
      linhas: linhasAutores }
  ];

  try {
    await _garantirAbas(sheets, spreadsheetId, blocos.map(b => b.aba));
    for (const b of blocos) {
      const faixa = `'${b.aba}'`;
      await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${faixa}!A:Z` });
      await sheets.spreadsheets.values.update({
        spreadsheetId, range: `${faixa}!A1`, valueInputOption: 'RAW',
        requestBody: {
          values: [
            [`Atualizado em ${agora} UTC — ${b.linhas.length} ${b.rotulo}`],
            b.cabecalho,
            ...b.linhas
          ]
        }
      });
    }
    return { ok: true, citacoes: linhasCitacoes.length, critica: linhasCritica.length, autores: linhasAutores.length };
  } catch (e) {
    console.error('Erro ao exportar para Sheets:', e.message);
    return { ok: false, erro: e.message };
  }
}

const FELIPE = 'felipevigneron@gmail.com';
const KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED = (process.env.ALLOWED_ORIGIN || 'https://grupo-de-pesquisa-9e35f.web.app')
  .split(',').map(s => s.trim());

const app = express();
app.use(cors({ origin: ALLOWED }));
app.use(express.json({ limit: '1mb' }));

// Autenticação: exige token do Firebase e e-mail do coordenador
async function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Sem token' });
    const decoded = await admin.auth().verifyIdToken(token);
    if (decoded.email !== FELIPE) return res.status(403).json({ error: 'Apenas o coordenador.' });
    req.user = decoded;
    next();
  } catch (_) {
    return res.status(401).json({ error: 'Token inválido.' });
  }
}

// Rate limit simples em memória: 60 chamadas/hora (protege a chave)
const hits = [];
function rate(res) {
  const agora = Date.now(), hora = 3600000;
  while (hits.length && hits[0] < agora - hora) hits.shift();
  if (hits.length >= 60) { res.status(429).json({ error: 'Limite de 60/hora atingido.' }); return false; }
  hits.push(agora); return true;
}

// Categorizar / reconhecer uma citação → { comentario, citacao, pagina, relacoes, tema[], corrente }
app.post('/categorizar', auth, async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'Chave Anthropic não configurada no servidor.' });
  if (!rate(res)) return;
  const {
    texto = '', modelo = 'claude-sonnet-5', esforco = 'medium',
    formato = 'Comentário - "citação" (página X) - outros comentários ou relações'
  } = req.body || {};
  if (!texto || texto.length > 8000) return res.status(400).json({ error: 'Texto inválido.' });

  const CORRENTES_REFERENCIA = [
    'Formalismo Russo', 'Estruturalismo', 'New Criticism (Nova Crítica)',
    'Crítica Marxista / Sociológica', 'Crítica Psicanalítica', 'Pós-estruturalismo / Desconstrução',
    'Estética da Recepção', 'Hermenêutica e Fenomenologia', 'Narratologia', 'Estudos Culturais',
    'Estudos Pós-coloniais', 'Crítica Feminista e Teoria Queer', 'Teoria Crítica (Escola de Frankfurt)',
    'Semiótica', 'Crítica Literária Brasileira'
  ].join(', ');

  const sistema =
    'Você é assistente de um grupo de pesquisa em Teoria Literária brasileira. ' +
    'Recebe uma anotação em texto livre que segue, aproximadamente, o padrão:\n  ' + formato + '\n' +
    'Separe os campos com fidelidade ao texto original (não invente conteúdo).\n\n' +
    'Para "tema" e "corrente": baseie-se ESTRITAMENTE no que o texto da citação e do comentário ' +
    'efetivamente argumentam — nunca na reputação geral do autor da obra ou em associações que você ' +
    'conheça sobre ele por outras fontes. Um autor pode escrever a partir de correntes diferentes ao ' +
    'longo da carreira, ou até citar/comentar uma corrente sem praticá-la; um crítico famoso por uma ' +
    'escola pode, num trecho específico, não estar fazendo esse tipo de análise. É preferível deixar ' +
    '"corrente" vazio a arriscar um palpite não sustentado pelo texto em mãos.\n' +
    'Correntes de referência mais comuns neste grupo (use uma delas quando fizer sentido; use outra ' +
    'apenas se o texto claramente indicar uma corrente fora desta lista): ' + CORRENTES_REFERENCIA + '.\n' +
    'Se algum campo não existir ou não puder ser determinado com segurança, deixe-o vazio.';

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      comentario: { type: 'string' }, citacao: { type: 'string' }, pagina: { type: 'string' },
      relacoes: { type: 'string' }, tema: { type: 'array', items: { type: 'string' } },
      corrente: { type: 'string' }
    },
    required: ['citacao', 'tema', 'corrente']
  };

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelo, max_tokens: 1024,
        thinking: { type: 'adaptive' },
        output_config: { effort: esforco, format: { type: 'json_schema', schema } },
        system: sistema,
        messages: [{ role: 'user', content: texto }]
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    const bloco = (data.content || []).find(b => b.type === 'text');
    let out = {}; try { out = JSON.parse(bloco ? bloco.text : '{}'); } catch (_) { out = {}; }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Audita UMA citação em busca de problemas objetivos (referência ABNT malformada/incompleta,
// página ausente, corrente/tema vazios, texto com sinais de corte/erro de transcrição).
// NUNCA aponta problemas de conteúdo/interpretação — só estrutura/formatação, porque a IA
// não tem acesso ao texto-fonte original para verificar fidelidade da transcrição.
// Devolve { tem_problema, problemas:[...], sugestoes: {campo: novoValor, ...} } — só os
// campos que a IA realmente sugere mudar aparecem em "sugestoes". Propõe, nunca aplica sozinha.
app.post('/auditar', auth, async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'Chave Anthropic não configurada no servidor.' });
  if (!rate(res)) return;
  const {
    citacao = '', referencia_abnt = '', pagina = '', corrente_critica = '',
    tema = [], comentario = '', autor_obra = '', obra = '',
    modelo = 'claude-sonnet-5', esforco = 'medium'
  } = req.body || {};
  if (!citacao) return res.status(400).json({ error: 'Citação vazia.' });

  const sistema =
    'Você revisa citações de um banco de dados acadêmico de teoria literária brasileira. ' +
    'Aponte SOMENTE problemas objetivos e estruturais: referência ABNT malformada, incompleta ' +
    'ou com sinais de erro; página ausente ou em formato inválido; corrente crítica ou tema ' +
    'vazios quando o texto da citação sugere claramente um tema óbvio; texto da citação com ' +
    'sinais visíveis de corte, corrupção ou erro de OCR/transcrição (ex.: termina no meio de uma ' +
    'palavra, tem caracteres estranhos repetidos). NÃO invente conteúdo, NÃO avalie o mérito ' +
    'teórico da citação, NÃO reescreva o texto além de correções óbvias de formatação. Se a ' +
    'referência ABNT parecer completa e plausível e não houver problema estrutural evidente, ' +
    'diga que não há problema — na dúvida, não aponte problema algum.';

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      tem_problema: { type: 'boolean' },
      problemas: { type: 'array', items: { type: 'string' } },
      sugestao_citacao: { type: 'string' },
      sugestao_referencia_abnt: { type: 'string' },
      sugestao_pagina: { type: 'string' },
      sugestao_corrente: { type: 'string' },
      sugestao_tema: { type: 'array', items: { type: 'string' } },
      sugestao_comentario: { type: 'string' }
    },
    required: ['tem_problema', 'problemas']
  };

  const contexto = JSON.stringify({
    citacao, referencia_abnt, pagina, corrente_critica, tema, comentario, autor_obra, obra
  }, null, 2);

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelo, max_tokens: 1024,
        thinking: { type: 'adaptive' },
        output_config: { effort: esforco, format: { type: 'json_schema', schema } },
        system: sistema,
        messages: [{ role: 'user', content: 'Revise esta citação:\n' + contexto }]
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    const bloco = (data.content || []).find(b => b.type === 'text');
    let out = {}; try { out = JSON.parse(bloco ? bloco.text : '{}'); } catch (_) { out = {}; }

    // Monta "sugestoes" só com os campos que a IA de fato preencheu (não vazios) —
    // o cliente só oferece para edição/aceite o que veio com conteúdo real.
    const sugestoes = {};
    if (out.sugestao_citacao) sugestoes.citacao = out.sugestao_citacao;
    if (out.sugestao_referencia_abnt) sugestoes.referencia_abnt = out.sugestao_referencia_abnt;
    if (out.sugestao_pagina) sugestoes.pagina = out.sugestao_pagina;
    if (out.sugestao_corrente) sugestoes.corrente_critica = out.sugestao_corrente;
    if (out.sugestao_tema && out.sugestao_tema.length) sugestoes.tema = out.sugestao_tema;
    if (out.sugestao_comentario) sugestoes.comentario = out.sugestao_comentario;

    res.json({ tem_problema: !!out.tem_problema, problemas: out.problemas || [], sugestoes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lista de modelos atuais da Anthropic (para o seletor) — ao vivo, com fallback
app.get('/modelos', auth, async (req, res) => {
  const rotulos = {
    'claude-haiku-4-5': 'Haiku 4.5 (rápido, econômico)',
    'claude-sonnet-5':  'Sonnet 5 (equilíbrio — padrão)',
    'claude-opus-4-8':  'Opus 4.8 (máxima precisão)'
  };
  const ordem = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8'];
  const fallback = () => ordem.map(id => ({ id, nome: rotulos[id] }));
  if (!KEY) return res.json({ modelos: fallback() });
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }
    });
    const data = await r.json();
    let modelos = (data.data || [])
      .filter(m => /haiku|sonnet|opus|fable/.test(m.id))
      .map(m => ({ id: m.id, nome: rotulos[m.id] || m.display_name || m.id }));
    if (!modelos.length) return res.json({ modelos: fallback() });
    modelos.sort((a, b) => {
      const ia = ordem.indexOf(a.id), ib = ordem.indexOf(b.id);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.id.localeCompare(b.id);
    });
    res.json({ modelos });
  } catch (_) {
    res.json({ modelos: fallback() });
  }
});

// Slug simples para nome de documento (correntes viram nomes de doc na subcoleção)
function _slug(s) {
  return String(s || 'sem-corrente')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sem-corrente';
}

// Backup diário automático, organizado por corrente crítica (evita limite de 1MB/doc
// guardando cada corrente numa subcoleção). Disparado por um cron externo grátis
// (ex.: cron-job.org) — protegido por senha própria (BACKUP_SECRET), não pelo login,
// porque quem chama não é um navegador logado.
async function _gerarBackup() {
  const db = _getDbBackup();
  if (!db) throw new Error('Backup não configurado (falta FIREBASE_SERVICE_ACCOUNT_JSON).');

  const [soltas, livro, critica, autores] = await Promise.all([
    db.collection('citacoes').get(),
    db.collection('citacoes_livro').get(),
    db.collection('critica_literaria').get(),
    db.collection('catalogo_autores').get()
  ]);
  const todas = [
    ...soltas.docs.map(d => ({ tipo: 'solta', id: d.id, ...d.data() })),
    ...livro.docs.map(d => ({ tipo: 'livro', id: d.id, ...d.data() }))
  ];
  // Coleções que não são citações: guardadas inteiras, sem agrupamento por corrente.
  const outras = {
    critica_literaria: critica.docs.map(d => ({ id: d.id, ...d.data() })),
    catalogo_autores:  autores.docs.map(d => ({ id: d.id, ...d.data() }))
  };

  // Comentários pessoais (citacoes/{id}/privado/{uid}). Entram no backup para não se
  // perderem, mas agrupados por dono e gravados numa subcoleção que NINGUÉM lê pelo site
  // (rule `read: if false`) — nem o coordenador. Se a consulta falhar, o backup do resto
  // continua: perder o backup inteiro por causa disso seria pior.
  const privadosPorDono = {};
  try {
    const priv = await db.collectionGroup('privado').get();
    priv.docs.forEach(d => {
      const citacaoId = d.ref.parent.parent ? d.ref.parent.parent.id : null;
      if (!citacaoId) return;
      const uid = d.id;
      (privadosPorDono[uid] = privadosPorDono[uid] || []).push({ citacaoId, ...d.data() });
    });
  } catch (e) {
    console.error('Não foi possível ler os comentários pessoais:', e.message);
  }

  const porCorrente = {};   // corrente -> array de citações
  const contagemTema = {};  // tema -> contagem
  todas.forEach(c => {
    const corrente = c.corrente_critica || 'Sem corrente';
    (porCorrente[corrente] = porCorrente[corrente] || []).push(c);
    (c.tema || []).forEach(t => { if (t) contagemTema[t] = (contagemTema[t] || 0) + 1; });
  });

  const data = new Date().toISOString().slice(0, 10);
  const docRef = db.collection('backups').doc(data);
  await docRef.set({
    gerado_em: admin.firestore.FieldValue.serverTimestamp(),
    total: todas.length,
    correntes: Object.keys(porCorrente).sort(),
    contagem_por_corrente: Object.fromEntries(Object.entries(porCorrente).map(([k, v]) => [k, v.length])),
    contagem_por_tema: contagemTema,
    contagem_outras: Object.fromEntries(Object.entries(outras).map(([k, v]) => [k, v.length]))
  });
  await Promise.all(Object.entries(porCorrente).map(([corrente, itens]) =>
    docRef.collection('por_corrente').doc(_slug(corrente)).set({ corrente, citacoes: itens })
  ));
  await Promise.all(Object.entries(outras).map(([colecao, itens]) =>
    docRef.collection('outras_colecoes').doc(colecao).set({ colecao, itens })
  ));
  await Promise.all(Object.entries(privadosPorDono).map(([uid, itens]) =>
    docRef.collection('comentarios_privados').doc(uid).set({ uid, itens })
  ));

  // Mantém só os últimos 90 backups (evita crescimento indefinido no plano free do Firestore)
  const antigos = await db.collection('backups').orderBy('gerado_em', 'desc').offset(90).limit(30).get();
  await Promise.all(antigos.docs.map(async d => {
    // Apagar TODAS as subcoleções — no Firestore, apagar o documento pai não apaga as filhas;
    // esquecer alguma aqui deixaria lixo órfão acumulando para sempre.
    for (const sub of ['por_corrente', 'outras_colecoes', 'comentarios_privados']) {
      const subs = await d.ref.collection(sub).get();
      await Promise.all(subs.docs.map(s => s.ref.delete()));
    }
    await d.ref.delete();
  }));

  // Espelho legível na planilha — se falhar, o backup real (acima) continua válido.
  const planilha = await _exportarParaSheets({
    citacoes: todas,
    critica: outras.critica_literaria,
    autores: outras.catalogo_autores
  });

  return {
    ok: true, data, total: todas.length, correntes: Object.keys(porCorrente).length,
    outras: Object.fromEntries(Object.entries(outras).map(([k, v]) => [k, v.length])),
    planilha
  };
}

app.post('/backup-diario', async (req, res) => {
  const secret = req.headers['x-backup-secret'];
  if (!process.env.BACKUP_SECRET || secret !== process.env.BACKUP_SECRET) {
    return res.status(403).json({ error: 'Não autorizado.' });
  }
  try {
    res.json(await _gerarBackup());
  } catch (e) {
    console.error('Erro backup-diario:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Mesmo backup, disparado pelo site (coordenador logado) em vez do cron —
// é o que faz o botão "Exportar backup agora" também atualizar a planilha.
app.post('/backup-agora', auth, async (req, res) => {
  try {
    res.json(await _gerarBackup());
  } catch (e) {
    console.error('Erro backup-agora:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* Migração única: comentários que hoje estão DENTRO de `citacoes/{id}` passam para
 * `citacoes/{id}/privado/{uid}` (só o autor lê) e o campo some do documento público.
 *
 * Precisa rodar no servidor: pela regra do Firestore, ninguém pode escrever no espaço
 * privado de outra pessoa — nem o coordenador. O Admin SDK ignora rules, então é o único
 * caminho para migrar o comentário de cada pesquisador para o lugar certo, sem lê-lo aqui.
 *
 * Idempotente: rodar duas vezes não duplica nem apaga nada (na 2ª vez não há mais campo).
 * `?simular=1` faz uma passagem seca, sem gravar — serve para conferir antes.
 * A citação guarda o NOME do pesquisador, não o uid, então casamos pelo nome em `usuarios`;
 * quem não casar é reportado e fica INTACTO (nunca descartamos comentário sem dono). */
app.post('/migrar-comentarios', auth, async (req, res) => {
  const db = _getDbBackup();
  if (!db) return res.status(500).json({ error: 'Falta FIREBASE_SERVICE_ACCOUNT_JSON no servidor.' });
  const simular = req.query.simular === '1';

  try {
    const [usuarios, citacoes] = await Promise.all([
      db.collection('usuarios').get(),
      db.collection('citacoes').get()
    ]);

    const uidPorNome = new Map();
    usuarios.docs.forEach(u => {
      const nome = (u.data().nome || '').trim();
      if (nome) uidPorNome.set(nome.toLowerCase(), u.id);
    });

    let migrados = 0, semComentario = 0;
    const semDono = [];
    for (const doc of citacoes.docs) {
      const d = doc.data();
      const comentario = (d.comentario || '').trim();
      if (!comentario) { semComentario++; continue; }

      const uid = uidPorNome.get((d.pesquisador || '').trim().toLowerCase());
      if (!uid) { semDono.push({ id: doc.id, pesquisador: d.pesquisador || '(sem nome)' }); continue; }

      if (!simular) {
        await doc.ref.collection('privado').doc(uid).set({
          comentario, uid,
          atualizado_em: admin.firestore.FieldValue.serverTimestamp(),
          migrado_de: 'campo comentario da citação'
        });
        await doc.ref.update({ comentario: admin.firestore.FieldValue.delete() });
      }
      migrados++;
    }

    res.json({
      ok: true, simulacao: simular,
      total_citacoes: citacoes.size,
      migrados, sem_comentario: semComentario,
      sem_dono_identificado: semDono.length,
      // Só id e nome do pesquisador — o texto do comentário não é devolvido, de propósito.
      detalhe_sem_dono: semDono.slice(0, 20)
    });
  } catch (e) {
    console.error('Erro migrar-comentarios:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* Repõe comentários pessoais a partir de `backups/{data}/comentarios_privados/{uid}`.
 *
 * Roda no servidor por dois motivos: (1) aquela subcoleção tem rule `read: if false` —
 * nem o coordenador lê pelo site; (2) ninguém pode escrever no espaço privado de outra
 * pessoa. O Admin SDK move o texto de um lado para o outro **sem devolvê-lo na resposta**:
 * o coordenador consegue recuperar o comentário de um pesquisador sem jamais lê-lo.
 *
 * Aditivo por padrão: repõe só o que está faltando. `sobrescrever: true` troca o atual pelo
 * do backup (descarta o que a pessoa escreveu depois). `?simular=1` não grava nada. */
app.post('/restaurar-privados', auth, async (req, res) => {
  const db = _getDbBackup();
  if (!db) return res.status(500).json({ error: 'Falta FIREBASE_SERVICE_ACCOUNT_JSON no servidor.' });
  const { data = '', email = '', sobrescrever = false } = req.body || {};
  const simular = req.query.simular === '1';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return res.status(400).json({ error: 'Informe a data do backup no formato AAAA-MM-DD.' });
  }

  try {
    // Opcional: restaurar de uma pessoa só. Recebe e-mail (que o coordenador conhece)
    // e converte para uid internamente.
    let uidAlvo = null;
    if (email) {
      const u = await db.collection('usuarios').where('email', '==', String(email).trim().toLowerCase()).limit(1).get();
      if (u.empty) return res.status(404).json({ error: 'Nenhum usuário cadastrado com esse e-mail.' });
      uidAlvo = u.docs[0].id;
    }

    const snap = await db.collection('backups').doc(data).collection('comentarios_privados').get();
    if (snap.empty) {
      return res.json({ ok: true, simulacao: simular, aviso: 'Este backup não guardou comentários pessoais (provavelmente é anterior a essa mudança).', restaurados: 0 });
    }

    let restaurados = 0, jaExistiam = 0, citacaoSumiu = 0, pessoas = 0;
    for (const doc of snap.docs) {
      const uid = doc.id;
      if (uidAlvo && uid !== uidAlvo) continue;
      pessoas++;
      const itens = (doc.data() || {}).itens || [];
      for (const it of itens) {
        const citacaoId = it && it.citacaoId;
        const comentario = ((it && it.comentario) || '').trim();
        if (!citacaoId || !comentario) continue;

        const citRef = db.collection('citacoes').doc(citacaoId);
        const cit = await citRef.get();
        // Comentário órfão: a citação em si não existe mais. Restaure a citação primeiro
        // (pelo painel do site) e rode isto de novo.
        if (!cit.exists) { citacaoSumiu++; continue; }

        const alvo = citRef.collection('privado').doc(uid);
        if (!sobrescrever && (await alvo.get()).exists) { jaExistiam++; continue; }
        if (!simular) {
          await alvo.set({
            comentario, uid,
            atualizado_em: admin.firestore.FieldValue.serverTimestamp(),
            restaurado_de: data
          });
        }
        restaurados++;
      }
    }

    // Só números — o texto dos comentários nunca sai daqui.
    res.json({ ok: true, simulacao: simular, sobrescrever: !!sobrescrever, pessoas, restaurados, ja_existiam: jaExistiam, citacao_inexistente: citacaoSumiu });
  } catch (e) {
    console.error('Erro restaurar-privados:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// E-mail da conta de serviço — é com ele que a planilha precisa ser compartilhada.
// Não é segredo (é um endereço), mas exige login para não expor a configuração à toa.
app.get('/conta-servico', auth, (_req, res) => {
  const cred = _credenciaisServico();
  if (!cred) return res.status(500).json({ error: 'Credencial de serviço não configurada no servidor.' });
  res.json({
    email: cred.client_email,
    planilha_configurada: !!_sheetId(),
    sheet_id: _sheetId() || null
  });
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 3000, () => console.log('Proxy de citações rodando'));
