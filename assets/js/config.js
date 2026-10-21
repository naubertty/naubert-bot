/* naubert-bot · config.js
 * Definições de modelos, parâmetros da API e valores padrão.
 * Exposto em window.NB.config (scripts clássicos, funciona via file:// e via servidor).
 */
(function (global) {
  'use strict';
  var NB = (global.NB = global.NB || {});

  /* ---------------------------------------------------------------- modelos */

  /* Anthropic direto: IDs exatos do catálogo, sem sufixo de data. */
  var ANTHROPIC_MODELS = [
    { id: 'claude-opus-5-5', label: 'Opus 5.5', note: 'mais capaz · mais lento' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: 'equilíbrio' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5', note: 'mais rápido' },
    { id: 'claude-opus-5', label: 'Opus 5', note: 'geração anterior' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'geração anterior' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', note: 'compatível com filtro dinâmico' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'rápido, contexto menor' }
  ];

  /* OpenRouter: slugs com barra. A lista é só uma sugestão — o botão
   * "listar modelos" busca o catálogo real e aceita qualquer slug. */
  var OPENROUTER_MODELS = [
    { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5', note: 'padrão · melhor raciocínio' },
    { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5', note: 'equilíbrio' },
    { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5', note: 'rápido e barato' },
    { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6', note: 'geração anterior' },
    { id: 'openai/gpt-5.2', label: 'GPT-5.2', note: 'alternativa' }
  ];

  var STT_MODELS = [
    { id: 'openai/whisper-1', label: 'Whisper 1 · US$ 0,0001/s', note: 'barato e estável; bom em português' },
    { id: 'openai/whisper-large-v3', label: 'Whisper Large v3', note: 'mais preciso, mais lento' },
    { id: 'openai/whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo', note: 'rápido, precisão próxima do large' },
    { id: 'openai/gpt-4o-transcribe', label: 'GPT-4o Transcribe', note: 'melhor em nomes próprios e números' },
    { id: 'openai/gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe', note: 'barato com boa qualidade' },
    { id: 'google/chirp-3', label: 'Google Chirp 3', note: 'forte em áudio de transmissão' }
  ];

  // US$ por segundo de áudio enviado (referência de outubro de 2026).
  var STT_PRICES = {
    'openai/whisper-1': 0.0001,
    'openai/whisper-large-v3': 0.0001,
    'openai/whisper-large-v3-turbo': 0.00004,
    'openai/gpt-4o-transcribe': 0.0001,
    'openai/gpt-4o-mini-transcribe': 0.00005,
    'google/chirp-3': 0.0001
  };

  function sttPrice(cfg) {
    var model = (cfg && cfg.sttModel) || 'openai/whisper-1';
    return STT_PRICES[model] != null ? STT_PRICES[model] : 0.0001;
  }

  var SEARCH_ENGINES = [
    { id: 'auto', label: 'Automático (padrão)', note: 'busca nativa quando existe; com lista de domínios cai para Exa se o provedor não filtrar' },
    { id: 'native', label: 'Nativa do provedor', note: 'melhor com Claude/GPT/Grok; Gemini não aceita filtro de domínios (o app repete no automático)' },
    { id: 'exa', label: 'Exa', note: 'busca neural + palavra-chave; US$ 0,007 por requisição' },
    { id: 'parallel', label: 'Parallel', note: 'rápida; US$ 0,005 por requisição' },
    { id: 'perplexity', label: 'Perplexity', note: 'resultados ranqueados; US$ 0,005 por requisição' },
    { id: 'firecrawl', label: 'Firecrawl', note: 'cobra por resultado; recusada se você exige ZDR' }
  ];


  /* ------------------------------------------------- versões da web search */

  // web_search_20250305  -> busca básica, chamada direta, suportada por todos os modelos
  // web_search_20260209  -> acrescenta filtragem dinâmica (escreve e executa código)
  // web_search_20260318  -> acrescenta controle de response_inclusion
  var SEARCH_TOOLS = [
    {
      id: 'web_search_20250305',
      label: 'Busca básica (20250305)',
      note: 'chamada direta, compatível com todos os modelos, formato de resposta mais previsível'
    },
    {
      id: 'web_search_20260209',
      label: 'Filtro dinâmico (20260209)',
      note: 'gasta menos tokens, mas aninha os resultados dentro de code execution'
    },
    {
      id: 'web_search_20260318',
      label: 'Filtro dinâmico + response_inclusion (20260318)',
      note: 'igual à anterior, permite omitir blocos crus da resposta'
    }
  ];

  /* --------------------------------------------------------------- rótulos */

  var VERDICTS = {
    VERDADEIRO: {
      tone: 'true',
      label: 'VERDADEIRO',
      cssVar: '#22c55e',
      duotone: '#00e07a',
      blurb: 'confirmado por fontes da lista'
    },
    FALSO: {
      tone: 'false',
      label: 'FALSO',
      cssVar: '#ef4444',
      duotone: '#ff1744',
      blurb: 'contradito por fontes da lista'
    },
    ENGANOSO: {
      tone: 'misleading',
      label: 'ENGANOSO',
      cssVar: '#f59e0b',
      duotone: '#ffb020',
      blurb: 'tem algo de verdade, mas distorce'
    },
    FORA_DE_CONTEXT: {
      tone: 'context',
      label: 'FORA DE CONTEXTO',
      cssVar: '#a855f7',
      duotone: '#a855f7',
      blurb: 'o dado existe, mas não diz isso'
    },
    DESATUALIZADO: {
      tone: 'stale',
      label: 'DESATUALIZADO',
      cssVar: '#38bdf8',
      duotone: '#38bdf8',
      blurb: 'foi verdade, já não é'
    },
    NAO_VERIFICADO: {
      tone: 'unknown',
      label: 'NÃO VERIFICADO',
      cssVar: '#7c8899',
      duotone: '#7c8899',
      blurb: 'a busca restrita não resolveu'
    },
    ERRO: {
      tone: 'error',
      label: 'ERRO NA CHECAGEM',
      cssVar: '#94a3b8',
      duotone: '#94a3b8',
      blurb: 'falha técnica, tentar de novo'
    }
  };

  // Ordem de "força" — usada para decidir o que domina o duotone.
  var VERDICT_RANK = {
    FALSO: 5,
    ENGANOSO: 4,
    FORA_DE_CONTEXT: 3,
    DESATUALIZADO: 2,
    VERDADEIRO: 1,
    NAO_VERIFICADO: 0,
    ERRO: 0
  };

  /* -------------------------------------------------------------- defaults */

  var DEFAULTS = {
    // Provedor
    provider: 'openrouter',            // 'openrouter' | 'anthropic'

    // Conexão
    apiMode: 'proxy',                  // 'proxy' | 'direct'
    proxyBase: '',                     // vazio = mesma origem da página
    proxyToken: '',                    // só quando o servidor define PROXY_TOKEN
    apiKey: '',                        // Anthropic, modo 'direct'
    openrouterKey: '',                 // OpenRouter, modo 'direct'
    orReferer: '',                     // header HTTP-Referer (opcional)
    orTitle: 'naubert-bot',            // header X-Title (opcional)

    // Modelos
    model: 'anthropic/claude-opus-5.5',
    triageModel: 'anthropic/claude-haiku-5.5', // vazio = mesmo modelo
    judgeModel: '',                    // OpenRouter: modelo do julgamento (vazio = model)
    betaHeader: '',                    // Anthropic: ex.: 'structured-outputs-2025-11-13'

    // Busca
    searchEngine: 'auto',              // OpenRouter: auto | native | exa | parallel | perplexity | firecrawl
    maxResults: 5,                     // OpenRouter: resultados por busca
    searchTool: 'web_search_20250305', // Anthropic: versão da ferramenta
    maxUses: 4,
    responseInclusion: 'full',         // 'full' | 'excluded' (só 20260318)
    userLocation: {
      city: 'Lago Verde',
      region: 'Maranhão',
      country: 'BR',
      timezone: 'America/Sao_Paulo'
    },

    // Raciocínio (só Anthropic; no OpenRouter o modelo decide)
    thinkingTriage: 'none',            // 'none' | 'adaptive'
    thinkingVerify: 'adaptive',        // 'none' | 'adaptive'
    maxTokensTriage: 3000,
    maxTokensVerify: 8000,

    // Transcrição
    transcribeMode: 'mic',            // 'mic' (Web Speech) | 'tab' (captura da aba + Whisper)
    sttModel: 'openai/whisper-1',     // modelo do endpoint /audio/transcriptions
    audioChunkSeconds: 6,             // tamanho do trecho enviado quando é captura de aba
    lang: 'pt-BR',
    chunkChars: 260,
    chunkSeconds: 30,
    contextSentences: 2,

    // Pipeline
    minPriority: 2,
    concurrency: 2,
    dedupeWindow: 120,
    minClaimChars: 28,

    // Vídeo
    videoMode: 'embed',          // 'embed' | 'external'
    videoUrl: '',
    duotoneStrength: 0.85,
    duotoneHold: 14,             // segundos que o duotone fica ligado
    autoDuotone: true
  };

  /* --------------------------------------------------------------- preços */

  // US$ por 1 milhão de tokens [entrada, saída]. Usado só para estimar quando a
  // API não devolve o custo exato (o OpenRouter devolve).
  var PRICES = {
    'claude-opus-5-5': [4, 20],
    'claude-opus-5': [5, 25],
    'claude-opus-4-8': [5, 25],
    'claude-opus-4-7': [5, 25],
    'claude-opus-4-6': [5, 25],
    'claude-sonnet-5-5': [2, 10],
    'claude-sonnet-5': [2, 10],
    'claude-sonnet-4-6': [3, 15],
    'claude-haiku-5-5': [0.1, 0.5],
    'claude-haiku-4-5': [1, 5],
    'anthropic/claude-opus-5.5': [4, 20],
    'anthropic/claude-sonnet-5.5': [2, 10],
    'anthropic/claude-haiku-5.5': [0.1, 0.5],
    'anthropic/claude-sonnet-4.6': [3, 15]
  };

  function priceFor(provider, model) {
    if (PRICES[model]) return PRICES[model];
    var m = String(model || '').toLowerCase();
    if (/haiku/.test(m)) return [1, 5];
    if (/sonnet/.test(m)) return [3, 15];
    if (/opus/.test(m)) return [4, 20];
    if (/mini|flash|lite|free/.test(m)) return [0.5, 2];
    return [4, 20];
  }

  function searchPrice(cfg) {
    if (cfg && cfg.provider === 'openrouter' && cfg.searchEngine === 'exa') return 0.007;
    return 0.01;
  }

  /* ---------------------------------------------------------------- helper */

  function defaults() {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }

  NB.config = {
    PROVIDERS: [
      { id: 'openrouter', label: 'OpenRouter', note: 'uma chave para vários modelos' },
      { id: 'anthropic', label: 'Anthropic (direto)', note: 'precisa de chave da Anthropic' }
    ],
    ANTHROPIC_MODELS: ANTHROPIC_MODELS,
    OPENROUTER_MODELS: OPENROUTER_MODELS,
    MODELS: ANTHROPIC_MODELS, // compatibilidade
    SEARCH_ENGINES: SEARCH_ENGINES,
    STT_MODELS: STT_MODELS,
    sttPrice: sttPrice,
    SEARCH_TOOLS: SEARCH_TOOLS,
    PRICES: PRICES,
    priceFor: priceFor,
    searchPrice: searchPrice,
    modelPresets: function (provider) {
      return provider === 'anthropic' ? ANTHROPIC_MODELS : OPENROUTER_MODELS;
    },
    VERDICTS: VERDICTS,
    VERDICT_RANK: VERDICT_RANK,
    DEFAULTS: DEFAULTS,
    defaults: defaults,
    ANTHROPIC_VERSION: '2023-06-01',
    // Acima deste número de domínios a API pode devolver request_too_large.
    DOMAIN_WARN: 25,
    DOMAIN_HARD: 45
  };
})(window);
