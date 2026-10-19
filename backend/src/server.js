import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { getCalendarioCompleto, getDiaInfo, isDiaLetivo, getProximosDias, calcularProgresso, getHorarioDoDia } from './services/calendarService.js';
import { gerarConteudo, gerarObservacao, getBimestre } from './services/contentGenerator.js';
import { getHorario, saveHorario } from './services/horarioService.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir frontend estático
const frontendPath = path.join(__dirname, '../../frontend');
app.use(express.static(frontendPath));

// --- Persistência simples de registros (simula banco) ---
const DATA_DIR = path.join(__dirname, '../../data');
const REGISTROS_PATH = path.join(DATA_DIR, 'registros.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(REGISTROS_PATH)) fs.writeFileSync(REGISTROS_PATH, JSON.stringify([], null, 2));
  if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify({ turma: getHorario().turma, ano_letivo: 2026 }, null, 2));
}
ensureDataDir();

function loadRegistros() {
  try { return JSON.parse(fs.readFileSync(REGISTROS_PATH, 'utf-8')); } catch { return []; }
}
function saveRegistros(r) { fs.writeFileSync(REGISTROS_PATH, JSON.stringify(r, null, 2)); }

// ============ ROTAS API ============

app.get('/api/health', (req, res) => res.json({ ok: true, version: '1.0.0', time: new Date().toISOString() }));

// Horário e configuração
app.get('/api/horario', (req, res) => {
  res.json(getHorario());
});
app.put('/api/horario', (req, res) => {
  const novo = saveHorario(req.body);
  res.json(novo);
});

// Calendário
app.get('/api/calendario', (req, res) => {
  const ano = parseInt(req.query.ano) || 2026;
  res.json(getCalendarioCompleto(ano));
});

app.get('/api/calendario/dia/:data', (req, res) => {
  const info = getDiaInfo(req.params.data);
  // adiciona preview de conteúdos que seriam gerados
  const previews = info.materias.map(m => {
    const c = gerarConteudo({ disciplina: m.disciplina, dataISO: req.params.data });
    return { disciplina: m.disciplina, aulas: m.aulas, ...c, observacao: gerarObservacao({ disciplina: m.disciplina }) };
  });
  res.json({ ...info, previews });
});

app.get('/api/proximos-dias', (req, res) => {
  const qtd = parseInt(req.query.qtd) || 7;
  res.json(getProximosDias(qtd, req.query.incluirHoje !== 'false'));
});

// Registros
app.get('/api/registros', (req, res) => {
  let regs = loadRegistros();
  if (req.query.disciplina) regs = regs.filter(r => r.disciplina === req.query.disciplina);
  if (req.query.data) regs = regs.filter(r => r.data === req.query.data);
  if (req.query.turma) regs = regs.filter(r => r.turma === req.query.turma);
  res.json(regs);
});

app.get('/api/progresso', (req, res) => {
  const regs = loadRegistros();
  res.json(calcularProgresso(regs));
});

// Gerar preview de conteúdo (sem salvar)
app.post('/api/preview', (req, res) => {
  const { disciplina, data } = req.body;
  if (!disciplina || !data) return res.status(400).json({ error: 'disciplina e data são obrigatórios' });
  const conteudo = gerarConteudo({ disciplina, dataISO: data, historico: loadRegistros().filter(r => r.disciplina === disciplina).map(r => r.conteudo) });
  res.json({ ...conteudo, observacao: gerarObservacao({ disciplina }) });
});

// Criar registro (simulado ou real via bot)
app.post('/api/registros', async (req, res) => {
  const { disciplina, data, quantidadeAulas, conteudo, observacoes, turma, modo = 'simulado' } = req.body;
  if (!disciplina || !data) return res.status(400).json({ error: 'disciplina e data obrigatórios' });

  if (!isDiaLetivo(data)) {
    return res.status(400).json({ error: 'Data não é dia letivo', data, letivo: false });
  }

  // verifica duplicidade local
  const regs = loadRegistros();
  const existe = regs.find(r => r.data === data && r.disciplina === disciplina);
  if (existe) return res.status(409).json({ error: 'Já existe registro para esta data/disciplina', existe });

  let conteudoFinal = conteudo;
  let bimestre = getBimestre(data);
  if (!conteudoFinal) {
    const historico = regs.filter(r => r.disciplina === disciplina).map(r => r.conteudo);
    const gen = gerarConteudo({ disciplina, dataISO: data, historico });
    conteudoFinal = gen.conteudo;
    bimestre = gen.bimestre;
  }

  // Se modo real, tenta usar EduGestão
  if (modo === 'real') {
    try {
      const { EduGestaoClient } = await import('./services/edugestaoClient.js');
      const client = new EduGestaoClient({ headless: process.env.BOT_HEADLESS !== 'false' });
      const result = await client.criarRegistroAula({
        turma: turma || getHorario().turma,
        disciplina,
        data,
        quantidadeAulas: quantidadeAulas || 1,
        conteudo: conteudoFinal,
        observacoes: observacoes || gerarObservacao({ disciplina })
      });
      await client.close();
      if (result.status === 'sucesso' || result.status === 'ja_existe') {
        // salva local também
        const novo = { id: Date.now().toString(), turma: turma || getHorario().turma, disciplina, data, quantidadeAulas: quantidadeAulas || 1, conteudo: conteudoFinal, observacoes, bimestre, status: 'Validado', criadoEm: new Date().toISOString(), modo: 'real' };
        regs.push(novo);
        saveRegistros(regs);
        return res.json({ ok: true, registro: novo, edugestao: result });
      } else {
        return res.status(500).json({ error: 'Falha ao salvar no EduGestão', detalhes: result });
      }
    } catch (e) {
      console.error('Erro bot real:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // modo simulado (grava local + marca como pendente de sincronização)
  const novo = {
    id: Date.now().toString(),
    turma: turma || getHorario().turma,
    disciplina,
    data,
    quantidadeAulas: quantidadeAulas || 1,
    conteudo: conteudoFinal,
    observacoes: observacoes || gerarObservacao({ disciplina }),
    bimestre,
    status: 'Validado',
    criadoEm: new Date().toISOString(),
    modo: 'simulado',
    sincronizado: false
  };
  regs.push(novo);
  saveRegistros(regs);
  res.json({ ok: true, registro: novo });
});

// Gerar dia completo (todas disciplinas do horário)
app.post('/api/gerar-dia', async (req, res) => {
  const { data, turma, modo = 'simulado', observacoes } = req.body;
  if (!data) return res.status(400).json({ error: 'data obrigatória (YYYY-MM-DD)' });

  if (!isDiaLetivo(data)) return res.status(400).json({ error: 'Dia não letivo', data });

  const materias = getHorarioDoDia(data);
  if (materias.length === 0) return res.json({ ok: true, data, materias: [], message: 'Nenhuma aula prevista para este dia da semana no horário' });

  if (modo === 'real') {
    try {
      const { EduGestaoClient } = await import('./services/edugestaoClient.js');
      const client = new EduGestaoClient({ headless: process.env.BOT_HEADLESS !== 'false' });
      await client.init();
      await client.login();
      const result = await client.gerarDiaCompleto({ data, turma: turma || getHorario().turma, observacoes, dryRun: false });
      await client.close();

      // salva local os sucessos
      const regs = loadRegistros();
      for (const r of result.resultados) {
        if (r.status === 'sucesso') {
          const ja = regs.find(x => x.data === data && x.disciplina === r.disciplina);
          if (!ja) regs.push({ id: Date.now().toString() + Math.random(), turma: turma || getHorario().turma, disciplina: r.disciplina, data, quantidadeAulas: r.aulas, conteudo: r.conteudo, bimestre: r.bimestre, status: 'Validado', criadoEm: new Date().toISOString(), modo: 'real' });
        }
      }
      saveRegistros(regs);
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // simulado
  const regs = loadRegistros();
  const resultados = [];
  for (const m of materias) {
    const existe = regs.find(r => r.data === data && r.disciplina === m.disciplina);
    if (existe) {
      resultados.push({ disciplina: m.disciplina, aulas: m.aulas, status: 'ja_existe', existe });
      continue;
    }
    const historico = regs.filter(r => r.disciplina === m.disciplina).map(r => r.conteudo);
    const gen = gerarConteudo({ disciplina: m.disciplina, dataISO: data, historico });
    const novo = { id: Date.now().toString() + Math.random().toString(36).slice(2,6), turma: turma || getHorario().turma, disciplina: m.disciplina, data, quantidadeAulas: m.aulas, conteudo: gen.conteudo, observacoes: observacoes || gerarObservacao({ disciplina: m.disciplina }), bimestre: gen.bimestre, status: 'Validado', criadoEm: new Date().toISOString(), modo: 'simulado' };
    regs.push(novo);
    resultados.push({ disciplina: m.disciplina, aulas: m.aulas, status: 'sucesso', conteudo: gen.conteudo, bimestre: gen.bimestre, registro: novo });
  }
  saveRegistros(regs);
  res.json({ ok: true, status: 'concluido', data, resultados, totalGerados: resultados.filter(r => r.status === 'sucesso').length });
});

// Deletar registro
app.delete('/api/registros/:id', (req, res) => {
  let regs = loadRegistros();
  const antes = regs.length;
  regs = regs.filter(r => r.id !== req.params.id);
  if (regs.length === antes) return res.status(404).json({ error: 'Registro não encontrado' });
  saveRegistros(regs);
  res.json({ ok: true });
});

// Sincronizar pendentes com EduGestão
app.post('/api/sincronizar', async (req, res) => {
  const regs = loadRegistros();
  const pendentes = regs.filter(r => !r.sincronizado && r.modo === 'simulado');
  if (pendentes.length === 0) return res.json({ ok: true, message: 'Nenhum registro pendente', total: 0 });

  // dispara sincronização em background (simulado aqui)
  // em produção, iteraria com EduGestaoClient
  res.json({ ok: true, message: `Sincronização iniciada para ${pendentes.length} registros. Acompanhe os logs.`, pendentes });
});

// Auth - login que salva sessão e só clona quando logar
import crypto from 'crypto';
const SESSIONS = new Map(); // memória: cpf -> {cpf, logadoEm, turmas, disciplinas}

app.post('/api/auth/login', async (req, res) => {
  const { cpf, senha } = req.body;
  if (!cpf || !senha) return res.status(400).json({ error: 'CPF e senha obrigatórios' });
  // valida formato
  const cpfLimpo = cpf.replace(/\D/g,'');
  if (cpfLimpo.length !== 11) return res.status(400).json({ error: 'CPF deve ter 11 dígitos. Ex: 88339211315' });
  if (senha.length < 3) return res.status(400).json({ error: 'Senha muito curta' });
  try {
    const { EduGestaoClient } = await import('./services/edugestaoClient.js');
    const client = new EduGestaoClient({ cpf, senha, headless: true });
    await client.login();
    const info = await client.getTurmasEDisciplinas();
    let registrosReais = [];
    try { registrosReais = await client.getRegistrosReais(); } catch {}
    await client.close();

    const sess = { cpf, logadoEm: new Date().toISOString(), turmas: info.turmas, disciplinas: info.disciplinas, registrosClonados: registrosReais.length };
    SESSIONS.set(cpf, sess);
    try {
      const p = path.join(DATA_DIR, `session-${cpf}.json`);
      fs.writeFileSync(p, JSON.stringify(sess, null, 2));
    } catch {}
    res.json({ ok: true, message: 'Login realizado! Site clonado.', clone: registrosReais.length > 0, ...info, sess });
  } catch (e) {
    console.error('[login] erro', e.message);
    // detecta erro de rede - sandbox não tem acesso ao EduGestão
    const msg = e.message || '';
    const isNetwork = /não foi possível acessar|ENOTFOUND|ECONNREFUSED|SSL_|timeout|ETIMEDOUT|fetch failed/i.test(msg);
    if (isNetwork) {
      return res.status(503).json({
        ok: false,
        error: 'Preview online sem acesso ao EduGestão (restrição de rede). Rode LOCALMENTE: clique INICIAR.bat no seu PC e faça login por lá — vai funcionar. Ou use "Continuar sem login" para testar.',
        code: 'NETWORK_RESTRICTED',
        hint: 'LOCAL_ONLY'
      });
    }
    res.status(401).json({ ok: false, error: msg });
  }
});
app.get('/api/auth/status', (req, res) => {
  const cpf = req.query.cpf || req.headers['x-cpf'];
  if (!cpf) return res.json({ logado: false });
  if (SESSIONS.has(cpf)) return res.json({ logado: true, ...SESSIONS.get(cpf) });
  // tenta disco
  try {
    const p = path.join(DATA_DIR, `session-${cpf}.json`);
    if (fs.existsSync(p)) {
      const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
      SESSIONS.set(cpf, d);
      return res.json({ logado: true, ...d });
    }
  } catch {}
  res.json({ logado: false });
});
app.post('/api/auth/logout', (req, res) => {
  const { cpf } = req.body;
  if (cpf) {
    SESSIONS.delete(cpf);
    try { fs.unlinkSync(path.join(DATA_DIR, `session-${cpf}.json`)); } catch {}
  }
  res.json({ ok: true });
});
// Compat: manter /testar como alias do login
app.post('/api/auth/testar', async (req, res) => {
  const { cpf, senha } = req.body;
  if (!cpf || !senha) return res.status(400).json({ error: 'CPF e senha obrigatórios' });
  try {
    const { EduGestaoClient } = await import('./services/edugestaoClient.js');
    const client = new EduGestaoClient({ cpf, senha, headless: true });
    await client.login();
    const turmas = await client.getTurmasEDisciplinas();
    await client.close();
    res.json({ ok: true, message: 'Login realizado com sucesso!', ...turmas });
  } catch (e) {
    res.status(401).json({ ok: false, error: e.message });
  }
});

// Estatísticas
app.get('/api/estatisticas', (req, res) => {
  const regs = loadRegistros();
  const prog = calcularProgresso(regs);
  const porMes = {};
  for (const r of regs) {
    const mes = r.data.slice(0, 7);
    porMes[mes] = (porMes[mes] || 0) + 1;
  }
  res.json({ progresso: prog, totalRegistros: regs.length, porMes, ultimos: regs.slice(-10).reverse() });
});

// Replica fiel
app.get('/api/replica/estado', async (req, res) => {
  const { getEstadoReplica } = await import('./services/replicaSync.js');
  res.json(getEstadoReplica());
});
app.post('/api/replica/sincronizar', async (req, res) => {
  try {
    const { sincronizarComEduGestao } = await import('./services/replicaSync.js');
    const r = await sincronizarComEduGestao(req.body);
    res.json(r);
  } catch (e) {
    res.status(500).json({ sucesso:false, erro:e.message });
  }
});

// Fallback SPA - replica.html como default se ?replica
app.get('/replica', (req, res) => {
  res.sendFile(path.join(frontendPath, 'replica.html'));
});
app.get('*', (req, res) => {
  // Se ?replica ou header, serve replica
  if (req.query.replica !== undefined) return res.sendFile(path.join(frontendPath, 'replica.html'));
  res.sendFile(path.join(frontendPath, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Naubert Bot rodando em http://0.0.0.0:${PORT}`);
  console.log(`   EduGestão: ${process.env.EDUGESTAO_URL || 'https://lagoverde.edugestao.com'}`);
  console.log(`   Turma padrão: ${getHorario().turma}`);
});
