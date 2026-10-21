# Decisões técnicas

Este documento registra o porquê de cada escolha — o que foi testado, o que foi descartado e onde estão
os pontos frágeis. Serve para quem for manter o projeto e para quem precisar defendê-lo numa redação.

---

## 1. Duas chamadas em vez de uma

A alternativa óbvia era uma chamada só: “transcreva, encontre as afirmações e verifique cada uma”.
Isso tem três problemas:

1. **Custo.** Para descobrir que 60% de um debate é opinião, você pagaria busca em tudo.
2. **Controle.** Com uma chamada só, não dá para cortar por prioridade, deduplicar nem mostrar o que foi
   descartado — e mostrar o descarte é parte do valor jornalístico.
3. **Formato.** A triagem devolve uma lista curta e estruturada; a verificação devolve veredito + fontes.
   Separar deixa cada schema pequeno, o que reduz erro de JSON e tempo de gramática compilada.

O custo é latência: duas idas à API em série. Na prática, a triagem leva 1–4 s e a verificação 3–12 s.
Com janelas de 30 s, o atraso total percebido fica entre 6 e 15 s — aceitável para um painel ao vivo,
inaceitável para legenda em tempo real. A tela mostra o número em cada cartão em vez de fingir instantaneidade.

## 2. Structured outputs e o fallback

As duas etapas usam `output_config.format` com um JSON Schema. Isso evita o clássico “o modelo devolveu
um JSON com vírgula sobrando” no meio de uma transmissão ao vivo.

Restrições do schema que o código respeita: `additionalProperties: false` em todos os objetos, todos os
campos em `required`, nada de `minimum`/`maxLength`/`maxItems` (não suportados), enum só de strings.
A validação de faixa (confiança entre 0 e 1, prioridade entre 1 e 3) é feita em JavaScript, não no schema.

Nem toda conta/modelo aceita structured outputs. Se a API devolver 400 citando `output_config`/`json_schema`,
`Pipeline._callSchema` repete a chamada **sem** o parâmetro e o `parseJsonLoose` extrai o objeto do texto.
A checagem continua; só perde a garantia de formato. O evento fica registrado no log do pipeline.

## 3. Por que `web_search_20250305` é o padrão

Há três versões da ferramenta:

| Versão | O que muda | Por que não é o padrão |
|---|---|---|
| `web_search_20250305` | busca básica, chamada direta | — |
| `web_search_20260209` | filtragem dinâmica: o modelo escreve código para filtrar resultados | aninha `server_tool_use` e `web_search_tool_result` dentro de blocos de execução de código |
| `web_search_20260318` | idem + `response_inclusion` | mesma complexidade, com um parâmetro a mais |

A versão básica devolve os resultados em blocos de primeiro nível, o que torna a auditoria trivial de
inspecionar e de depurar. As versões com filtragem dinâmica gastam menos tokens em buscas grandes, mas
exigem um percurso recursivo nos blocos — que a auditoria implementa e testa — e tornam o log menos legível.
Para uma checagem por afirmação, com 2–4 buscas, a economia de token não compensa o risco operacional.

**Detalhe que quebra silenciosamente:** nas versões `20260209+`, `allowed_callers` assume
`["code_execution_20260120"]`. Sem código no cliente, é preciso mandar `allowed_callers: ["direct"]`
ou a API devolve 400. O código faz isso automaticamente quando a versão selecionada é a nova.

## 4. A auditoria de fontes

O maior risco de um checador com LLM não é errar o veredito: é **inventar a fonte**. Uma URL plausível,
com domínio correto e slug convincente, passa por revisão humana apressada.

A API entrega três coisas que permitem verificar a proveniência:

- `server_tool_use.input.query` — o que o modelo pediu;
- `web_search_tool_result.content[]` — o que a busca devolveu, com URL, título e `page_age`;
- `citations[]` nos blocos de texto — o que o modelo efetivamente citou, com `cited_text` de até 150 caracteres.

A auditoria normaliza URLs dos dois lados (remove `www`, barra final, âncora e parâmetros de rastreio como
`utm_*`, `fbclid`, `gclid`), ordena a query string e compara. Se a URL não bater, tenta o título normalizado
(sem acento, sem pontuação). Só então decide entre `confirmada`, `nao_vista_na_busca` e `fora_da_lista`.

Duas sutilezas:

- **Citação vale como evidência.** A API só gera `web_search_result_location` a partir de um resultado que
  ela mesma entregou. Se o modelo citou formalmente, a URL esteve na busca.
- **Citação não é obrigatória.** Um modelo pode acertar a URL e não anexar a citação ao trecho. Exigir
  citação rebaixaria checagens corretas; por isso ela é reforço, não requisito.

Quando nenhuma fonte é confirmada, `enforceSourceRule` rebaixa o veredito para `NAO_VERIFICADO`. A regra
é deliberadamente conservadora: é melhor um cartão cinza “não verificado” do que um vermelho “falso”
sem lastro.

## 5. Deduplicação

O mesmo dado volta em várias janelas (“203 milhões”, “duzentos e três milhões”, “a população é 203 milhões”).
Sem dedupe, o painel repetiria a mesma checagem e o custo dobraria.

A comparação é por Jaccard sobre tokens normalizados (sem acento, sem stopwords, só termos com 3+ letras),
com corte em 0,62 e janela de 120 segundos. É simples de propósito: embeddings resolveriam paráfrases
melhores, mas custariam mais uma chamada por afirmação — o oposto do objetivo.

O dedupe é por texto, não por número. “203 milhões” e “213 milhões” têm Jaccard alto e podem ser fundidos
indevidamente se aparecerem em sequência. O corte de 0,62 foi escolhido para evitar isso na maioria dos casos,
mas é o ponto mais frágil do pipeline. Para produção, vale comparar também os números extraídos.

## 6. Segmentação da transcrição

A Web Speech API entrega resultados finais em pedaços curtos e irregulares, e o Chrome encerra o
reconhecimento após alguns segundos de silêncio. O `Speech` reinicia sozinho (`onend` → `start`) enquanto
o usuário não pedir para parar; erros `no-speech` e `aborted` são ignorados.

O `Segmenter` fecha janelas por dois critérios concorrentes:

- **tamanho** (260 caracteres) — mantém o custo previsível;
- **tempo** (30 s) — evita que uma pausa longa deixe texto preso.

Cada janela carrega um “rabo” com as duas últimas frases da janela anterior. Isso resolve o caso clássico
de afirmação cortada no meio (“...e por isso o número é” / “duzentos e três milhões”), sem reenviar o
contexto inteiro.

O reconhecimento não identifica falantes. A triagem recebe “não identificado” e o prompt proíbe inventar
nomes; quando o modelo infere “candidato A/B” pelo conteúdo, isso é uma inferência, não diarização.
Para operação séria, o caminho é importar legendas oficiais ou usar um serviço com separação de falantes.

## 7. Duotone

A implementação é CSS puro, como pedido:

```css
.video-media iframe { filter: grayscale(1) contrast(1.1) brightness(.84); }
.video-tint { background: var(--tone); mix-blend-mode: color; opacity: var(--tone-strength); }
```

`mix-blend-mode: color` aplica matiz e saturação mantendo a luminância do vídeo — é o que dá o efeito de
duotone “de verdade”, e não uma camada translúcida por cima. Uma segunda camada em `soft-light` escurece
os tons médios e dá peso. `isolation: isolate` no frame contém o blend.

O overlay e a moldura ficam fora da camada de blend, então o cartão de veredito mantém o contraste.
Quando não há vídeo (placeholder), o efeito continua visível, o que permite testar a tela sem transmissão.

O `prefers-reduced-motion` desliga as animações e o duotone pode ser desligado nas configurações.

## 8. Globo Play e a janela flutuante

Não existe forma legítima de incorporar o player da Globo Play em outra página. As alternativas reais eram:

1. capturar a tela e aplicar o duotone em canvas — viola termos de uso e DRM, e quebra com qualquer
   mudança do player;
2. abrir a Globo Play numa janela e a checagem em outra — simples, mas o veredito fica longe do vídeo;
3. **Document Picture-in-Picture** — uma janela do próprio Chrome, sempre à frente, com o veredito.

A terceira opção é a que mais se aproxima de “sobrepor ao vídeo” sem tocar no player. O documento PiP é
independente: o CSS é injetado inline e o conteúdo é reconstruído a cada resultado. A API exige gesto do
usuário e contexto seguro (https ou localhost).

Para YouTube, o embed é a opção mais direta e permite o duotone no iframe. O `youtube-nocookie.com` evita
cookie de rastreamento até o play.

## 9. Chave da API: proxy por padrão

Chamar `api.anthropic.com` direto do navegador funciona com o header
`anthropic-dangerous-direct-browser-access: true`, mas exige a chave no cliente. Em qualquer transmissão
isso é inaceitável: a chave vaza em devtools, extensão ou print de tela.

O `server.js` faz o proxy e é o modo padrão. Ele não tem dependências (Node 18+), limita o corpo a 8 MB,
tem rate limit por IP (90/min), bloqueia `.env`, `.git`, `node_modules` e traversal, e não registra conteúdo.
O modo direto continua disponível para teste local, com aviso explícito na interface.

## 10. Custo

O contador soma tokens de entrada (incluindo cache), saída e buscas, com preços de outubro de 2026:
Opus 5.5 a US$ 4/US$ 20 por milhão, Sonnet 5.5 a US$ 2/US$ 10, Haiku 5.5 a US$ 0,10/US$ 0,50 e US$ 0,01 por busca.

Ordem de grandeza de uma checagem com Opus 5.5: 2–3 mil tokens de entrada (system + ferramenta + trecho),
600–1.200 de saída (o raciocínio adaptativo conta como saída) e 1–2 buscas → **US$ 0,03 a US$ 0,06**.
Um debate de duas horas com 40 checagens reais fica entre US$ 1,50 e US$ 2,50.

Se o custo importar, a alavanca mais eficiente é usar Haiku 5.5 só na triagem (que é a maior parte das
chamadas) e manter Opus na verificação. A segunda é reduzir `maxUses`.

## 11. O que foi validado

- **36 testes de unidade** (`npm test`) sobre normalização de domínio, regra de subdomínio, extração de
  evidências (incluindo blocos aninhados da filtragem dinâmica e `url_citation` do OpenRouter), detecção de
  fonte inventada, comparação com `www`/barra/UTM, rebaixamento de veredito, normalização de strings de
  veredito e os fallbacks do OpenRouter (sem server tool, sem structured outputs, engine sem filtro).
- **Teste de integração em DOM real (jsdom)** com respostas gravadas da API: boot, health check, catálogo
  de modelos, troca de provedor, entrada manual, triagem, busca, julgamento, auditoria, cartão, flash,
  duotone e custo — 25 verificações no roteiro do OpenRouter (31 no roteiro da Anthropic), zero erro de
  console. O script desse teste não é versionado porque depende de jsdom instalado à parte; o roteiro está
  descrito aqui e pode ser recriado.
- **Smoke test do servidor**: health, estáticos, MIME, bloqueio de `.env`, traversal, erro de configuração
  sem chave e 404 de rota de API.

Não foi possível testar com a API real neste ambiente (sem chave), nem com microfone. Os formatos de
resposta seguem a documentação oficial de `web_search_20250305` a `20260318`, structured outputs e
`pause_turn`. O primeiro teste com chave real deve ser feito com `max_uses: 1` e uma afirmação simples,
para conferir a auditoria no log antes de rodar ao vivo.

## 12. O que eu mudaria com mais tempo

1. **Comparação numérica estruturada** no dedupe, para não fundir “203” com “213”.
2. **Streaming da verificação** para mostrar as buscas acontecendo (“buscando em g1…”) em vez de um cartão
   “checando” parado.
3. **Fila de revisão humana**: um botão “aprovar para o ar” antes de o cartão entrar na saída pública.
4. **Memória do debate**: índice das afirmações já checadas por tema, com contador de repetição.
5. **Teste com legendas oficiais** em vez de microfone, o que elimina a maior fonte de erro.
6. **Múltiplas listas de veículos por programa**, com a lista exibida no ar junto do veredito.
7. **Cache de verificação** por hash da afirmação normalizada + lista de domínios, para reprises.

## 13. OpenRouter como provedor padrão

O pedido mudou no meio do caminho: a chave disponível é do OpenRouter, não da Anthropic. Em vez de jogar
fora o caminho Anthropic (que é o mais simples e continua útil), o transporte foi separado do raciocínio:

```
client.js      -> só HTTP (endpoint, headers, erro traduzido)
providers.js   -> o que cada API precisa: payload, formato de evidência, extração do texto
pipeline.js    -> fila, dedupe, concorrência, custo, auditoria
```

Cada provedor implementa `triage(ctx)`, `verify(ctx)` e `usageOf(res)`. O pipeline não sabe qual está em
uso — só chama `NB.providers.get(cfg)`.

**A verificação no OpenRouter tem duas chamadas, não uma.** A documentação de structured outputs e a de
server tools não se combinam: quando o `response_format` com `json_schema` entra na mesma requisição da
busca, o provedor deixa de devolver as anotações `url_citation` — e sem anotação não existe auditoria,
porque não existe a lista de URLs que voltaram da busca. A saída foi separar:

1. **busca** — texto livre + `tools: [{type: 'openrouter:web_search', parameters: {allowed_domains, …}}]`
   + `max_tool_calls: 4`. A resposta traz `message.annotations[]`.
2. **julgamento** — texto + a lista **fechada** de URLs encontradas + `response_format` com schema estrito.
   Sem `tools`, para não haver busca nova.

Isso custa uma chamada a mais por afirmação (mais ou menos 1–2 s e uns centavos), mas é o que mantém a
garantia central do projeto: o veredito só é confirmado com fonte que veio da busca restrita. A lista
fechada no julgamento também reduz a chance de o modelo inventar uma URL, porque ele não tem para onde
inventar — as opções estão todas ali.

**Fallbacks em cascata**, cada um com log na tela:

| Falha | Reação |
|---|---|
| endpoint recusa structured outputs | repete o julgamento sem schema e lê o JSON de forma tolerante |
| endpoint recusa a server tool de busca | repete com o plugin legado `{"id":"web", "include_domains":[…]}` |
| engine não aceita `allowed_domains` (busca nativa em endpoint Google) | repete a busca sem `engine`, no automático, que passa a usar a Exa por causa da lista |
| busca volta sem anotação | segue para o julgamento com evidência vazia; a auditoria rebaixa para NÃO VERIFICADO |

**Custo:** o OpenRouter devolve `usage.cost` em toda resposta; quando existe, ele tem prioridade sobre a
estimativa de tabela. A estimativa em `config.js` (US$ 4/US$ 20 por milhão para o Opus 5.5; US$ 0,01 por
busca, US$ 0,007 na Exa) serve para quando o campo não vem.

**Listagem de modelos:** o catálogo do OpenRouter tem dezenas de milhares de linhas, então não vai inteiro
para o navegador. O proxy `/api/openrouter/models` filtra por `q`, ordena por `created`, corta em 100 e
devolve só `id`, `name`, `context_length` e preço. O resultado é cacheado por 10 minutos no servidor.

## 14. Captura da aba em vez de microfone

O pedido chegou assim: "não está transcrevendo com precisão; tem como ouvir direto da página, sem ser
pelo microfone?". A resposta honesta é que **a Web Speech API não aceita um `MediaStream`**: ela sempre
lê o dispositivo de entrada padrão do sistema. Não existe truque de JavaScript que aponte o
`SpeechRecognition` para o som de uma aba.

Restavam três caminhos:

1. **loopback no sistema operacional** (VB-Cable, Mixagem estéreo) — a aba passa a ser a "entrada";
2. **capturar a aba com `getDisplayMedia` e transcrever fora do navegador**;
3. baixar um Whisper em WASM (~80–250 MB de modelo, mais lento que tempo real em CPU).

Escolhemos o 2, com o Whisper do OpenRouter, porque a chave já estava configurada e não há dependência
nova. O caminho 1 continua documentado como alternativa de melhor qualidade (a Web Speech é instantânea
e gratuita).

**Desenho da captura.** `getDisplayMedia` exige vídeo para abrir o seletor; o vídeo é descartado no
primeiro instante e só a faixa de áudio permanece. O áudio passa por um `AudioContext`, com uma cópia
para o `AnalyserNode` (medidor e detecção de silêncio) e outra para um `MediaStreamAudioDestinationNode`,
que é o que o `MediaRecorder` grava.

**Um recorder por trecho.** `MediaRecorder.start(timeslice)` produz fragmentos WebM que não são arquivos
válidos sozinhos — o header aparece só no primeiro. Por isso cada trecho de N segundos tem seu próprio
`MediaRecorder`: `start()`, espera N segundos, `stop()`, e o `Blob` resultante é um WebM completo e
decodificável. É mais caro em alocação e irrelevante em escala de 6 s.

**Silêncio não é enviado.** Um `setInterval` amostra o RMS a cada 100 ms; se o pico do trecho não passa
do limiar, ele é descartado antes de virar chamada de API. Em um debate com pausas isso corta uma parte
real do custo.

**O texto volta para o mesmo lugar.** `speech.feed(texto)` empurra a transcrição para o segmentador que
já existia — janelas de 260 caracteres/30 s, contexto das últimas frases, dedupe, fila. Nada do pipeline
mudou: a única diferença é que o texto entrou pelo Whisper e não pela Web Speech.

**Custo e privacidade.** O áudio vai para o OpenRouter (o mesmo destino das checagens) e não é gravado em
disco em nenhum momento: o `Blob` morre depois do envio. O modelo padrão é o Whisper 1, a US$ 0,0001 por
segundo — US$ 0,0006 por trecho de 6 s. O `usage.cost` da resposta, quando vem, tem prioridade sobre a
estimativa da tabela.

## 15. 402 não é erro de código

O primeiro teste real do usuário com captura de aba devolveu `402 — Insufficient credits`. A tentação é
tratar como falha técnica e seguir tentando; o certo é parar e dizer o que fazer.

Três decisões:

1. **consultar o saldo antes**, em `GET /api/v1/key` (não gasta crédito). O endpoint devolve uso do dia,
   da semana, do mês e — se a chave tiver teto — o quanto resta. Se `limit_remaining` for zero, o aviso
   aparece no boot, antes de qualquer tentativa;
2. **402 e 401 param tudo**: a captura de áudio encerra e a fila de checagens é esvaziada (`aborted`),
   porque cada trecho ou afirmação seguinte receberia o mesmo erro. Um `emit('blocked')` avisa a interface
   uma única vez;
3. **a mensagem é específica**, lendo `error.metadata.limit_source` do OpenRouter:
   `openrouter_key_limit` (teto da chave) e `openrouter_in_flight_budget` (gasto simultâneo) pedem ações
   diferentes de saldo zerado na conta.

A faixa no topo tem o link direto e um botão para consultar o saldo de novo — o usuário não precisa
descobrir o caminho no console.

## 16. Gemini como provedor padrão: a busca não aceita filtro de domínio

Trocar o provedor padrão para o Gemini parecia só mais um adaptador. Esbarrou em duas paredes.

**Parede 1 — `allowed_domains` não existe.** O grounding do Google Search na Gemini Developer API aceita
`tools:[{google_search:{}}]` e nada mais. `excludeDomains` (e o `includeDomains` simétrico) só existem no
Vertex AI / Enterprise; mandar o campo para `generativelanguage.googleapis.com` devolve
`400 INVALID_ARGUMENT: Unknown name "excludeDomains"`. A pesquisa restrita, então, tem duas camadas:

1. a lista de veículos entra **no prompt** da busca, como prioridade explícita;
2. a lista é aplicada **na auditoria** — fonte cujo domínio não está nela vira `fora_da_lista` e o
   veredito é rebaixado, exatamente como acontece quando o OpenRouter ignora o filtro.

Isso é mais fraco do que o `allowed_domains` da Anthropic/Exa (o modelo pode trazer fonte de fora), mas é
**verificável**: a auditoria continua sendo a autoridade final. O sistema prefere rebaixar a confiar.

**Parede 2 — a URL do grounding não é a URL do veículo.** `groundingChunks[i].web.uri` é um
redirecionador `vertexaisearch.cloud.google.com/grounding-api-redirect/…`; o domínio do veículo vem em
`web.title`. Com a auditoria antiga, `hostOf(url)` nunca casava com a lista e **toda** fonte do Gemini
seria reprovada. A correção tem duas partes:

- o adaptador guarda os dois campos (`url` para o link, `domain` para a lista);
- `auditSources` monta um mapa `url → domain` a partir da evidência e, quando a fonte declarada pelo
  modelo é um redirect conhecido, usa esse domínio para `domainOk` — mantendo o link original no cartão.

**Por que duas chamadas.** Pedir JSON estruturado junto com `google_search` faz o modelo suprimir as
anotações de grounding, e sem elas não há o que auditar. A checagem vira: (1) busca com a ferramenta,
texto livre, priorizando os veículos; (2) julgamento sem ferramenta, com `responseSchema` e a lista
fechada de fontes que voltaram. É o mesmo desenho já usado no OpenRouter, por motivo parecido.

**Faturamento é requisito, não detalhe.** Grounding não funciona no nível gratuito; a assinatura Google AI
Pro é do site do AI Studio e não gera chave de API. Sem billing no projeto, a chamada falha com
`groundingMetadata` ausente ou erro explícito — o adaptador reconhece os dois casos e para com
`e.grounding = true`, mensagem própria e sem ficar repetindo. A interface avisa isso na tela de
configurações, com o custo real: 5.000 buscas/mês grátis com billing ativo, depois US$ 14/1.000.

**Preços usados na estimativa.** Flash 3.8 a 0,75/3,75 por 1M (entrada/saída, até 31/12/2026); triagem no
Flash-Lite 3.1 a 0,25/1,50; `thoughtsTokenCount` conta como saída. Uma checagem com busca dá US$ 0,02–0,04.

**A transcrição também passou a ter caminho próprio.** No modo *áudio da aba*, o trecho vai inline no
`generateContent` com `inline_data` — assim, quem só tem chave do Gemini não fica dependente do saldo do
OpenRouter, que era exatamente o problema que motivou a troca. O servidor normaliza a resposta para
`{text, usage}`, então o resto do `audio.js` não mudou.

**Configuração salva vence padrão novo.** Trocar `DEFAULTS.provider` não muda nada para quem já abriu o app:
o `localStorage` guarda `provider: 'openrouter'` e o merge usa o que está salvo. Por isso entrou uma
migração versionada (`settingsVersion` em `store.js`): estado sem versão e com o provedor/modelos antigos
intocados é reescrito para o Gemini na primeira abertura; quem já tinha trocado o modelo à mão fica onde
está. A migração roda uma vez e grava o resultado — sem isso, o usuário veria a tela antiga, com a faixa de
crédito do OpenRouter, mesmo depois de atualizar.

## 17. A escala de vereditos veio do InTruth

O InTruth (extensão de Chrome para o mesmo problema) usa cinco rótulos: TRUE, SUBSTANTIALLY TRUE, FALSE,
MISLEADING e UNVERIFIABLE. O conjunto é melhor que o anterior por um motivo prático: **separa "errado" de
"certo com ressalva"**. Um debate quase nunca mente por inteiro; o caso comum é o número certo com a
unidade trocada, ou o dado certo com o recorte errado. Antes, isso caía em ENGANOSO junto com distorções
graves; agora tem degrau próprio.

Decisões:

1. **Nomes em português, chaves estáveis em caixa alta.** `SUBSTANCIALMENTE_VERDADEIRO` é o que vai no
   schema e no `data-verdict`; o rótulo visível é "SUBSTANCIALMENTE VERDADEIRO".
2. **`FORA_DE_CONTEXT` e `DESATUALIZADO` viraram `ENGANOSO`.** Nos dois, o dado existe e o que falha é a
   conclusão — que é a definição de enganoso. Configuração/JSON antigos continuam funcionando por alias.
3. **A auditoria não muda.** Qualquer veredito que afirme algo (as duas verdades, enganoso, falso) exige
   fonte confirmada na busca; sem isso, rebaixa para NÃO VERIFICADO. O novo degrau não abriu exceção.
4. **A cor continua binária no vídeo.** Verde para verdadeiro e substancialmente verdadeiro, âmbar para
   enganoso e vermelho para falso. Não verificado não pinta o vídeo — ausência de cor é a mensagem.
