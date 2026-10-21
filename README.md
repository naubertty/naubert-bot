# naubert-bot

Checagem de fatos **ao vivo** para debates. A página transcreve a fala pelo microfone, separa o que é
afirmação checável do que é opinião, verifica cada afirmação com busca restrita a uma lista de veículos
de imprensa e mostra o resultado **sobre o vídeo**, com um duotone verde ou vermelho e a matéria citada.

A API é a do **[OpenRouter](https://openrouter.ai)** por padrão — uma chave `sk-or-v1-…` dá acesso a
Claude, GPT e Gemini. A Anthropic direta continua disponível como alternativa.

```
 microfone ──► Web Speech API ──► janelas de transcrição
                                        │
                                        ▼
                              triagem (Claude Haiku)  ──► opinião / previsão / promessa: descartadas
                                        │
                                        ▼
              verificação em duas fases, com busca restrita por allowed_domains
                     fase 1: busca (openrouter:web_search)  ──► citações reais
                     fase 2: julgamento com lista fechada   ──► veredito + fonte
                                        │
                                        ▼
                    auditoria: a URL citada veio mesmo da busca?
                                        │
                         sim ───────────┴─────────── não
                          │                          │
                    veredito mantido          rebaixado para NÃO VERIFICADO
                          │
                          ▼
             duotone no vídeo + cartão + fonte
```

---

## Como rodar na sua máquina

### Você precisa de

| Item | Detalhe |
|---|---|
| **Node.js 18+** | [nodejs.org](https://nodejs.org) — confira com `node -v`. O projeto **não tem dependências**, então não é preciso `npm install`. |
| **Chrome ou Edge** no desktop | A Web Speech API não existe no Firefox nem no Safari. No celular, o Chrome também não transcreve de forma confiável. |
| **Chave do OpenRouter** | Em [openrouter.ai/workspaces/default/keys](https://openrouter.ai/workspaces/default/keys) → *Create key*. É paga por uso: uma checagem custa alguns centavos de dólar (veja [Custo](#modelos-custo-e-configuração)). |
| **Microfone** | Ou use **entrada manual**: cole o trecho falado no campo de texto e ele segue o mesmo pipeline. |

### Passo a passo

**1. Baixe o projeto e entre na pasta**

O código desta versão está no branch `arena/611d6f36-naubert-bot` (a `main` do repositório ainda tem só o
README). Clone já apontando para ele:

```bash
git clone -b arena/611d6f36-naubert-bot https://github.com/naubertty/naubert-bot.git
cd naubert-bot
```

Sem Git? No GitHub, troque o seletor de branch para `arena/611d6f36-naubert-bot`, depois
**Code → Download ZIP** e descompacte.

**2. Crie o arquivo `.env`**

macOS e Linux:

```bash
cp .env.example .env
```

Windows (Prompt de Comando ou PowerShell):

```bat
copy .env.example .env
```

**3. Coloque sua chave dentro do `.env`**

Abra o arquivo num editor de texto e deixe a linha assim — sem aspas, sem espaço depois do `=`:

```
OPENROUTER_API_KEY=sk-or-v1-...
```

O `.env` fica só na sua máquina (`/.gitignore` já o exclui) e **nunca é enviado ao navegador**: o
`server.js` guarda a chave e faz o proxy das chamadas.

Se você tiver só uma chave da Anthropic, preencha `ANTHROPIC_API_KEY=sk-ant-…` e escolha o provedor
**Anthropic (direto)** nas configurações — tudo o mais funciona igual.

**4. Suba o servidor**

```bash
npm start
```

Saída esperada:

```
  naubert-bot · checagem ao vivo
  http://localhost:8787

  OpenRouter:  sk-or-v1-…abcd
  Anthropic:   ausente (opcional)
```

Essa janela do terminal precisa ficar aberta. `Ctrl+C` encerra.

**5. Abra no Chrome**

```
http://localhost:8787
```

Não abra o `index.html` com dois cliques (`file://`): sem servidor o proxy não funciona e o microfone
fica bloqueado.

**6. Faça o teste de fumaça (sem gastar API)**

- Clique em **Simulação** → a tela inteira se mexe: transcrição, cartões, duotone, fonte.
- Abra **Configurações → testar conexão** → deve aparecer “proxy ativo · openrouter · chave sk-or-v1-…”.

**7. Configure para o debate de verdade**

Em **Configurações**:

1. cole o **link do vídeo** (YouTube renderiza embutido; Globo Play abre em janela externa);
2. revise a **lista de veículos** (presets prontos, ou cole os seus domínios);
3. confira o **modelo** — `anthropic/claude-opus-5.5` é o padrão e
   `anthropic/claude-haiku-5.5` faz a triagem. O botão **listar modelos** busca o catálogo do OpenRouter
   e preenche o campo com os preços;
4. escolha a **engine de busca** (`automático` já usa a busca nativa do Claude) e quantos resultados
   por busca;
5. **salvar**.

De volta à tela, clique em **Iniciar escuta** e autorize o microfone. Se estiver usando a Globo Play,
clique em **janela flutuante** e arraste a janelinha para cima do vídeo.

### Se algo der errado

| Situação | O que fazer |
|---|---|
| `npm: command not found` | Instale o Node em [nodejs.org](https://nodejs.org) e reabra o terminal. |
| `Port 8787 already in use` | Use outra porta: `PORT=9090 npm start` (mac/Linux), `set PORT=9090 && npm start` (cmd) ou `$env:PORT=9090; npm start` (PowerShell). Depois abra `http://localhost:9090`. |
| `OpenRouter: AUSENTE` no terminal | O servidor imprime logo abaixo o caminho exato do `.env` que ele procurou. Se o arquivo estiver em outra pasta (típico de ZIP extraído duas vezes, pasta dentro de pasta), crie o `.env` ao lado do `package.json` e do `server.js`. O `.env` é **lido só ao iniciar**: edite e rode `npm start` de novo. |
| “proxy inacessível” na página | O terminal do `npm start` foi fechado — suba de novo. |
| Microfone bloqueado | Permita no cadeado da barra de endereço. Se a página estiver dentro de um preview embutido, abra em aba própria. |
| Nada é transcrito | Primeiro clique em **testar microfone** (ao lado de *checar janela*). Se o medidor não mexer, o áudio não está chegando no navegador — veja o item abaixo. Se mexer e mesmo assim não sair texto, o problema é o serviço de reconhecimento do Google: abra `google.com` nesta mesma aba; VPN, DNS que filtra `google.com` e extensões bloqueadoras são as causas comuns. Enquanto isso, use **entrada manual**. |
| Microfone ouve a sala, não o vídeo | O reconhecimento escuta o microfone, não a aba. Com fone de ouvido não há o que transcrever. No Windows, habilite **Mixagem estéreo** (Painel de Controle → Som → Gravação → clique direito no espaço vazio → *Mostrar dispositivos desativados* → ative) e escolha esse dispositivo como entrada: o áudio do vídeo vai direto para o Chrome, sem ruído da sala e sem cancelamento de eco. |
| Transcrição atrasada ou picada | A janela fecha em 260 caracteres ou 30 s. Diminua `chunkChars` nas configurações para 140 se o debate for rápido; o custo é mais chamadas. |
| 401 na checagem | Chave inválida ou revogada: gere outra em [openrouter.ai/workspaces/default/keys](https://openrouter.ai/workspaces/default/keys) e atualize o `.env`. |
| 402 na checagem | Sem créditos no OpenRouter. Recarregue em [openrouter.ai/credits](https://openrouter.ai/credits) ou troque para um modelo mais barato na triagem. |

### Sobre a transcrição

Para testar com o microfone conhecido:

1. **Testar microfone** mede 10 s e mostra no aviso o pico e o nome do dispositivo;
2. **Iniciar escuta** liga o mesmo medidor ao lado dos botões da transcrição, em tempo real.

Se o medidor fica no zero e o vídeo está tocando, o problema é de captura (dispositivo errado, mudo, ou
fone de ouvido). Se o medidor mexe e nada aparece escrito, o problema é a conversa do Chrome com os
servidores de reconhecimento do Google — o app tenta de novo até 5 vezes antes de avisar.

### Onde ficam as configurações

- **Chave da API e porta** → `.env`, na pasta do projeto (só no servidor).
- **Provedor, modelo, engine de busca, veículos, ritmo, vídeo, duotone** → `localStorage` do seu navegador,
  por navegador e por perfil. O botão **restaurar padrões** nas configurações volta tudo ao início.

### Rodar os testes

```bash
npm test       # 36 testes da auditoria, do pipeline e do adaptador do OpenRouter
npm run check  # sintaxe de todos os arquivos + testes
```

---

## O que a tela faz

| Etapa | O que acontece | Onde está no código |
|---|---|---|
| Transcrição | O Chrome transcreve a fala; o segmentador fecha janelas de ~260 caracteres ou 30 s, o que vier primeiro, e guarda as últimas frases como contexto | `assets/js/speech.js` |
| Triagem | O Claude recebe o trecho e devolve afirmações classificadas como `checavel`, `opiniao`, `previsao`, `promessa`, `pergunta` ou `ataque_pessoal`, com prioridade de 1 a 3 | `assets/js/pipeline.js` |
| Verificação | Cada afirmação checável vira uma busca limitada por `allowed_domains` à sua lista de veículos, seguida de um julgamento com a lista fechada de URLs encontradas | `assets/js/providers.js` |
| Auditoria | Confere se cada URL citada apareceu nos resultados da busca, se o domínio está na lista e se o modelo a citou | `assets/js/audit.js` |
| Resultado | Duotone no vídeo, cartão sobreposto, lista lateral com fonte, trecho, confiança e latência | `assets/js/ui.js` |
| Custo | Contador de chamadas, buscas e custo em dólar (usa o `usage.cost` do OpenRouter quando existe) | `assets/js/pipeline.js` |

A triagem e a verificação são **chamadas separadas** — é isso que permite descartar opinião antes de
gastar uma busca, e é isso que torna o sistema mais lento que um “detector” instantâneo.

### Os vereditos

| Veredito | Cor | Significado |
|---|---|---|
| **VERDADEIRO** | verde | o dado confere com a fonte, no período e no recorte citados |
| **FALSO** | vermelho | a fonte contradiz o dado, ou o dado não existe |
| **ENGANOSO** | âmbar | há um núcleo verdadeiro, mas o número ou a conclusão distorcem a fonte |
| **FORA DE CONTEXTO** | roxo | o dado existe, mas é de outro período, local, população ou indicador |
| **DESATUALIZADO** | azul | era verdade e foi revisado ou superado |
| **NÃO VERIFICADO** | cinza | as fontes permitidas não permitem concluir |
| **ERRO** | cinza | falha técnica; o cartão tem botão de rechecar |

---

## OpenRouter (padrão) e Anthropic direta

A interface da página é a mesma; o que muda é o transporte e o formato da busca.

| | OpenRouter | Anthropic direto |
|---|---|---|
| Endpoint | `POST /api/v1/chat/completions` (formato OpenAI) | `POST /v1/messages` |
| Chave | `sk-or-v1-…` (dá acesso a vários modelos) | `sk-ant-…` |
| Busca | ferramenta `openrouter:web_search` | ferramenta `web_search_20250305` |
| Filtro | `allowed_domains` nos parâmetros da ferramenta | `allowed_domains` na definição da ferramenta |
| Citações | `message.annotations[]` (`url_citation`) | blocos `web_search_tool_result` |
| Chamadas por afirmação | **duas**: busca e depois julgamento | uma |

No OpenRouter a verificação é dividida em duas chamadas porque structured outputs e busca na mesma
requisição fazem o provedor **suprimir as anotações** de citação — e sem anotação não há auditoria. Então:

1. **busca** — o modelo recebe a afirmação e a ferramenta de busca restrita; devolve um resumo em texto
   com `url_citation` para cada fonte que usou. Nada de JSON nesta chamada.
2. **julgamento** — o modelo recebe o resumo, as fontes e só as URLs que voltaram da busca (lista fechada)
   e devolve o veredito em JSON validado por schema.

Se o endpoint recusar a server tool (`400`/`404`/`422` falando de `tool`), o código repete a busca com o
plugin legado `{"id":"web", "include_domains":[...]}`, que também devolve `url_citation`. Se a conta recusar
structured outputs, o julgamento é repetido sem schema e o JSON é lido de forma tolerante.

### Engines de busca

O campo **engine** decide quem executa a busca no OpenRouter:

| Engine | Custo por busca | Observação |
|---|---|---|
| `automático` | conforme a escolhida | usa a busca nativa do modelo; sem busca nativa, cai para Exa |
| `nativa do provedor` | preço do provedor | melhor resultado com Claude/GPT/Grok; a busca nativa do **Gemini não aceita filtro de domínios** — nesse caso o app repete a busca no automático (que usa Exa por causa da lista) |
| `exa` | US$ 0,007 | neural + palavra-chave, devolve trechos (`highlights`) |
| `parallel` | US$ 0,001–0,005 | rápida |
| `perplexity` | US$ 0,005 | resultados ranqueados |
| `firecrawl` | US$ 0,005 + por resultado | recusada se a conta exigir ZDR |

`allowed_domains` é respeitado pela Exa, Parallel, Firecrawl, Perplexity e pela busca nativa da Anthropic/OpenAI/Grok.
Quando o endpoint escolhido não filtra (caso típico: Claude roteado para o Google Vertex), a API devolve 400 e
o app repete a busca sem `engine`, no automático, que passa a usar a Exa porque há lista de domínios.

---

## Por que não é instantâneo

Uma checagem leva tipicamente **6 a 15 segundos**:

- triagem: 1–4 s;
- busca: 2–8 s, dependendo de quantas buscas o modelo decide fazer;
- julgamento: 1–4 s;
- com `concurrency: 2`, duas afirmações rodam em paralelo, mas a ordem da fila prioriza o que é central no debate.

O atraso entre a fala e o veredito aparece em cada cartão (`9,2 s após a fala`). Se você diminuir a janela
para 120 caracteres, o resultado chega mais rápido — ao custo de menos contexto, mais chamadas e mais
chances de erro de transcrição. O padrão (260 caracteres / 30 s) é o equilíbrio que ficou melhor no teste.

Nada aqui reescreve a fala: a janela é fechada, vai para a fila e o resultado chega depois. A tela foi
desenhada para deixar esse atraso explícito, não para escondê-lo.

---

## Globo Play, YouTube e a janela flutuante

A Globo Play **não permite incorporar o player em outra página** (DRM + termos de uso). O projeto não
tenta contornar isso — não há captura de tela, nem leitura do player, nem scraping.

Há três formas de usar:

1. **YouTube incorporado** — cole a URL do vídeo nas configurações. A página toca o vídeo em
   `youtube-nocookie.com` e aplica o duotone por cima.
2. **Janela flutuante** (Chrome 116+) — deixe o debate na Globo Play e clique em **janela flutuante**.
   O veredito vai para uma janela Picture-in-Picture que fica sempre à frente dos outros aplicativos,
   com a cor do veredito, a fonte e a explicação. É o modo mais próximo de uma sobreposição real.
3. **Painel ao lado** — abra a Globo Play em outra janela e use a página só como painel de checagens.
   O duotone continua colorindo o placeholder com a cor do último veredito.

### O duotone

O vídeo recebe `filter: grayscale(1)` e uma camada colorida com `mix-blend-mode: color`; uma segunda
passada em `soft-light` dá peso aos escuros. Verde para verdade, vermelho para mentira, e as cores
intermediárias para os outros vereditos. A cor some sozinha depois de alguns segundos (configurável),
para o vídeo voltar ao normal entre uma checagem e outra.

---

## A busca restrita

Nada de “procure na web e me diga”: a ferramenta recebe a lista fechada de domínios. No OpenRouter:

```json
{
  "tools": [
    {
      "type": "openrouter:web_search",
      "parameters": {
        "max_results": 5,
        "max_uses": 3,
        "engine": "auto",
        "allowed_domains": ["g1.globo.com", "folha.uol.com.br", "ibge.gov.br"],
        "user_location": { "country": "BR", "city": "Lago Verde", "region": "Maranhão" }
      }
    }
  ],
  "max_tool_calls": 4
}
```

Na Anthropic direta, o equivalente é:

```json
{
  "type": "web_search_20250305",
  "name": "web_search",
  "max_uses": 4,
  "allowed_domains": ["g1.globo.com", "folha.uol.com.br", "ibge.gov.br"],
  "user_location": { "type": "approximate", "country": "BR", "city": "Lago Verde", "region": "Maranhão" }
}
```

Regras que o código respeita:

- `allowed_domains` recebe **domínios puros**, sem esquema e sem `www`;
- subdomínios entram automaticamente (`g1.globo.com` cobre `sub.g1.globo.com`);
- subcaminhos são aceitos (`g1.globo.com/fato-ou-fake` restringe àquele caminho);
- `allowed_domains` e `blocked_domains`/`excluded_domains` são mutuamente exclusivos — o código usa só o primeiro;
- listas muito longas podem devolver `request_too_large`; a interface avisa acima de 25 domínios e bloqueia acima de 45;
- na Anthropic, `web_search_20250305` é o padrão porque funciona em todos os modelos e devolve os resultados
  em blocos previsíveis; as versões `20260209`/`20260318` usam filtragem dinâmica e aninham os resultados
  dentro de execução de código. A auditoria entende os dois formatos.

### Veículos pré-estabelecidos

O padrão combina agências de checagem (Lupa, Aos Fatos, Comprova), grande imprensa (g1, Folha, UOL,
Estadão, CNN Brasil, Veja, Exame, Valor, Gazeta do Povo, CartaCapital) e fontes oficiais (gov.br, IBGE,
IPEA, TSE, STF, BCB, Reuters, BBC). Há presets na tela de configurações para começar de outro recorte.
**A lista é sua escolha editorial** — o sistema não decide o que é imprensa confiável.

---

## A auditoria de fontes

Sem isso, um modelo de linguagem pode inventar uma URL plausível. No OpenRouter toda busca volta com
`message.annotations[]` — cada `url_citation` tem `url`, `title` e `content`. É esse array que vira a
evidência, e é ele que o julgamento recebe como lista fechada. A auditoria faz três perguntas:

1. **O domínio está na lista?** (`domainOk`)
2. **A URL apareceu nos resultados desta busca?** (`seenInSearch`) — comparação normalizada, ignorando `www`,
   barra final, âncora e parâmetros de rastreamento; se a URL não bater, tenta pelo título.
3. **O modelo citou formalmente a URL?** (`citedByModel`) — reforço, não obrigação.

Só é **confirmada** quando 1 e 2 valem. Se nenhuma fonte passar, o veredito é **rebaixado para
NÃO VERIFICADO** e o cartão mostra o veredito original e o motivo do rebaixamento. Ou seja: o sistema
nunca afirma “verdadeiro” ou “falso” sem uma fonte que tenha voltado da busca restrita.

---

## Modelos, custo e configuração

O padrão é `anthropic/claude-opus-5.5`. A triagem pode usar um modelo mais barato
(`anthropic/claude-haiku-5.5`) para reduzir custo, já que ela só classifica texto. O campo
**modelo do julgamento** permite ainda usar um modelo forte só no veredito. O botão **listar modelos**
puxa o catálogo do OpenRouter por um proxy e preenche o seletor com os preços de cada um.

Preços de referência (OpenRouter, outubro de 2026):

| Modelo | Entrada / 1M | Saída / 1M |
|---|---|---|
| `anthropic/claude-opus-5.5` | US$ 4 | US$ 20 |
| `anthropic/claude-sonnet-5.5` | US$ 2 | US$ 10 |
| `anthropic/claude-haiku-5.5` | US$ 0,10 | US$ 0,50 |

Cada busca custa em torno de US$ 0,01 (US$ 0,007 na Exa). Uma checagem com Opus 5.5, 3 mil tokens de
entrada, 800 de saída e 2 buscas fica em torno de **US$ 0,05**. Um debate de duas horas com 40 afirmações
checadas fica na casa de **US$ 2**. O contador na tela soma isso em tempo real, incluindo as buscas, e
prefere o `usage.cost` que o OpenRouter devolve em cada resposta.

### Configurações que importam

| Campo | Padrão | Efeito |
|---|---|---|
| `provider` | OpenRouter | transporte e formato das chamadas |
| `chunkChars` / `chunkSeconds` | 260 / 30 s | tamanho da janela de transcrição |
| `concurrency` | 2 | checagens simultâneas; acima de 3 aumenta risco de 429 |
| `minPriority` | 2 | 1 = só o que é central; 3 = tudo, inclusive detalhe |
| `searchEngine` | `auto` | quem executa a busca no OpenRouter |
| `maxResults` | 5 | resultados por busca |
| `maxUses` | 4 | teto de buscas por afirmação |
| `model` / `triageModel` / `judgeModel` | Opus 5.5 / Haiku 5.5 / vazio | modelo de cada etapa |
| `duotoneHold` | 14 s | quanto tempo o vídeo fica colorido |
| `autoDuotone` | ligado | desliga se você só quiser os cartões |

---

## Segurança e privacidade

- **A chave da API fica no servidor.** O modo padrão é o proxy (`server.js`), que guarda
  `OPENROUTER_API_KEY` no processo e nunca a envia ao navegador. O modo “direto” (com a chave `sk-or-v1-…`
  no navegador) existe para teste e deixa a chave no `localStorage` — não use em máquina compartilhada.
- **O áudio vai para o Google.** A Web Speech API do Chrome transcreve nos servidores da Google; a página
  não grava áudio nem mantém arquivo. Se o microfone estiver bloqueado, a transcrição não funciona.
- **A transcrição vai para o OpenRouter** dentro das chamadas de triagem e checagem, junto com os domínios
  permitidos. O OpenRouter encaminha a requisição ao provedor do modelo escolhido, e a busca é executada
  pela engine selecionada. Nada é enviado a outros serviços.
- **O servidor não registra conteúdo.** O log mostra método, rota, status e tempo — nunca o corpo da
  requisição, a transcrição ou a chave.
- **`PROXY_TOKEN`** opcional exige um header extra em `/api/messages` e `/api/openrouter/*`; útil se você
  expõe o servidor para fora de localhost. O CORS libera apenas localhost, `*.e2b.app` e o que estiver em
  `ALLOWED_ORIGINS`.
- **Nada é publicado automaticamente.** Exportação em Markdown/JSON é manual.

---

## Estrutura

```
index.html                 tela única
assets/css/app.css         estética de sala de controle + duotone
assets/js/config.js        provedores, modelos, engines, preços, defaults
assets/js/outlets.js       domínios, presets, normalização e comparação
assets/js/store.js         localStorage + emissor de eventos
assets/js/client.js        transporte das duas APIs (proxy ou direto)
assets/js/providers.js     adaptadores: triagem, busca e julgamento de cada provedor
assets/js/audit.js         auditoria de fontes (o núcleo anti-invenção)
assets/js/pipeline.js      fila, dedupe, concorrência, custo
assets/js/speech.js        Web Speech API + segmentador de janelas
assets/js/pip.js           janela flutuante (Document Picture-in-Picture)
assets/js/demo.js          simulação sem API
assets/js/ui.js            cartões, flash, duotone, ajustes, exportação
assets/js/app.js           fiação geral
server.js                  servidor estático + proxy das APIs (sem dependências)
test/audit.test.mjs        auditoria, degradações automáticas e formatos da Anthropic
test/openrouter.test.mjs   evidências por anotação, duas fases e fallbacks do OpenRouter
docs/decisoes-tecnicas.md  por que cada escolha foi feita
```

---

## Testes

```bash
npm test
```

Cobrem normalização de domínio e URL, regra de subdomínio, extração de evidências (inclusive resultados
aninhados na filtragem dinâmica da Anthropic), conversão de `url_citation` em evidência, detecção de fonte
inventada, rebaixamento de veredito sem fonte, queda para o plugin legado quando a server tool é recusada
e normalização de vereditos.

---

## Limites e uso responsável

- **Não é uma checagem publicável.** O sistema ajuda a triar e a lembrar do dado; a decisão editorial é humana.
- **A transcrição erra.** Nomes próprios, números e siglas saem trocados com frequência. Uma janela de
  30 segundos costuma corrigir o que a anterior cortou — mas não sempre.
- **O modelo pode ler a fonte errado.** A auditoria garante que a URL existe e veio da busca; não garante
  que a interpretação está correta. Abra a matéria antes de publicar.
- **A lista de veículos é um recorte político.** Restringir a busca a uma lista não a torna imparcial:
  torna-a previsível e auditável. Documente a lista se for usar em transmissão.
- **Previsões, promessas e opiniões não são fatos.** O sistema as separa e não as classifica como
  verdadeiro/falso — se a fala for uma promessa, a verificação cobre apenas a parte factual.
- **Custo e latência são reais.** Rodar em modelo grande com concorrência alta custa dinheiro e pode
  esbarrar em limite de requisições.
- **Respeite os termos de uso.** Não contorne a proteção da Globo Play nem raspe conteúdo pago; o projeto
  foi desenhado para funcionar com links e com a janela flutuante.

Se a checagem for ao ar, diga no ar que ela é assistida por IA, mostre a fonte na tela (o cartão já faz
isso) e mantenha alguém revisando. A ferramenta foi feita para dar velocidade à redação, não para
substituir o checador.

---

## Problemas comuns

| Sintoma | Causa provável | Solução |
|---|---|---|
| “microfone bloqueado” | permissão negada ou página em `file://` | sirva por `http://localhost` ou https e permita o microfone no cadeado |
| Nada é transcrito | Firefox/Safari ou Chrome sem rede | use Chrome/Edge; a Web Speech API depende dos servidores do Google |
| “proxy inacessível” | servidor parado | `npm start` na raiz do projeto |
| “proxy sem chave” | `.env` ausente ou em outra pasta | veja o caminho impresso pelo servidor, copie `.env.example` para lá, preencha e reinicie |
| 401 | chave inválida | gere outra em openrouter.ai/workspaces/default/keys e reinicie o servidor |
| 402 | créditos insuficientes no OpenRouter | recarregue em openrouter.ai/credits ou use modelo mais barato |
| 404 “no endpoints found” | slug de modelo errado ou sem endpoint compatível | clique em **listar modelos** e copie o slug exato |
| 400 “web_search / tool” | modelo sem suporte a server tools | o sistema repete com o plugin `web`; se persistir, troque de modelo ou engine |
| 400 em `response_format` | endpoint sem structured outputs | o sistema repete sem schema automaticamente |
| `allowed_domains` recusado | filtro não aceito pela engine/modelo | troque a engine para `exa` ou `parallel` |
| `request_too_large` | lista de domínios enorme | reduza para menos de 25 |
| 429 / 529 | limite ou sobrecarga | reduza a concorrência e tente de novo |
| vídeo não aparece | URL não é YouTube ou embed desabilitado | use a janela flutuante ou abra o link em outra janela |
| janela flutuante não aparece | Chrome < 116 ou página embutida em iframe | atualize o Chrome e abra a página em uma aba própria |
| microfone bloqueado no preview | iframe do preview sem permissão de microfone | abra a página em nova aba (localhost) e permita o microfone |

---

## Próximos passos possíveis

- diarização (identificar quem falou) via transcrição externa;
- memória de afirmações já checadas ao longo do debate, com nota de repetição;
- fila de revisão humana antes de o cartão ir ao ar;
- importação de legendas oficiais em vez de microfone;
- cobertura de outros idiomas e listas de veículos por país;
- testes de integração com respostas gravadas das APIs.
