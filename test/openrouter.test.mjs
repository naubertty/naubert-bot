/* Testes do caminho OpenRouter: anotações, duas fases e auditoria. */
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
    console, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, Promise, Number, String, Object, Array, isFinite,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['config.js', 'outlets.js', 'store.js', 'audit.js', 'pipeline.js', 'providers.js', 'audio.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'assets', 'js', file), 'utf8'), sandbox, { filename: file });
  }
  return sandbox.NB;
}

const NB = loadNB();
const OUTLETS = ['g1.globo.com', 'ibge.gov.br'];

const CLAIM = {
  id: 'c1',
  texto: 'O Censo 2022 contou 203 milhões de habitantes.',
  falante: 'candidato B',
  tema: 'população',
  prioridade: 1,
  contexto: '',
};

/* ------------------------------------------------------------- respostas */

function searchResponse(annotations) {
  return {
    id: 'gen-search',
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'O Censo 2022 registrou 203.062.512 habitantes [g1.globo.com](https://g1.globo.com/censo).',
          annotations,
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 900, completion_tokens: 220, cost: 0.0042, server_tool_use: { web_search_requests: 1 } },
  };
}

function judgeResponse(verdict) {
  return {
    id: 'gen-judge',
    choices: [
      {
        message: {
          role: 'assistant',
          content: JSON.stringify(verdict),
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1300, completion_tokens: 280, cost: 0.0051 },
  };
}

const VERDICT_OK = {
  veredito: 'VERDADEIRO',
  explicacao: 'O Censo 2022 registrou 203.062.512 habitantes, o que arredonda para 203 milhões.',
  correcao: 'Confirmado: 203.062.512 habitantes.',
  confianca: 0.93,
  fontes: [
    {
      veiculo: 'g1',
      titulo: 'Censo 2022: população recenseada',
      url: 'https://g1.globo.com/censo',
      data: '2023-06-28',
      trecho: '203.062.512 habitantes',
    },
  ],
  termos_usados: 'censo 2022 população',
};

const ANNOTATION_OK = [
  {
    type: 'url_citation',
    url_citation: {
      url: 'https://g1.globo.com/censo',
      title: 'Censo 2022: população recenseada',
      content: 'O Censo 2022 contou 203.062.512 pessoas.',
      start_index: 0,
      end_index: 10,
    },
  },
];

function store() {
  return {
    state: Object.assign(NB.config.defaults(), {
      provider: 'openrouter',
      model: 'anthropic/claude-opus-5.5',
      triageModel: '',
      searchEngine: 'auto',
      maxUses: 3,
    }),
    outlets: OUTLETS,
  };
}

/* ----------------------------------------------------------- evidências */

test('evidenceFromAnnotations converte url_citation em resultados auditáveis', () => {
  const ev = NB.providers.evidenceFromAnnotations(searchResponse(ANNOTATION_OK));
  assert.equal(ev.results.length, 1);
  assert.equal(ev.results[0].url, 'https://g1.globo.com/censo');
  assert.equal(ev.results[0].title, 'Censo 2022: população recenseada');
  assert.equal(ev.citations.length, 1);
  assert.match(ev.citations[0].citedText, /203\.062\.512/);
  assert.equal(ev.searchRequests, 1);
});

test('evidenceFromAnnotations deduplica URLs repetidas', () => {
  const ev = NB.providers.evidenceFromAnnotations(
    searchResponse([ANNOTATION_OK[0], ANNOTATION_OK[0]])
  );
  assert.equal(ev.results.length, 1);
  assert.equal(ev.citations.length, 2);
});

test('annotationsOf aceita anotação sem o invólucro url_citation', () => {
  const ev = NB.providers.evidenceFromAnnotations(
    searchResponse([{ type: 'url_citation', url: 'https://ibge.gov.br/censo', title: 'Censo' }])
  );
  assert.equal(ev.results[0].url, 'https://ibge.gov.br/censo');
});

test('resposta sem anotações gera evidência vazia', () => {
  const ev = NB.providers.evidenceFromAnnotations({
    choices: [{ message: { content: 'sem fontes' } }],
    usage: {},
  });
  assert.equal(ev.results.length, 0);
  assert.equal(ev.searchRequests, 0);
});

/* ------------------------------------------------------- fluxo completo */

test('verify faz busca e julgamento e mantém veredito com fonte confirmada', async () => {
  const calls = [];
  const api = {
    chat: async (cfg, body) => {
      calls.push(body);
      if (body.tools) return searchResponse(ANNOTATION_OK);
      return judgeResponse(VERDICT_OK);
    },
    messages: async () => {
      throw new Error('não deveria usar a Messages API');
    },
  };

  const pipeline = new NB.Pipeline({ store: store(), api });
  const out = await pipeline.verify(CLAIM);

  assert.equal(out.veredito, 'VERDADEIRO');
  assert.equal(out.rebaixado, false);
  assert.equal(out.provedor, 'openrouter');
  assert.equal(out.fontes.length, 1);
  assert.equal(out.fontes[0].status, 'confirmada');
  assert.equal(out.buscas, 1);

  // fase 1: ferramenta de busca com filtro de domínio
  assert.equal(calls.length, 2);
  const search = calls[0];
  assert.equal(search.tools[0].type, 'openrouter:web_search');
  assert.deepEqual(Array.from(search.tools[0].parameters.allowed_domains), OUTLETS);
  assert.equal(search.tools[0].parameters.max_uses, 3);
  assert.equal(search.response_format, undefined, 'fase de busca não pode pedir JSON, senão perde as anotações');

  // fase 2: julgamento com schema e lista fechada, sem busca
  const judge = calls[1];
  assert.equal(judge.tools, undefined, 'o julgamento não pode buscar por conta própria');
  assert.equal(judge.response_format.type, 'json_schema');
  assert.ok(judge.messages[1].content.includes('https://g1.globo.com/censo'), 'a URL deve estar na lista fechada');

  // custo exato vindo do OpenRouter
  assert.ok(Math.abs(pipeline.usage.cost - (0.0042 + 0.0051)) < 1e-9, String(pipeline.usage.cost));
  assert.equal(pipeline.usage.calls, 2);
  assert.equal(pipeline.usage.searches, 1);
});

test('verify rebaixa quando o julgamento cita URL fora da busca', async () => {
  const invented = Object.assign({}, VERDICT_OK, {
    fontes: [
      {
        veiculo: 'g1',
        titulo: 'matéria que não existiu',
        url: 'https://g1.globo.com/materia-inventada',
        data: '',
        trecho: '',
      },
    ],
  });
  const api = {
    chat: async (cfg, body) => (body.tools ? searchResponse(ANNOTATION_OK) : judgeResponse(invented)),
  };

  const pipeline = new NB.Pipeline({ store: store(), api });
  const out = await pipeline.verify(CLAIM);

  assert.equal(out.vereditoOriginal, 'VERDADEIRO');
  assert.equal(out.veredito, 'NAO_VERIFICADO');
  assert.equal(out.rebaixado, true);
  assert.equal(out.fontes[0].status, 'nao_vista_na_busca');
  assert.match(out.fontes[0].motivo, /inventada/);
});

test('verify rebaixa quando a busca não devolve nenhuma anotação', async () => {
  const calls = [];
  const api = {
    chat: async (cfg, body) => {
      calls.push(body);
      return body.tools ? searchResponse([]) : judgeResponse(VERDICT_OK);
    },
  };

  const pipeline = new NB.Pipeline({ store: store(), api });
  const out = await pipeline.verify(CLAIM);

  assert.equal(out.veredito, 'NAO_VERIFICADO');
  assert.equal(out.rebaixado, true);
  assert.match(out.motivoRebaxamento, /não confirmadas|nenhuma fonte/);
  assert.ok(
    calls[1].messages[1].content.includes('nenhuma fonte foi retornada'),
    'o julgamento precisa saber que a lista veio vazia'
  );
});

test('verify rejeita fonte fora da lista, mesmo se a busca a devolveu', async () => {
  const fora = [
    {
      type: 'url_citation',
      url_citation: { url: 'https://blog-qualquer.com/x', title: 'blog', content: 'texto' },
    },
  ];
  const verdict = Object.assign({}, VERDICT_OK, {
    fontes: [
      { veiculo: 'Blog', titulo: 'blog', url: 'https://blog-qualquer.com/x', data: '', trecho: '' },
    ],
  });
  const api = {
    chat: async (cfg, body) => (body.tools ? searchResponse(fora) : judgeResponse(verdict)),
  };

  const pipeline = new NB.Pipeline({ store: store(), api });
  const out = await pipeline.verify(CLAIM);

  assert.equal(out.fontes[0].status, 'fora_da_lista');
  assert.equal(out.veredito, 'NAO_VERIFICADO');
});

/* ------------------------------------------------------------ fallbacks */

test('verify cai para o plugin web quando a server tool é recusada', async () => {
  const calls = [];
  const api = {
    chat: async (cfg, body) => {
      calls.push(body);
      if (body.tools) {
        const err = new Error('web_search server tool não é suportado por este endpoint');
        err.status = 400;
        throw err;
      }
      if (body.plugins) return searchResponse(ANNOTATION_OK);
      return judgeResponse(VERDICT_OK);
    },
  };

  const pipeline = new NB.Pipeline({ store: store(), api });
  const out = await pipeline.verify(CLAIM);

  assert.equal(calls.length, 3);
  assert.equal(calls[1].plugins[0].id, 'web');
  assert.deepEqual(Array.from(calls[1].plugins[0].include_domains), OUTLETS);
  assert.equal(out.veredito, 'VERDADEIRO');
  assert.equal(out.fontes[0].status, 'confirmada');
});

test('_callJson repete sem response_format quando o endpoint recusa o schema', async () => {
  const bodies = [];
  const api = {
    chat: async (cfg, body) => {
      bodies.push(body);
      if (bodies.length === 1) {
        const err = new Error('response_format json_schema não suportado');
        err.status = 400;
        throw err;
      }
      return judgeResponse(VERDICT_OK);
    },
  };

  const pipeline = new NB.Pipeline({ store: store(), api });
  const res = await pipeline._callJson(
    { model: 'x/y', messages: [], response_format: { type: 'json_schema', json_schema: {} } },
    'teste',
    'openrouter'
  );
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].response_format);
  assert.equal(bodies[1].response_format, undefined);
  assert.equal(NB.providers.chatText(res).includes('VERDADEIRO'), true);
});

test('_request trata finish_reason=length como truncamento', async () => {
  const api = {
    chat: async () => ({
      choices: [{ message: { content: '{}' }, finish_reason: 'length' }],
      usage: {},
    }),
  };
  const pipeline = new NB.Pipeline({ store: store(), api });
  await assert.rejects(
    () => pipeline._request({ model: 'x/y', messages: [] }, 'teste', 'openrouter'),
    /truncada/
  );
});

/* -------------------------------------------------------------- triagem */

test('triage no OpenRouter pede JSON pelo schema e lê as afirmações', async () => {
  const bodies = [];
  const api = {
    chat: async (cfg, body) => {
      bodies.push(body);
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                afirmacoes: [
                  {
                    texto: 'O Censo 2022 contou 203 milhões de habitantes.',
                    falante: 'candidato B',
                    tipo: 'checavel',
                    prioridade: 1,
                    tema: 'população',
                    porque: 'número verificável',
                    termos_busca: 'censo 2022',
                  },
                  {
                    texto: 'Este é o melhor governo da história.',
                    falante: 'candidato A',
                    tipo: 'opiniao',
                    prioridade: 3,
                    tema: 'avaliação',
                    porque: 'juízo de valor',
                    termos_busca: '',
                  },
                ],
                comentario: 'duas falas',
              }),
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 800, completion_tokens: 150, cost: 0.002 },
      };
    },
  };

  const pipeline = new NB.Pipeline({ store: store(), api });
  const out = await pipeline.triage({ id: 'w1', text: 'fala transcrita', tail: '', startedAt: Date.now() });

  assert.equal(out.claims.length, 2);
  assert.equal(out.claims[0].tipo, 'checavel');
  assert.equal(out.claims[1].tipo, 'opiniao');
  assert.equal(bodies[0].response_format.json_schema.name, 'triagem_debate');
  assert.equal(bodies[0].messages[0].role, 'system');
  assert.equal(bodies[0].tools, undefined, 'a triagem não deve gastar busca');
});

test('verify repete no automático quando a engine nativa recusa o filtro de domínios', async () => {
  const calls = [];
  const api = {
    chat: async (cfg, body) => {
      calls.push(body);
      if (body.tools) {
        const tool = body.tools[0];
        if (tool.parameters.engine === 'native') {
          const err = new Error('allowed_domains não é suportado pela busca nativa deste provedor');
          err.status = 400;
          throw err;
        }
        return searchResponse(ANNOTATION_OK);
      }
      return judgeResponse(VERDICT_OK);
    },
  };

  const s = store();
  s.state.searchEngine = 'native';
  const pipeline = new NB.Pipeline({ store: s, api });
  const out = await pipeline.verify(CLAIM);

  assert.equal(calls.length, 3);
  assert.equal(calls[0].tools[0].parameters.engine, 'native');
  assert.equal(calls[1].tools[0].parameters.engine, undefined);
  assert.deepEqual(Array.from(calls[1].tools[0].parameters.allowed_domains), OUTLETS);
  assert.equal(out.veredito, 'VERDADEIRO');
  assert.equal(out.fontes[0].status, 'confirmada');
});

test('isDomainRejection distingue filtro de domínio de ferramenta ausente', () => {
  const domains = new Error('allowed_domains is not supported');
  domains.status = 400;
  const tool = new Error('web_search server tool unsupported');
  tool.status = 400;
  assert.equal(NB.providers.isDomainRejection(domains), true);
  assert.equal(NB.providers.isDomainRejection(tool), false);
});

/* ------------------------------------------------------- transcrição (STT) */

test('transcriptText lê o texto em qualquer formato aceito pela API', () => {
  const T = NB.TabAudio.transcriptText;
  assert.equal(T({ text: '  olá  ' }), 'olá');
  assert.equal(T({ transcript: 'transcrito' }), 'transcrito');
  assert.equal(T({ output_text: 'saída' }), 'saída');
  assert.equal(T({ choices: [{ message: { content: 'chat' } }] }), 'chat');
  assert.equal(T({ choices: [{ message: { content: [{ text: 'par' }, { text: 'tes' }] } }] }), 'par tes');
  assert.equal(T({}), '');
  assert.equal(T(null), '');
});

test('sttPrice devolve o preço por segundo do modelo configurado', () => {
  assert.equal(NB.config.sttPrice({ sttModel: 'openai/whisper-1' }), 0.0001);
  assert.equal(NB.config.sttPrice({ sttModel: 'openai/whisper-large-v3-turbo' }), 0.00004);
  assert.equal(NB.config.sttPrice({ sttModel: 'modelo-desconhecido' }), 0.0001);
  assert.equal(NB.config.sttPrice({}), 0.0001);
});

test('o modelo padrão de transcrição está na lista de preços', () => {
  const defaults = NB.config.defaults();
  assert.ok(defaults.sttModel);
  assert.ok(NB.config.STT_MODELS.some((m) => m.id === defaults.sttModel));
  assert.equal(defaults.transcribeMode, 'mic');
  assert.ok(defaults.audioChunkSeconds >= 3);
});
