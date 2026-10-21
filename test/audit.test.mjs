/* Testes do núcleo que impede fonte inventada.
 * Carrega os scripts de navegador num contexto VM com um "window" falso.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function loadNB() {
  const sandbox = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    JSON,
    Math,
    Promise,
    Number,
    String,
    Object,
    Array,
    isFinite,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['config.js', 'outlets.js', 'store.js', 'audit.js', 'pipeline.js']) {
    const code = fs.readFileSync(path.join(root, 'assets', 'js', file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }
  return sandbox.NB;
}

const NB = loadNB();

/* ------------------------------------------------------------- domínios */

test('normalizeDomain remove esquema, www e barra final, e mantém subcaminho', () => {
  assert.equal(NB.outlets.normalizeDomain('https://www.G1.globo.com/fato-ou-fake/'), 'g1.globo.com/fato-ou-fake');
  assert.equal(NB.outlets.normalizeDomain('  folha.uol.com.br  '), 'folha.uol.com.br');
  assert.equal(NB.outlets.normalizeDomain('https://g1.globo.com/?utm_source=x'), 'g1.globo.com');
  assert.equal(NB.outlets.normalizeDomain('nada'), '');
});

test('parseList deduplica e junta vírgulas, espaços e linhas', () => {
  const list = NB.outlets.parseList('g1.globo.com, https://www.g1.globo.com/\nfolha.uol.com.br; uol.com.br');
  assert.deepEqual(Array.from(list), ['g1.globo.com', 'folha.uol.com.br', 'uol.com.br']);
});

test('matchesAllowed segue a regra de subdomínio da API', () => {
  const allowed = ['g1.globo.com', 'folha.uol.com.br'];
  assert.equal(NB.outlets.matchesAllowed('https://g1.globo.com/politica/noticia.html', allowed), true);
  assert.equal(NB.outlets.matchesAllowed('https://sub.g1.globo.com/x', allowed), true);
  assert.equal(NB.outlets.matchesAllowed('https://g1.globo.com.evil.com/x', allowed), false);
  assert.equal(NB.outlets.matchesAllowed('https://fakeg1.globo.com/x', allowed), false);
  assert.equal(NB.outlets.matchesAllowed('https://oglobo.globo.com/x', allowed), false);
});

test('matchesAllowed respeita entrada com subcaminho', () => {
  const allowed = ['g1.globo.com/fato-ou-fake'];
  assert.equal(NB.outlets.matchesAllowed('https://g1.globo.com/fato-ou-fake/materia.html', allowed), true);
  assert.equal(NB.outlets.matchesAllowed('https://g1.globo.com/politica/materia.html', allowed), false);
});

/* ------------------------------------------------------------- evidências */

const responseWithResults = {
  content: [
    { type: 'text', text: 'Vou buscar.' },
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'censo 2022 população' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: [
        {
          type: 'web_search_result',
          url: 'https://www.ibge.gov.br/censo.html?utm_source=busca',
          title: 'Censo 2022',
          page_age: '2023-06-28',
        },
      ],
    },
    {
      type: 'text',
      text: 'O Censo 2022 contou 203 milhões.',
      citations: [
        {
          type: 'web_search_result_location',
          url: 'https://www.ibge.gov.br/censo.html?utm_source=busca',
          title: 'Censo 2022',
          cited_text: 'população recenseada',
        },
      ],
    },
  ],
  usage: { server_tool_use: { web_search_requests: 1 } },
};

test('collectEvidence extrai queries, resultados e citações', () => {
  const ev = NB.audit.collectEvidence(responseWithResults.content);
  assert.deepEqual(Array.from(ev.queries), ['censo 2022 população']);
  assert.equal(ev.results.length, 1);
  assert.equal(ev.results[0].pageAge, '2023-06-28');
  assert.equal(ev.citations.length, 1);
});

test('collectEvidence encontra resultados aninhados no filtro dinâmico', () => {
  const content = [
    {
      type: 'code_execution_tool_result',
      content: [
        { type: 'server_tool_use', id: 'srvtoolu_x', name: 'web_search', input: { query: 'pib brasil' } },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_x',
          content: [{ type: 'web_search_result', url: 'https://valor.globo.com/pib', title: 'PIB' }],
        },
      ],
    },
  ];
  const ev = NB.audit.collectEvidence(content);
  assert.equal(ev.results.length, 1);
  assert.equal(ev.results[0].url, 'https://valor.globo.com/pib');
});

test('collectEvidence registra erros da busca', () => {
  const ev = NB.audit.collectEvidence([
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_e',
      content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
    },
  ]);
  assert.deepEqual(Array.from(ev.errors), ['max_uses_exceeded']);
});

/* -------------------------------------------------------------- auditoria */

const allowed = ['ibge.gov.br', 'g1.globo.com'];

test('auditSources confirma fonte que voltou da busca e está na lista', () => {
  const audit = NB.audit.auditSources({
    sources: [{ veiculo: 'IBGE', titulo: 'Censo 2022', url: 'https://ibge.gov.br/censo.html' }],
    response: responseWithResults,
    allowed,
  });
  assert.equal(audit.total, 1);
  assert.equal(audit.trusted, 1);
  assert.equal(audit.items[0].status, 'confirmada');
  assert.equal(audit.items[0].citedByModel, true);
  assert.equal(audit.searchRequests, 1);
});

test('auditSources rejeita URL fora de allowed_domains', () => {
  const audit = NB.audit.auditSources({
    sources: [{ veiculo: 'Blog', titulo: 'x', url: 'https://blog-aleatorio.com/x' }],
    response: responseWithResults,
    allowed,
  });
  assert.equal(audit.trusted, 0);
  assert.equal(audit.items[0].status, 'fora_da_lista');
});

test('auditSources marca como inventada a fonte que a busca não devolveu', () => {
  const audit = NB.audit.auditSources({
    sources: [{ veiculo: 'g1', titulo: 'matéria inventada', url: 'https://g1.globo.com/inventada.html' }],
    response: responseWithResults,
    allowed,
  });
  assert.equal(audit.trusted, 0);
  assert.equal(audit.items[0].status, 'nao_vista_na_busca');
  assert.match(audit.items[0].motivo, /inventada/);
});

test('auditSources aceita resultado com diferença de www, barra e parâmetro de rastreio', () => {
  const audit = NB.audit.auditSources({
    sources: [{ url: 'https://www.ibge.gov.br/censo.html/' }],
    response: responseWithResults,
    allowed,
  });
  assert.equal(audit.items[0].seenInSearch, true);
  assert.equal(audit.trusted, 1);
});

test('auditSources reconhece fonte pelo título normalizado', () => {
  const audit = NB.audit.auditSources({
    sources: [{ url: 'https://ibge.gov.br/outro-endereco', titulo: 'CENSO 2022' }],
    response: responseWithResults,
    allowed,
  });
  assert.equal(audit.items[0].seenInSearch, true);
});

/* ------------------------------------------------------- regra de veredito */

test('enforceSourceRule rebaixa FALSO sem fonte confirmada', () => {
  const audit = NB.audit.auditSources({
    sources: [{ url: 'https://blog-aleatorio.com/x' }],
    response: responseWithResults,
    allowed,
  });
  const out = NB.audit.enforceSourceRule('FALSO', audit);
  assert.equal(out.verdict, 'NAO_VERIFICADO');
  assert.equal(out.downgraded, true);
  assert.match(out.reason, /fora da lista/);
});

test('enforceSourceRule mantém veredito com fonte confirmada', () => {
  const audit = NB.audit.auditSources({
    sources: [{ url: 'https://ibge.gov.br/censo.html' }],
    response: responseWithResults,
    allowed,
  });
  const out = NB.audit.enforceSourceRule('VERDADEIRO', audit);
  assert.equal(out.verdict, 'VERDADEIRO');
  assert.equal(out.downgraded, false);
});

test('enforceSourceRule não rebaixa NAO_VERIFICADO', () => {
  const audit = { items: [], trusted: 0, total: 0 };
  const out = NB.audit.enforceSourceRule('NAO_VERIFICADO', audit);
  assert.equal(out.verdict, 'NAO_VERIFICADO');
  assert.equal(out.downgraded, false);
});

/* ---------------------------------------------------------- normalização */

test('normalizeVerdict traduz variações do modelo', () => {
  assert.equal(NB.pipelineUtils.normalizeVerdict('verdadeira'), 'VERDADEIRO');
  assert.equal(NB.pipelineUtils.normalizeVerdict('Falsa'), 'FALSO');
  assert.equal(NB.pipelineUtils.normalizeVerdict('fora de contexto'), 'FORA_DE_CONTEXT');
  assert.equal(NB.pipelineUtils.normalizeVerdict('inventado'), 'NAO_VERIFICADO');
});

test('dedupe por jaccard ignora paráfrase curta', () => {
  const a = NB.pipelineUtils.tokenSet('O salário mínimo está congelado há oito anos no Brasil');
  const b = NB.pipelineUtils.tokenSet('O salário mínimo brasileiro está congelado há 8 anos');
  assert.ok(NB.pipelineUtils.jaccard(a, b) > 0.5);
  const c = NB.pipelineUtils.tokenSet('A carga tributária brasileira é a maior do mundo');
  assert.ok(NB.pipelineUtils.jaccard(a, c) < 0.2);
});

test('o schema de verificação exige os campos usados pela auditoria', () => {
  const schema = NB.pipelineUtils.VERIFY_SCHEMA;
  assert.deepEqual(Array.from(schema.required).sort(), [
    'confianca',
    'correcao',
    'explicacao',
    'fontes',
    'termos_usados',
    'veredito',
  ]);
  assert.equal(schema.additionalProperties, false);
  const fonte = schema.properties.fontes.items;
  assert.deepEqual(Array.from(fonte.required).sort(), ['data', 'titulo', 'trecho', 'url', 'veiculo']);
});

/* ------------------------------------------- degradações automáticas da API */

function fakeStore() {
  return { state: NB.config.defaults(), outlets: ['g1.globo.com'] };
}

function okResponse(text = '{"ok":true}') {
  return {
    id: 'msg_ok',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function http400(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

test('_callSchema repete sem output_config quando a conta recusa o schema', async () => {
  const bodies = [];
  const api = {
    create: async (cfg, body) => {
      bodies.push(body);
      if (bodies.length === 1) {
        throw http400('Esta conta/modelo não aceitou structured outputs: feature indisponível');
      }
      return okResponse();
    },
  };
  const pipeline = new NB.Pipeline({ store: fakeStore(), api });
  const out = await pipeline._callSchema(
    {
      model: 'claude-opus-5-5',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'oi' }],
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
    },
    'teste'
  );
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].output_config);
  assert.equal(bodies[1].output_config, undefined);
  assert.equal(out.stop_reason, 'end_turn');
});

test('_callSchema repete sem thinking quando o modelo recusa raciocínio adaptativo', async () => {
  const bodies = [];
  const api = {
    create: async (cfg, body) => {
      bodies.push(body);
      if (bodies.length === 1) throw http400('thinking adaptativo não é suportado por este modelo');
      return okResponse();
    },
  };
  const pipeline = new NB.Pipeline({ store: fakeStore(), api });
  await pipeline._callSchema(
    {
      model: 'claude-haiku-4-5',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'oi' }],
      thinking: { type: 'adaptive' },
    },
    'teste'
  );
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].thinking);
  assert.equal(bodies[1].thinking, undefined);
});

test('_callSchema cai para a busca básica quando a versão nova é recusada', async () => {
  const bodies = [];
  const api = {
    create: async (cfg, body) => {
      bodies.push(body);
      if (bodies.length === 1) throw http400('web_search_20260209 não é suportado por este modelo');
      return okResponse();
    },
  };
  const pipeline = new NB.Pipeline({ store: fakeStore(), api });
  await pipeline._callSchema(
    {
      model: 'claude-haiku-4-5',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'oi' }],
      tools: [
        {
          type: 'web_search_20260209',
          name: 'web_search',
          allowed_domains: ['g1.globo.com'],
          allowed_callers: ['direct'],
        },
      ],
    },
    'teste'
  );
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].tools[0].type, 'web_search_20250305');
  assert.equal(bodies[1].tools[0].allowed_callers, undefined);
  assert.deepEqual(Array.from(bodies[1].tools[0].allowed_domains), ['g1.globo.com']);
});

test('_call continua um turno pausado sem gastar tentativa', async () => {
  const bodies = [];
  const api = {
    create: async (cfg, body) => {
      bodies.push(body);
      if (bodies.length < 3) {
        return {
          id: 'msg_pause',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'server_tool_use', id: 'srvtoolu_x', name: 'web_search', input: { query: 'x' } },
          ],
          stop_reason: 'pause_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      return okResponse();
    },
  };
  const pipeline = new NB.Pipeline({ store: fakeStore(), api });
  const out = await pipeline._call(
    { model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'oi' }] },
    'teste'
  );
  assert.equal(bodies.length, 3);
  assert.equal(out.stop_reason, 'end_turn');
  // terceira chamada leva as duas respostas pausadas no histórico:
  // 1 mensagem do usuário + 2 assistant pausadas
  assert.equal(bodies[2].messages.length, 3);
  assert.equal(bodies[2].messages[1].role, 'assistant');
  assert.equal(bodies[2].messages[2].role, 'assistant');
});
