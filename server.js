'use strict';
/* ============================================================================
 * Proxy da IA de citações — para o site "Grupo de Estudos em Teoria Literária".
 * Roda de graça no Render. A chave da Anthropic fica AQUI (variável de ambiente),
 * nunca no navegador. Só o coordenador (felipevigneron@gmail.com) pode chamar —
 * validado pelo token de login do Firebase.
 *
 * Variáveis de ambiente no Render:
 *   ANTHROPIC_API_KEY   = sk-ant-...        (obrigatória p/ IA via Claude)
 *   GEMINI_API_KEY      = ...               (opcional — só p/ usar modelos gemini-*;
 *                          gerada em aistudio.google.com/apikey. Sem ela, tudo continua
 *                          igual, só Claude. Teste depois de configurar: GET /gemini-teste)
 *   ALLOWED_ORIGIN      = https://grupo-de-pesquisa-9e35f.web.app (padrão já aponta p/ ela)
 *   FIREBASE_PROJECT_ID = grupo-de-pesquisa-9e35f                 (padrão já correto)
 *   FIREBASE_SERVICE_ACCOUNT_JSON = { ... } (obrigatória p/ backup diário — ver COMO-ATIVAR.md)
 *   BACKUP_SECRET       = uma senha longa qualquer, só sua (protege o gatilho do backup)
 * ==========================================================================*/

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
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

// Alguns campos guardam marcação HTML (ex.: fontes com <em>Título</em>), que o site
// renderiza mas a planilha mostraria literalmente. Aqui é ESPELHO DE LEITURA, então o
// texto sai limpo. O JSON de backup continua com a marcação intacta — lá é fidelidade
// para restaurar, e é ele que devolve os dados ao site.
function _semHtml(v) {
  return String(v ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

/* Neutraliza injeção de fórmula na planilha.
 *
 * Precisão sobre o risco, porque muda o que precisa ser feito: a escrita aqui usa
 * `valueInputOption: 'RAW'`, e RAW guarda o texto como texto — o Google Sheets NÃO
 * interpreta `=IMPORTDATA(...)` como fórmula por esse caminho. O buraco não é a planilha
 * em si: é o dia em que alguém EXPORTA essa planilha para .csv/.xlsx e abre no Excel ou
 * no LibreOffice, que interpretam a célula na abertura. Aí a fórmula roda na máquina de
 * quem abriu, com os privilégios daquela pessoa.
 *
 * O prefixo com apóstrofo custa três linhas e fecha esse caminho na origem, para qualquer
 * programa que venha a ler a planilha depois. O apóstrofo não aparece na célula. */
function _sanitizarCelula(v) {
  const s = String(v ?? '');
  return /^[=+\-@|\t\r]/.test(s) ? "'" + s : s;
}

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
    c.tipo || '', c.id || '', _semHtml(c.citacao), _semHtml(c.pagina), _semHtml(c.autor_obra),
    _semHtml(c.obra), _semHtml(c.corrente_critica), (c.tema || []).map(_semHtml).join('; '),
    _semHtml(c.comentario), _semHtml(c.referencia_abnt), _semHtml(c.pesquisador),
    _dataLegivel(c.data_insercao), c.atualizado_por || '', _dataLegivel(c.atualizado_em)
  ]);

  // Crítica Literária guarda `conceitos` como lista de objetos aninhados; a planilha é plana,
  // então cada conceito vira uma linha, repetindo corrente/período. Correntes sem nenhum
  // conceito ainda aparecem (uma linha), para não sumirem do espelho.
  const linhasCritica = [];
  critica.forEach(c => {
    const conceitos = Array.isArray(c.conceitos) && c.conceitos.length ? c.conceitos : [null];
    conceitos.forEach(k => linhasCritica.push([
      c.id || '', _semHtml(c.corrente), _semHtml(c.periodo), c.ordem ?? '',
      k ? _semHtml(k.conceito) : '', k ? _semHtml(k.definicao) : '',
      k ? _semHtml(k.exemplo) : '', k ? _semHtml(k.fonte) : '',
      c.atualizadoPor || '', _dataLegivel(c.atualizadoEm)
    ]));
  });

  // `correntes` é uma lista (um autor pode transitar por várias) — vira texto separado por ";"
  const linhasAutores = autores.map(a => [
    a.id || '', _semHtml(a.autor),
    Array.isArray(a.correntes) ? a.correntes.map(_semHtml).join('; ') : _semHtml(a.correntes),
    _semHtml(a.contribuicoes)
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
      const valores = [
        [`Atualizado em ${agora} UTC — ${b.linhas.length} ${b.rotulo}`],
        b.cabecalho,
        ...b.linhas
      ];
      await sheets.spreadsheets.values.update({
        spreadsheetId, range: `${faixa}!A1`, valueInputOption: 'RAW',
        requestBody: {
          // Sanitiza AQUI, no ponto único de escrita, em vez de campo a campo lá em cima:
          // as três abas passam por este mesmo lugar, então nenhuma coluna nova criada
          // depois pode escapar por esquecimento.
          values: valores.map(linha => linha.map(_sanitizarCelula))
        }
      });
      // Só AGORA apaga o que sobrou embaixo (resto de uma exportação maior). A ordem
      // importa: limpando antes, uma falha de rede no meio deixava a aba VAZIA até o
      // próximo backup dar certo. Escrevendo primeiro, uma falha preserva o conteúdo
      // anterior — pior caso vira "dados desatualizados", não "dados sumiram".
      await sheets.spreadsheets.values.clear({
        spreadsheetId, range: `${faixa}!A${valores.length + 1}:Z100000`
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
// Gemini é OPCIONAL: sem GEMINI_API_KEY no ambiente, tudo continua funcionando exatamente
// como antes (só Claude) — só falha, com mensagem clara, se alguém pedir um modelo gemini-*.
const GEMINI_KEY = process.env.GEMINI_API_KEY;
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

// Só modelos conhecidos podem ser pedidos. O cliente manda o `modelo` escolhido no seletor,
// e um valor arbitrário vindo dali chegaria direto à Anthropic/Gemini — restringir evita
// chamar (e pagar por) um modelo não previsto caso o campo seja adulterado.
const MODELOS_PERMITIDOS = new Set([
  'claude-haiku-4-5', 'claude-sonnet-5', 'claude-sonnet-4-6',
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-fable-5'
]);
const ESFORCOS_PERMITIDOS = new Set(['low', 'medium', 'high']);
// Síncrono, só para Claude — a allowlist fixa é segura porque nunca foi errada até hoje.
function modeloValido(m) { return MODELOS_PERMITIDOS.has(m) ? m : 'claude-sonnet-5'; }
function esforcoValido(e) { return ESFORCOS_PERMITIDOS.has(e) ? e : 'medium'; }
// "gemini-..." vai para a API do Google; qualquer outra coisa (todo o resto da allowlist)
// continua indo para a Anthropic, como sempre.
function _provedorDoModelo(m) { return typeof m === 'string' && m.startsWith('gemini') ? 'gemini' : 'claude'; }
function _chaveFaltando(m) {
  if (_provedorDoModelo(m) === 'gemini') return GEMINI_KEY ? null : 'Chave Gemini não configurada no servidor.';
  return KEY ? null : 'Chave Anthropic não configurada no servidor.';
}

// NADA de lista fixa de modelos Gemini: em 2026-07-30, os dois IDs que eu tinha escrito à
// mão (gemini-2.0-flash, gemini-2.5-flash) vieram um com cota zerada e outro "não disponível
// para novos usuários" — a Google aposenta modelo mais rápido do que dá para acompanhar à
// mão. A allowlist agora é a resposta AO VIVO da própria Models API do Google, para a CHAVE
// REAL configurada: só aparece (e só é aceito) o que a Google confirma, agora, que existe e
// que esta chave pode usar. Isso é o "sem mentir" que foi pedido — nunca um nome inventado.
let _geminiModelosCache = null, _geminiModelosCacheEm = 0;
const _GEMINI_CACHE_TTL = 6 * 3600 * 1000; // 6h, mesmo padrão já usado no SuperApp p/ Claude
// A mesma chave do Gemini dá acesso a TODA a linha de produtos de IA do Google, não só a
// modelos de texto: "Nano Banana" (geração de IMAGEM), "Lyria" (MÚSICA), "Robotics-ER"
// (controle de robô), "Deep Research"/"Antigravity Agent" (agentes autônomos complexos),
// "Gemma" (família de modelo DIFERENTE do Gemini). Todos suportam generateContent segundo a
// Models API, mas nenhum serve para classificar citação em JSON — confirmado em 2026-07-30,
// quando essa lista "crua" veio com esses produtos misturados aos modelos de texto de
// verdade. Filtro por nome, não só por capacidade: exclusão explícita das famílias que não
// servem para este uso, e exige que o nome contenha "gemini" (defesa dupla).
const _GEMINI_EXCLUIR = /\b(tts|gemma|nano\s*banana|omni|lyria|robotics|computer\s*use|deep\s*research|antigravity)\b/i;
async function _listarModelosGemini() {
  if (!GEMINI_KEY) return [];
  const agora = Date.now();
  if (_geminiModelosCache && agora - _geminiModelosCacheEm < _GEMINI_CACHE_TTL) return _geminiModelosCache;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${GEMINI_KEY}`);
    const data = await r.json();
    if (!r.ok) { console.warn('[gemini] falha ao listar modelos:', data && data.error && data.error.message); return _geminiModelosCache || []; }
    const modelos = (data.models || [])
      .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .filter(m => /gemini/i.test(m.displayName || m.name || '') && !_GEMINI_EXCLUIR.test(m.displayName || m.name || ''))
      .map(m => ({
        id: String(m.name || '').replace(/^models\//, ''),
        nome: (m.displayName || String(m.name || '').replace(/^models\//, '')) + ' (Google)'
      }))
      .filter(m => m.id);
    _geminiModelosCache = modelos; _geminiModelosCacheEm = agora;
    return modelos;
  } catch (e) {
    console.warn('[gemini] erro ao listar modelos:', e.message);
    return _geminiModelosCache || [];
  }
}
// Versão ASSÍNCRONA de modeloValido, usada nas rotas de IA: Claude continua na allowlist
// fixa (rápida, síncrona); um pedido de modelo gemini-* só é aceito se aparecer NA LISTA AO
// VIVO acima — ou seja, se a própria Google confirma, agora, que esta chave pode usá-lo.
async function _modeloValidoAsync(m) {
  if (MODELOS_PERMITIDOS.has(m)) return m;
  if (_provedorDoModelo(m) === 'gemini') {
    const lista = await _listarModelosGemini();
    if (lista.some(x => x.id === m)) return m;
  }
  return 'claude-sonnet-5';
}

// Comparação de segredo em tempo constante: com `!==`, o tempo de resposta varia conforme
// quantos caracteres iniciais batem, o que em tese permite descobrir o segredo por tentativa
// e medição. `timingSafeEqual` sempre leva o mesmo tempo.
function segredoConfere(recebido, esperado) {
  if (!esperado || typeof recebido !== 'string') return false;
  const a = Buffer.from(recebido), b = Buffer.from(esperado);
  if (a.length !== b.length) return false; // timingSafeEqual exige mesmo tamanho
  return crypto.timingSafeEqual(a, b);
}

// Instruções de tema/corrente — as MESMAS para chamada única e em lote, para que agrupar
// não mude o critério de classificação (economia de token não pode custar qualidade).
const CORRENTES_REFERENCIA = [
  'Formalismo Russo', 'Estruturalismo', 'New Criticism (Nova Crítica)',
  'Crítica Marxista / Sociológica', 'Crítica Psicanalítica', 'Pós-estruturalismo / Desconstrução',
  'Estética da Recepção', 'Hermenêutica e Fenomenologia', 'Narratologia', 'Estudos Culturais',
  'Estudos Pós-coloniais', 'Crítica Feminista e Teoria Queer', 'Teoria Crítica (Escola de Frankfurt)',
  'Semiótica', 'Crítica Literária Brasileira'
].join(', ');

const REGRA_TEMA_CORRENTE =
  'Para "tema" e "corrente": baseie-se ESTRITAMENTE no que o texto da citação e do comentário ' +
  'efetivamente argumentam — nunca na reputação geral do autor da obra ou em associações que você ' +
  'conheça sobre ele por outras fontes. Um autor pode escrever a partir de correntes diferentes ao ' +
  'longo da carreira, ou até citar/comentar uma corrente sem praticá-la; um crítico famoso por uma ' +
  'escola pode, num trecho específico, não estar fazendo esse tipo de análise. É preferível deixar ' +
  '"corrente" vazio a arriscar um palpite não sustentado pelo texto em mãos.\n' +
  'Correntes de referência mais comuns neste grupo (use uma delas quando fizer sentido; use outra ' +
  'apenas se o texto claramente indicar uma corrente fora desta lista): ' + CORRENTES_REFERENCIA + '.\n\n' +
  'SOBRE OS TEMAS — o objetivo é AGRUPAR citações, não descrever cada uma:\n' +
  '- Prefira SEMPRE reaproveitar um tema já existente na lista de temas em uso (enviada abaixo, ' +
  'quando houver) a criar um novo. Reutilizar é o comportamento desejado, inclusive repetindo o ' +
  'mesmo tema em muitas citações: é assim que elas se agrupam e ficam encontráveis pelo filtro.\n' +
  '- Seja SINTÉTICO: 1 a 3 temas por citação, curtos e amplos o bastante para servir a várias ' +
  'citações diferentes. Um tema que só se aplica a uma citação não serve para agrupar nada.\n' +
  '- Evite variações do mesmo conceito (singular/plural, sinônimos, versões mais longas do mesmo ' +
  'termo). Se um tema em uso já cobre a ideia, use exatamente ele, com a mesma grafia.\n' +
  '- Só invente um tema novo quando nenhum dos existentes servir — e, nesse caso, escolha um termo ' +
  'genérico o bastante para que futuras citações também possam usá-lo.\n' +
  'Se algum campo não existir ou não puder ser determinado com segurança, deixe-o vazio.';

// Monta o bloco com os temas já em uso, para a IA reaproveitar em vez de inventar.
// Limitado aos mais frequentes: a lista inteira cresceria sem limite e encareceria cada
// chamada — e são justamente os mais usados que devem servir de vocabulário comum.
function _blocoTemasEmUso(temas) {
  if (!Array.isArray(temas) || !temas.length) return '';
  const limpos = [...new Set(temas.map(t => String(t || '').trim()).filter(Boolean))].slice(0, 60);
  if (!limpos.length) return '';
  return '\n\nTEMAS JÁ EM USO NESTE GRUPO (reaproveite estes sempre que couber, com a grafia exata):\n' +
    limpos.join(' · ');
}

/* Categoriza VÁRIAS citações numa única chamada.
 *
 * Motivo (economia real, medida): o prompt de sistema tem ~170 tokens e era reenviado uma vez
 * POR CITAÇÃO. Com 9 citações, isso é o mesmo texto mandado 9 vezes. Aqui vai uma vez só, e as
 * citações entram numeradas na mensagem — o custo por citação cai para o próprio texto dela.
 * Ganho maior ainda: consome 1 unidade do limite de 60/hora em vez de N, que era o gargalo real
 * ao categorizar muitas citações de uma vez.
 *
 * A qualidade é preservada porque as instruções são idênticas às da chamada única e cada citação
 * é avaliada individualmente dentro do lote — o schema obriga a devolver o `indice` de cada uma,
 * e o cliente confere se voltou tudo (sem casar por posição, que sairia errado se faltar item).
 */

// Chama o provedor certo (Claude ou Gemini) conforme o modelo pedido — usada pelas 3 rotas
// de IA (categorizar, categorizar-lote, auditar), para não duplicar (e arriscar divergir) a
// integração em cada uma. Contrato único de retorno:
//   { ok, status, texto, uso, corpoErro }
// `texto` é a string JSON bruta que a rota chamadora ainda faz JSON.parse; `uso` é
// {input_tokens, output_tokens} nos dois provedores, para o cliente ler igual não importa
// qual respondeu. Em falha, `corpoErro` já vem pronto para `res.status(r.status).json(...)`.
//
// O ramo Claude reproduz EXATAMENTE o request/response que cada rota já fazia sozinha antes
// deste helper existir — zero mudança de comportamento para quem já usa Claude.
async function _chamarModelo({ modelo, esforco, sistema, mensagem, schema, maxTokens }) {
  if (_provedorDoModelo(modelo) === 'gemini') {
    // Formato conferido em 2026-07-30 na doc oficial (ai.google.dev/api/generate-content):
    // generationConfig em camelCase, schema em JSON Schema padrão (minúsculo) — mais simples
    // que a geração anterior da API do Gemini, que exigia OBJECT/STRING em maiúsculas.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent?key=${GEMINI_KEY}`;
    let r, data;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: mensagem }] }],
          systemInstruction: { parts: [{ text: sistema }] },
          // Gemini não tem um parâmetro de "esforço" equivalente ao da Anthropic — não há
          // o que mapear ainda; fica documentado aqui para quando/se a API expuser isso.
          generationConfig: { responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: maxTokens }
        })
      });
      data = await r.json();
    } catch (e) {
      return { ok: false, status: 502, texto: '', uso: null, corpoErro: { error: 'Falha ao contactar a API do Gemini: ' + e.message } };
    }
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || JSON.stringify(data);
      return { ok: false, status: r.status, texto: '', uso: null, corpoErro: { error: msg } };
    }
    const texto = (data && data.candidates && data.candidates[0] && data.candidates[0].content
                   && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
                   && data.candidates[0].content.parts[0].text) || '';
    const uso = data.usageMetadata
      ? { input_tokens: data.usageMetadata.promptTokenCount, output_tokens: data.usageMetadata.candidatesTokenCount }
      : null;
    return { ok: true, status: 200, texto, uso, corpoErro: null };
  }

  // Claude — igual ao que cada rota fazia antes.
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelo, max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort: esforco, format: { type: 'json_schema', schema } },
      system: sistema,
      messages: [{ role: 'user', content: mensagem }]
    })
  });
  const data = await r.json();
  if (!r.ok) return { ok: false, status: r.status, texto: '', uso: null, corpoErro: data };
  const bloco = (data.content || []).find(b => b.type === 'text');
  return { ok: true, status: 200, texto: bloco ? bloco.text : '{}', uso: data.usage || null, corpoErro: null };
}

app.post('/categorizar-lote', auth, async (req, res) => {
  const modelo = await _modeloValidoAsync((req.body || {}).modelo);
  const esforco = esforcoValido((req.body || {}).esforco);
  const faltaChave = _chaveFaltando(modelo);
  if (faltaChave) return res.status(500).json({ error: faltaChave });
  if (!rate(res)) return;
  const { textos = [], temas_em_uso = [] } = req.body || {};

  if (!Array.isArray(textos) || !textos.length) return res.status(400).json({ error: 'Envie "textos" como lista não vazia.' });
  if (textos.length > 25) return res.status(400).json({ error: 'Máximo de 25 citações por lote.' });
  const limpos = textos.map(t => String(t || '').trim()).filter(Boolean);
  if (!limpos.length) return res.status(400).json({ error: 'Todos os textos vieram vazios.' });
  const total = limpos.reduce((s, t) => s + t.length, 0);
  if (total > 60000) return res.status(400).json({ error: 'Lote grande demais; divida em partes menores.' });

  const sistema =
    'Você é assistente de um grupo de pesquisa em Teoria Literária brasileira. ' +
    'Recebe VÁRIAS citações numeradas e classifica CADA UMA independentemente das outras — ' +
    'não deixe a classificação de uma influenciar a das demais.\n\n' + REGRA_TEMA_CORRENTE +
    _blocoTemasEmUso(temas_em_uso) + '\n' +
    'Devolva exatamente um resultado por citação recebida, repetindo o número (indice) de cada uma.';

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      resultados: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            indice: { type: 'integer' },
            tema: { type: 'array', items: { type: 'string' } },
            corrente: { type: 'string' }
          },
          required: ['indice', 'tema', 'corrente']
        }
      }
    },
    required: ['resultados']
  };

  const conteudo = limpos.map((t, i) => `[${i}] ${t}`).join('\n\n---\n\n');

  try {
    // O orçamento precisa caber RESPOSTA + RACIOCÍNIO: com `thinking` ligado (Claude), os
    // tokens de raciocínio saem deste mesmo teto. Com 150/citação, um lote de 20 no esforço
    // alto raspava o limite e a resposta voltava cortada — o que aparecia como "algumas
    // citações não foram preenchidas", sem erro visível. Folga generosa é barata aqui:
    // max_tokens é teto, não consumo — não se paga o que não for gerado.
    const r = await _chamarModelo({
      modelo, esforco, sistema, schema,
      mensagem: 'Classifique cada citação:\n\n' + conteudo,
      maxTokens: Math.min(1200 + limpos.length * 260, 16000)
    });
    if (!r.ok) return res.status(r.status).json(r.corpoErro);
    let out = {}; try { out = JSON.parse(r.texto || '{}'); } catch (_) { out = {}; }

    // Devolve indexado por posição, preenchendo com vazio o que não voltou — assim o cliente
    // nunca associa a resposta de uma citação a outra por engano.
    const porIndice = new Map((out.resultados || []).map(x => [x.indice, x]));
    const resultados = limpos.map((_, i) => {
      const achado = porIndice.get(i);
      return achado ? { tema: achado.tema || [], corrente: achado.corrente || '' } : null;
    });
    res.json({ resultados, uso: r.uso });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Categorizar / reconhecer uma citação → { comentario, citacao, pagina, relacoes, tema[], corrente }
app.post('/categorizar', auth, async (req, res) => {
  const modelo = await _modeloValidoAsync((req.body || {}).modelo);
  const esforco = esforcoValido((req.body || {}).esforco);
  const faltaChave = _chaveFaltando(modelo);
  if (faltaChave) return res.status(500).json({ error: faltaChave });
  if (!rate(res)) return;
  const {
    texto = '', temas_em_uso = [],
    formato = 'Comentário - "citação" (página X) - outros comentários ou relações'
  } = req.body || {};
  if (!texto || texto.length > 8000) return res.status(400).json({ error: 'Texto inválido.' });

  // Mesmas regras de tema/corrente do endpoint em lote (constante compartilhada acima):
  // se divergissem, a classificação mudaria conforme o caminho usado.
  const sistema =
    'Você é assistente de um grupo de pesquisa em Teoria Literária brasileira. ' +
    'Recebe uma anotação em texto livre que segue, aproximadamente, o padrão:\n  ' + formato + '\n' +
    'Separe os campos com fidelidade ao texto original (não invente conteúdo).\n\n' + REGRA_TEMA_CORRENTE +
    _blocoTemasEmUso(temas_em_uso);

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
    const r = await _chamarModelo({ modelo, esforco, sistema, schema, mensagem: texto, maxTokens: 1024 });
    if (!r.ok) return res.status(r.status).json(r.corpoErro);
    let out = {}; try { out = JSON.parse(r.texto || '{}'); } catch (_) { out = {}; }
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
  const modelo = await _modeloValidoAsync((req.body || {}).modelo);
  const esforco = esforcoValido((req.body || {}).esforco);
  const faltaChave = _chaveFaltando(modelo);
  if (faltaChave) return res.status(500).json({ error: faltaChave });
  if (!rate(res)) return;
  const {
    citacao = '', referencia_abnt = '', pagina = '', corrente_critica = '',
    tema = [], comentario = '', autor_obra = '', obra = ''
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
    const r = await _chamarModelo({
      modelo, esforco, sistema, schema,
      mensagem: 'Revise esta citação:\n' + contexto, maxTokens: 1024
    });
    if (!r.ok) return res.status(r.status).json(r.corpoErro);
    let out = {}; try { out = JSON.parse(r.texto || '{}'); } catch (_) { out = {}; }

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
// Gemini não tem uma Models API equivalente sendo consultada aqui (lista fixa, só os IDs em
// MODELOS_PERMITIDOS) — e só aparece no seletor se a chave estiver configurada no ambiente,
// para não oferecer no cliente uma opção que sabidamente vai falhar por falta de chave.
app.get('/modelos', auth, async (req, res) => {
  const rotulos = {
    'claude-haiku-4-5': 'Haiku 4.5 (rápido, econômico)',
    'claude-sonnet-5':  'Sonnet 5 (equilíbrio — padrão)',
    'claude-opus-4-8':  'Opus 4.8 (máxima precisão)'
  };
  const ordem = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8'];
  const gemini = await _listarModelosGemini(); // ao vivo — o que a chave REAL pode usar agora
  const fallback = () => ordem.map(id => ({ id, nome: rotulos[id] })).concat(gemini);
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
    res.json({ modelos: modelos.concat(gemini) });
  } catch (_) {
    res.json({ modelos: fallback() });
  }
});

// Smoke test da integração com o Gemini. "Aparecer na lista ao vivo" (Models API) NÃO
// significa "pode ser chamado de verdade" — em 2026-07-30, gemini-2.5-flash aparecia listado
// para esta chave, mas a Google recusava a chamada real com "no longer available to new
// users". A lista serve só para saber que o modelo EXISTE; se é UTILIZÁVEL só se sabe
// chamando. Por isso este teste TENTA de verdade, um por um (até 6, teto de segurança —
// não é para percorrer o catálogo inteiro), e devolve o primeiro que responder, além do
// relato de cada tentativa que falhou (para não esconder nada, "sem mentir").
// Com ?modelo=, testa só esse (sem tentar outros), para checar um específico.
app.get('/gemini-teste', auth, async (req, res) => {
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY não configurada no servidor.' });
  const lista = await _listarModelosGemini();
  if (!lista.length) return res.status(502).json({ error: 'A Models API do Gemini não devolveu nenhum modelo utilizável para esta chave.' });
  const pedido = req.query.modelo;
  const candidatos = (pedido && lista.some(x => x.id === pedido)) ? [pedido] : lista.slice(0, 6).map(m => m.id);

  const tentativas = [];
  for (const modelo of candidatos) {
    const r = await _chamarModelo({
      modelo, esforco: 'low',
      sistema: 'Responda apenas com o JSON pedido, nada mais.',
      mensagem: 'Diga "funcionando" no campo texto.',
      schema: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] },
      maxTokens: 100
    });
    if (r.ok) return res.json({ ok: true, modelo, resposta: r.texto, tentativasAnteriores: tentativas });
    tentativas.push({ modelo, status: r.status, erro: (r.corpoErro && r.corpoErro.error) || r.corpoErro });
  }
  res.status(502).json({ ok: false, erro: `Nenhum dos ${candidatos.length} modelo(s) testado(s) respondeu.`, tentativas });
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
  let privadosParciais = false;
  try {
    // O collectionGroup varre a subcoleção `privado` de TODAS as citações — é de longe a
    // leitura mais cara daqui. Com um teto de tempo, um dia ruim de rede degrada o backup
    // (fica sem os comentários, e o relatório diz isso) em vez de derrubá-lo inteiro por
    // estouro de tempo no cron. O restante do backup é mais importante do que esta parte.
    let cronometro;
    const priv = await Promise.race([
      db.collectionGroup('privado').get(),
      new Promise(resolve => { cronometro = setTimeout(() => resolve(null), 20000); })
    ]).finally(() => clearTimeout(cronometro)); // sem isto o timer segura o processo por 20s
    if (!priv) { privadosParciais = true; throw new Error('leitura dos comentários pessoais passou de 20s'); }
    priv.docs.forEach(d => {
      const citacaoId = d.ref.parent.parent ? d.ref.parent.parent.id : null;
      if (!citacaoId) return;
      const uid = d.id;
      (privadosPorDono[uid] = privadosPorDono[uid] || []).push({ citacaoId, ...d.data() });
    });
  } catch (e) {
    privadosParciais = true;
    console.error('Não foi possível ler os comentários pessoais:', e.message);
  }

  // Anotações de trabalho (coleção `anotacoes`). Mesmo tratamento dos comentários
  // pessoais, e pelo mesmo motivo: a anotação nasce privada, então guardá-la num lugar
  // que o site deixasse ler abriria pela porta do backup o que a regra fecha na origem.
  // Vão agrupadas por dono, numa subcoleção com `read, write: if false` — nem o
  // coordenador lê pelo site; quem restaura é o servidor, que devolve só números.
  // As compartilhadas seguem junto: separá-las renderia pouco e o caminho de restauração
  // teria de existir dos dois jeitos de qualquer forma.
  const anotacoesPorDono = {};
  let anotacoesTotal = 0, anotacoesCompartilhadas = 0;
  try {
    const anots = await db.collection('anotacoes').get();
    anots.docs.forEach(d => {
      const a = d.data() || {};
      const uid = a.autor_uid;
      if (!uid) return; // sem dono não há para quem restaurar
      (anotacoesPorDono[uid] = anotacoesPorDono[uid] || []).push({ id: d.id, ...a });
      anotacoesTotal++;
      if (a.compartilhada === true) anotacoesCompartilhadas++;
    });
  } catch (e) {
    // Igual aos comentários: perder o backup inteiro por causa desta coleção seria pior.
    console.error('Não foi possível ler as anotações:', e.message);
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
    contagem_outras: Object.fromEntries(Object.entries(outras).map(([k, v]) => [k, v.length])),
    // Só números: deixa o coordenador conferir que as anotações foram copiadas sem que
    // isso lhe dê acesso ao conteúdo de nenhuma delas.
    contagem_anotacoes: {
      total: anotacoesTotal,
      compartilhadas: anotacoesCompartilhadas,
      privadas: anotacoesTotal - anotacoesCompartilhadas,
      pessoas: Object.keys(anotacoesPorDono).length
    },
    // Marca o backup como incompleto quando os comentários pessoais não puderam ser lidos.
    // Backup que falha em silêncio é pior do que backup que falha: só se descobre na hora
    // de restaurar, que é exatamente a hora em que não dá mais para consertar.
    comentarios_incompletos: privadosParciais
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
  await Promise.all(Object.entries(anotacoesPorDono).map(([uid, itens]) =>
    docRef.collection('anotacoes').doc(uid).set({ uid, itens })
  ));

  // Mantém só os últimos 90 backups (evita crescimento indefinido no plano free do Firestore)
  const antigos = await db.collection('backups').orderBy('gerado_em', 'desc').offset(90).limit(30).get();
  await Promise.all(antigos.docs.map(async d => {
    // Apagar TODAS as subcoleções — no Firestore, apagar o documento pai não apaga as filhas;
    // esquecer alguma aqui deixaria lixo órfão acumulando para sempre.
    for (const sub of ['por_corrente', 'outras_colecoes', 'comentarios_privados', 'anotacoes']) {
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
    // Anotações não vão para a planilha (é um espelho legível, e a maioria delas é privada);
    // ficam só no backup do Firestore, de onde o servidor sabe restaurá-las.
    anotacoes: { total: anotacoesTotal, pessoas: Object.keys(anotacoesPorDono).length },
    comentarios_incompletos: privadosParciais,
    planilha
  };
}

app.post('/backup-diario', async (req, res) => {
  const secret = req.headers['x-backup-secret'];
  if (!segredoConfere(secret, process.env.BACKUP_SECRET)) {
    return res.status(403).json({ error: 'Não autorizado.' });
  }
  try {
    // Resposta MÍNIMA de propósito. Quem chama esta rota é o cron-job.org, que armazena o
    // corpo da resposta no histórico e marca a execução como "output too large" quando ela
    // passa do limite dele — foi exactamente o que aconteceu em 28/07/2026, fazendo um
    // backup BEM-SUCEDIDO ser registrado como falha. O backup é feito por _gerarBackup();
    // aqui só se confirma o resultado em poucos bytes. O relatório completo continua na
    // rota /backup-agora, que é a do botão no site e não tem limite de resposta.
    const r = await _gerarBackup();
    res.json({ ok: r.ok !== false, total: r.total ?? null, data: r.data ?? null });
  } catch (e) {
    // Mensagem truncada pela mesma razão: erro do Google costuma vir com corpo longo, e uma
    // falha registrada como "output too large" esconde qual foi a falha de verdade.
    console.error('Erro backup-diario:', e.message);
    res.status(500).json({ error: String(e.message || 'erro').slice(0, 200) });
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

/* Restaura anotações de trabalho a partir de um backup.
 *
 * Tem de ser no servidor pelo mesmo motivo dos comentários pessoais: pela regra do
 * Firestore, `anotacoes` só aceita gravação de quem é o autor — o coordenador não
 * consegue (nem deve) recriar a anotação de outra pessoa pelo navegador. O Admin SDK
 * ignora as rules, então é o único caminho; e a resposta devolve SÓ números, para
 * recuperar o material de alguém sem lê-lo.
 *
 * Aditivo por padrão: só recria o que está faltando. `sobrescrever` é escolha explícita.
 * `?simular=1` faz passagem seca. `email` restringe a uma pessoa. Idempotente.
 * O dono original é preservado (`autor_uid` vem do backup, nunca de quem chamou) — é o
 * que impede a restauração de transferir a autoria da anotação para o coordenador. */
app.post('/restaurar-anotacoes', auth, async (req, res) => {
  const db = _getDbBackup();
  if (!db) return res.status(500).json({ error: 'Falta FIREBASE_SERVICE_ACCOUNT_JSON no servidor.' });
  const { data = '', email = '', sobrescrever = false } = req.body || {};
  const simular = req.query.simular === '1';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return res.status(400).json({ error: 'Informe a data do backup no formato AAAA-MM-DD.' });
  }

  try {
    let uidAlvo = null;
    if (email) {
      const u = await db.collection('usuarios').where('email', '==', String(email).trim().toLowerCase()).limit(1).get();
      if (u.empty) return res.status(404).json({ error: 'Nenhum usuário cadastrado com esse e-mail.' });
      uidAlvo = u.docs[0].id;
    }

    const snap = await db.collection('backups').doc(data).collection('anotacoes').get();
    if (snap.empty) {
      return res.json({
        ok: true, simulacao: simular, restaurados: 0,
        aviso: 'Este backup não guardou anotações (provavelmente é anterior a essa mudança, ou não havia nenhuma).'
      });
    }

    let restaurados = 0, jaExistiam = 0, semId = 0, pessoas = 0;
    for (const doc of snap.docs) {
      const uid = doc.id;
      if (uidAlvo && uid !== uidAlvo) continue;
      pessoas++;
      const itens = (doc.data() || {}).itens || [];
      for (const it of itens) {
        const id = it && it.id;
        if (!id) { semId++; continue; }

        const alvo = db.collection('anotacoes').doc(id);
        if (!sobrescrever && (await alvo.get()).exists) { jaExistiam++; continue; }
        if (!simular) {
          const dados = { ...it, autor_uid: uid, restaurado_de: data };
          delete dados.id; // o id é a chave do documento, não um campo dentro dele
          await alvo.set(dados);
        }
        restaurados++;
      }
    }

    // Só números — o texto das anotações nunca sai daqui.
    res.json({ ok: true, simulacao: simular, sobrescrever: !!sobrescrever, pessoas, restaurados, ja_existiam: jaExistiam, sem_id: semId });
  } catch (e) {
    console.error('Erro restaurar-anotacoes:', e.message);
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

// Marcador de versão. Este serviço foi criado no Render como "Public Git Repository", sem
// conta do GitHub conectada: `git push` NÃO dispara redeploy, é preciso clicar
// Manual Deploy → Deploy latest commit. Sem um marcador não havia como saber, de fora, se o
// que está no ar corresponde ao que está no repositório — todas as outras rotas exigem
// credencial e respondem igual em qualquer versão. Atualizar esta string a cada mudança.
const VERSAO = '2026-07-30 · gemini-teste tenta em sequencia + filtro so-texto-Gemini na lista de modelos';
app.get('/health', (_, res) => res.json({ ok: true, versao: VERSAO }));

app.listen(process.env.PORT || 3000, () => console.log('Proxy de citações rodando'));
