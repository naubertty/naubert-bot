/* naubert-bot · config.js
 * Definições de modelos, parâmetros da API e valores padrão.
 * Exposto em window.NB.config (scripts clássicos, funciona via file:// e via servidor).
 */
(function (global) {
  'use strict';
  var NB = (global.NB = global.NB || {});

  /* ---------------------------------------------------------------- modelos */

  // IDs exatos conforme o catálogo atual da API da Anthropic.
  // Nunca acrescentar sufixo de data: "claude-opus-5-5", não "claude-opus-5-5-20260401".
  var MODELS = [
    { id: 'claude-opus-5-5', label: 'Opus 5.5', note: 'mais capaz · mais lento' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: 'equilíbrio' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5', note: 'mais rápido' },
    { id: 'claude-opus-5', label: 'Opus 5', note: 'geração anterior' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'geração anterior' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', note: 'compatível com filtro dinâmico' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'rápido, contexto menor' }
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
    // Conexão
    apiMode: 'proxy',            // 'proxy' | 'direct'
    proxyBase: '',               // vazio = mesma origem da página
    proxyToken: '',              // só quando o servidor define PROXY_TOKEN (servidor embutido)
    apiKey: '',                  // somente no modo 'direct'
    model: 'claude-opus-5-5',
    triageModel: '',             // vazio = usa o mesmo modelo
    betaHeader: '',              // ex.: 'structured-outputs-2025-11-13' se a conta exigir

    // Busca
    searchTool: 'web_search_20250305',
    maxUses: 4,
    responseInclusion: 'full',   // 'full' | 'excluded' (só 20260318)
    userLocation: {
      city: 'Lago Verde',
      region: 'Maranhão',
      country: 'BR',
      timezone: 'America/Sao_Paulo'
    },

    // Raciocínio
    thinkingTriage: 'none',      // 'none' | 'adaptive'
    thinkingVerify: 'adaptive',  // 'none' | 'adaptive'
    maxTokensTriage: 3000,
    maxTokensVerify: 8000,

    // Transcrição
    lang: 'pt-BR',
    chunkChars: 260,             // dispara a triagem ao acumular N caracteres
    chunkSeconds: 30,            // ...ou após N segundos sem término de frase
    contextSentences: 2,         // sobreposição de contexto entre janelas

    // Pipeline
    minPriority: 2,              // 1 = só as urgentes, 2 = urgentes + médias
    concurrency: 2,              // checagens simultâneas
    dedupeWindow: 120,           // segundos em que a mesma afirmação não é rechecada
    minClaimChars: 28,

    // Vídeo
    videoMode: 'embed',          // 'embed' | 'external'
    videoUrl: '',
    duotoneStrength: 0.85,
    duotoneHold: 14,             // segundos que o duotone fica ligado
    autoDuotone: true
  };

  /* ---------------------------------------------------------------- helper */

  function defaults() {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }

  NB.config = {
    MODELS: MODELS,
    SEARCH_TOOLS: SEARCH_TOOLS,
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
