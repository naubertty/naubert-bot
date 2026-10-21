# naubert-bot

Checagem de fatos **ao vivo** para debates. A página transcreve a fala pelo microfone, separa o que é
afirmação checável do que é opinião, verifica cada afirmação com busca restrita a uma lista de veículos
de imprensa e mostra o resultado **sobre o vídeo**, com um duotone verde ou vermelho e a matéria citada.

O provedor padrão é o **Gemini**, com chave do Google AI Studio (`AIza…`). O
**[OpenRouter](https://openrouter.ai)** (uma chave `sk-or-v1-…`, que dá acesso a Claude, GPT e Gemini) e a
**Anthropic direta** continuam disponíveis nas configurações.

```
 microfone ──► Web Speech API ──► janelas de transcrição
                                        │
                                        ▼
                              triagem (Flash-Lite)  ──► opinião / previsão / promessa: descartadas
                                        │
                                        ▼
              verificação em duas fases, com busca entre veículos pré-estabelecidos
                     fase 1: busca (Gemini + Google Search) ──► fontes reais (grounding)
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
| **Chave do Gemini** | Em [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → *Create API key*. A busca exige **faturamento ativado** no projeto; sem isso a checagem não roda. Custo estimado por afirmação: US$ 0,02–0,04 (veja [Custo](#modelos-custo-e-configuração)). |
| **Alternativa: chave do OpenRouter** | Em [openrouter.ai/workspaces/default/keys](https://openrouter.ai/workspaces/default/keys) → *Create key*. Uma chave dá acesso a Claude, GPT e Gemini. |
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
GEMINI_API_KEY=AIza...
```

Se preferir o OpenRouter, use `OPENROUTER_API_KEY=sk-or-v1-...` e troque o provedor nas configurações.

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

  Gemini:      AIza…wxyz
  OpenRouter:  ausente (opcional)
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
- Abra **Configurações → testar conexão** → deve aparecer “Gemini ok · chave válida · gemini-3.8-flash
  disponível”. Esse teste usa `GET /v1beta/models`: confere a chave **sem gastar token**.

**7. Configure para o debate de verdade**

Em **Configurações**:

1. cole o **link do vídeo** (YouTube renderiza embutido; Globo Play abre em janela externa);
2. revise a **lista de veículos** (presets prontos, ou cole os seus domínios);
3. confira o **modelo** — `gemini-3.8-flash` é o padrão e `gemini-3.1-flash-lite` faz a triagem. No
   OpenRouter, `anthropic/claude-opus-5.5` é o padrão e o botão **listar modelos** busca o catálogo;
3b. escolha a **entrada de áudio**: *microfone* (Web Speech) ou *áudio da aba* (captura + STT), se o
   microfone não ouve o debate;
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
| `Gemini: AUSENTE` no terminal | O servidor imprime logo abaixo o caminho exato do `.env` que ele procurou. Se o arquivo estiver em outra pasta (típico de ZIP extraído duas vezes, pasta dentro de pasta), crie o `.env` ao lado do `package.json` e do `server.js`. O `.env` é **lido só ao iniciar**: edite e rode `npm start` de novo. |
| “proxy inacessível” na página | O terminal do `npm start` foi fechado — suba de novo. |
| Microfone bloqueado | Permita no cadeado da barra de endereço. Se a página estiver dentro de um preview embutido, abra em aba própria. |
| Nada é transcrito | Primeiro clique em **testar microfone** (ao lado de *checar janela*). Se o medidor não mexer, o áudio não está chegando no navegador — veja o item abaixo. Se mexer e mesmo assim não sair texto, o problema é o serviço de reconhecimento do Google: abra `google.com` nesta mesma aba; VPN, DNS que filtra `google.com` e extensões bloqueadoras são as causas comuns. Enquanto isso, use **entrada manual**. |
| “a aba foi compartilhada sem áudio” | você escolheu a aba/janela sem marcar a caixa de áudio | repita o compartilhamento e marque **Compartilhar áudio da aba** |
| Captura de aba em preto e sem som | conteúdo com DRM (Globo Play e alguns players) | use o YouTube, a janela flutuante ou o loopback por cabo virtual |
| Microfone ouve a sala, não o vídeo | O reconhecimento escuta o **microfone padrão do sistema**, não a aba. Com alto-falante, o som do vídeo volta pelo ar e o cancelamento de eco do Chrome apaga justamente ele. O caminho confiável é o **loopback por software**: instale o [VB-Audio Virtual Cable](https://vb-audio.com/Cable/), ponha `CABLE Input` como *saída* padrão do Windows e `CABLE Output` como *entrada* padrão. O áudio do debate vai direto para o Chrome, sem eco e sem ruído de sala. A **Mixagem estéreo** do Windows resolve quando existe (Painel de Controle → Som → Gravação → clique direito no vazio → *Mostrar dispositivos desativados*); notebooks com *Intel Smart Sound* normalmente não têm. O botão **testar microfone** abre essas opções sozinho quando não capta som. |
| Transcrição atrasada ou picada | A janela fecha em 260 caracteres ou 30 s. Diminua `chunkChars` nas configurações para 140 se o debate for rápido; o custo é mais chamadas. |
| 401 na checagem | Chave inválida ou revogada: gere outra em [openrouter.ai/workspaces/default/keys](https://openrouter.ai/workspaces/default/keys) e atualize o `.env`. |
| 402 na checagem | Sem créditos no OpenRouter. Recarregue em [openrouter.ai/credits](https://openrouter.ai/credits) ou troque para um modelo mais barato na triagem. |
| “a busca do Google no Gemini precisa de faturamento” | O grounding não funciona no nível gratuito. Ative o faturamento no mesmo projeto da chave ([aistudio.google.com/apikey](https://aistudio.google.com/apikey) → projeto → *Billing*) ou volte para o OpenRouter. |
| “GEMINI_API_KEY não configurada” | O `.env` não foi lido: confira o caminho impresso no boot, preencha `GEMINI_API_KEY=AIza…` e reinicie o servidor. |
| “Chave válida, mas gemini-… não apareceu na lista” | O nome do modelo mudou ou não está liberado para a sua chave. Use **testar conexão** de novo e escolha um da lista. |

### Sobre a transcrição

Para testar com o microfone conhecido:

1. **Testar microfone** mede 10 s e mostra no aviso o pico e o nome do dispositivo;
2. **Iniciar escuta** liga o mesmo medidor ao lado dos botões da transcrição, em tempo real.

O medidor é medido **sem** cancelamento de eco, supressão de ruído e ganho automático — é o sinal cru do
dispositivo. Isso separa as duas falhas:

- **medidor no zero com o vídeo tocando** → o áudio não está chegando. O reconhecimento usa o microfone
  padrão do sistema, então o caminho é trocar o dispositivo de entrada (VB-Cable ou Mixagem estéreo). O
  teste abre um painel com os três caminhos possíveis;
- **medidor mexe e nada aparece escrito** → o áudio chega e o problema é a conversa do Chrome com os
  servidores de reconhecimento do Google (VPN, DNS filtrando `google.com`, extensão bloqueando). O app
  tenta de novo até 5 vezes antes de avisar.

O nome da entrada em uso aparece na linha da transcrição e a lista completa de entradas fica no console
do app — serve para conferir se o `CABLE Output` realmente apareceu.

**O que a tela mostra enquanto escuta:**

| Situação | O que aparece |
|---|---|
| reconhecendo | as palavras surgem em claro assim que o Chrome devolve cada frase (antes de a janela fechar), e a linha de cima mostra `janela aberta · 84/260 caracteres` |
| janela fechada | o trecho passa para o histórico da transcrição e vai para a triagem |
| áudio chegando, nada reconhecido | a linha de cima conta `ouvindo há N s · nenhuma fala reconhecida ainda`; aos 25 s o app abre o painel de loopback e explica que o controle de eco do Chrome descarta o som do alto-falante |
| silêncio longo depois de já ter transcrito | `silêncio de N s desde a última fala reconhecida` no console do app |

### Onde ficam as configurações

- **Chave da API e porta** → `.env`, na pasta do projeto (só no servidor).
- **Provedor, modelo, engine de busca, veículos, ritmo, vídeo, duotone** → `localStorage` do seu navegador,
  por navegador e por perfil. O botão **restaurar padrões** nas configurações volta tudo ao início.

### Rodar os testes

```bash
npm test       # 44 testes da auditoria, do pipeline e dos adaptadores (Gemini, OpenRouter, Anthropic)
npm run check  # sintaxe de todos os arquivos + testes
```

---

## O que a tela faz

| Etapa | O que acontece | Onde está no código |
|---|---|---|
| Transcrição | O Chrome transcreve a fala; o segmentador fecha janelas de ~260 caracteres ou 30 s, o que vier primeiro, e guarda as últimas frases como contexto | `assets/js/speech.js` |
| Triagem | O modelo da triagem recebe o trecho e devolve afirmações classificadas como `checavel`, `opiniao`, `previsao`, `promessa`, `pergunta` ou `ataque_pessoal`, com prioridade de 1 a 3 | `assets/js/pipeline.js` |
| Verificação | Cada afirmação checável vira uma busca entre os veículos da sua lista, seguida de um julgamento com a lista fechada de fontes encontradas | `assets/js/providers.js` |
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

## Gemini (padrão), OpenRouter e Anthropic direta

A interface da página é a mesma; o que muda é o transporte e o formato da busca.

| | Gemini | OpenRouter | Anthropic direto |
|---|---|---|---|
| Endpoint | `POST /v1beta/models/{model}:generateContent` | `POST /api/v1/chat/completions` (formato OpenAI) | `POST /v1/messages` |
| Chave | `AIza…` do AI Studio | `sk-or-v1-…` (dá acesso a vários modelos) | `sk-ant-…` |
| Busca | ferramenta `google_search` (grounding) | ferramenta `openrouter:web_search` | ferramenta `web_search_20250305` |
| Filtro de domínio | **não existe** na API do Google — a lista vai no prompt e é aplicada na auditoria | `allowed_domains` nos parâmetros da ferramenta | `allowed_domains` na definição da ferramenta |
| Citações | `groundingMetadata.groundingChunks[]` / `groundingSupports[]` | `message.annotations[]` (`url_citation`) | blocos `web_search_tool_result` |
| Chamadas por afirmação | **duas**: busca e depois julgamento | **duas**: busca e depois julgamento | uma |

### O caso do Gemini

O Gemini é o padrão porque é o mais barato hoje e porque a busca do Google é boa para números e datas.
Duas particularidades mudam o desenho:

1. **A busca precisa de faturamento.** O grounding do Google Search não funciona no nível gratuito. Sem
   faturamento no projeto, a chamada falha e o app para com uma mensagem explicando exatamente isso —
   não adianta trocar de modelo. A assinatura **Google AI Pro/Ultra não inclui chave de API**: os
   benefícios valem dentro do site do AI Studio; uso por chave é cobrado à parte.
2. **Não há filtro de domínio.** `excludeDomains`/`includeDomains` só existem no Vertex AI, não na Gemini
   Developer API. Então a lista de veículos entra **no prompt** ("priorize estes veículos") e é aplicada
   **na auditoria**: fonte cujo domínio não está na lista vira `fora_da_lista` e o veredito é rebaixado.

E o detalhe que quebraria a auditoria: o `uri` de cada fonte do grounding é um **redirecionador**
(`vertexaisearch.cloud.google.com/...`), não o domínio do veículo. O domínio real vem em `web.title`. O
adaptador guarda os dois (`url` para o link, `domain` para a lista) e a auditoria usa o `domain` quando
presente. Sem isso, toda fonte do Gemini seria "fora da lista".

Também por isso a checagem no Gemini é em **duas chamadas**: a busca roda sem schema JSON (pedir JSON
junto com a busca tende a apagar as anotações de grounding), e só depois o julgamento recebe a lista
fechada de fontes e devolve o veredito validado por `responseSchema`.

Preço: Gemini 3.8 Flash a US$ 0,75/1M de entrada e 3,75/1M de saída; triagem no 3.1 Flash-Lite
(0,25/1,50). A busca é cobrada por consulta: 5.000/mês grátis com billing ativo, depois US$ 14/1.000.

**Quem já usava o app** é migrado na primeira abertura: se você nunca trocou o provedor nem o modelo, as
configurações salvas passam a apontar para o Gemini (a lista de veículos e o resto ficam intactos). Se já
tinha escolhido outro modelo à mão, nada muda — troque em **Configurações → Provedor**. O `localStorage`
antigo guarda `provider: 'openrouter'` e, sem essa migração, o padrão novo não teria efeito.

No OpenRouter a verificação é dividida em duas chamadas porque structured outputs e busca na mesma
requisição fazem o provedor **suprimir as anotações** de citação — e sem anotação não há auditoria. Então:

1. **busca** — o modelo recebe a afirmação e a ferramenta de busca restrita; devolve um resumo em texto
   com `url_citation` para cada fonte que usou. Nada de JSON nesta chamada.
2. **julgamento** — o modelo recebe o resumo, as fontes e só as URLs que voltaram da busca (lista fechada)
   e devolve o veredito em JSON validado por schema.

Se o endpoint recusar a server tool (`400`/`404`/`422` falando de `tool`), o código repete a busca com o
plugin legado `{"id":"web", "include_domains":[...]}`, que também devolve `url_citation`. Se a conta recusar
structured outputs, o julgamento é repetido sem schema e o JSON é lido de forma tolerante.

### Engines de busca (OpenRouter)

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

## Ouvir o áudio da aba (sem microfone)

A Web Speech API **só aceita microfone** — não existe como entregar a ela o som de uma aba. Quando o
microfone não ouve o debate (fone de ouvido, cancelamento de eco, placa sem loopback), a alternativa é a
própria página capturar o áudio:

```
getDisplayMedia({audio}) ──► AudioContext ──► MediaRecorder (webm/opus)
        │                                            │
        │                              trechos de 3–15 s (padrão 6 s)
        │                                            ▼
        │                       POST /api/v1/audio/transcriptions (Whisper)
        ▼                                            │
   medidor de nível                                  ▼
                                        texto → mesmo segmentador → mesma checagem
```

Como usar:

1. **Configurações → Entrada de áudio** → *áudio da aba · captura + STT* → **salvar**;
2. clique em **Iniciar escuta** — o Chrome abre o seletor de compartilhamento;
3. escolha a **aba do debate** e marque **“Compartilhar áudio da aba”** (a caixa aparece embaixo do
   botão *Compartilhar*; sem ela a página avisa que veio sem áudio);
4. deixe o vídeo tocando. O indicador do topo mostra `ouvindo a aba` e o medidor reage ao som.

O trecho é enviado em base64 para o proxy local, que repassa ao serviço escolhido. Com o provedor
**Gemini**, o áudio vai inline no `generateContent` (`inline_data`) do modelo de transcrição — não precisa
de chave do OpenRouter. Com OpenRouter/Anthropic, usa-se `/audio/transcriptions` do OpenRouter.

| Modelo | Custo | Quando usar |
|---|---|---|
| `gemini-3.5-transcribe` | tokens de áudio do Gemini | padrão no Gemini; feito para áudio |
| `gemini-3.8-flash` | US$ 0,75/1M de entrada | reusa o modelo da checagem |
| `openai/whisper-1` | US$ 0,0001/s (~0,0006 por 6 s) | padrão no OpenRouter |
| `openai/whisper-large-v3-turbo` | ~0,00004/s | mais rápido e barato |
| `openai/gpt-4o-transcribe` | 0,0001/s | melhor em nomes próprios e números |
| `google/chirp-3` | 0,0001/s | áudio de transmissão |

No OpenRouter, um debate de duas horas custa entre **US$ 0,30 e US$ 0,70** só de transcrição; no Gemini,
conta como entrada de áudio do modelo escolhido. O contador da tela soma
isso ao custo das checagens.

**Atraso:** trecho de 6 s + envio + transcrição ≈ 7–10 s até o texto aparecer; a checagem soma mais
alguns segundos. É mais lento que a Web Speech, mas ouve o vídeo — que é o que importa quando o microfone
não coopera.

**Limites honestos:**

- o áudio é enviado ao provedor escolhido (Gemini ou OpenRouter) e transcrito lá — não fique nesse modo
  se o áudio for confidencial;
- **abas com DRM** (Globo Play, alguns players) podem ir em preto/mudo para a captura; com YouTube
  funciona;
- capture **somente a aba do debate**: se você compartilhar a aba inteira com notificações, elas entram
  na transcrição;
- fechar o banner “esta aba está sendo compartilhada” encerra a captura — o app avisa.

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

No Gemini não há campo de filtro — a lista entra no texto da busca:

```
Busque o dado e resuma o que as fontes mostram.
Veículos que devem ser priorizados na busca (o veredito só pode se apoiar neles):
g1.globo.com, folha.uol.com.br, ibge.gov.br
```

E a auditoria aplica a lista sobre o `domain` que veio no grounding. Na Anthropic direta, o equivalente ao
`allowed_domains` do OpenRouter é:

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

O padrão é **Gemini 3.8 Flash** para a checagem e **Gemini 3.1 Flash-Lite** para a triagem. OpenRouter e
Anthropic continuam disponíveis nas configurações e continuam sendo a saída quando não há faturamento no
projeto do Google.

No OpenRouter o padrão é `anthropic/claude-opus-5.5`. A triagem pode usar um modelo mais barato
(`anthropic/claude-haiku-5.5`) para reduzir custo, já que ela só classifica texto. O campo
**modelo do julgamento** permite ainda usar um modelo forte só no veredito — vale para Gemini também.
O botão **listar modelos** puxa o catálogo do OpenRouter por um proxy e preenche o seletor com os
preços de cada um.

Preços de referência do Gemini (outubro de 2026, por 1M de tokens):

| Modelo | Entrada | Saída | Uso no app |
|---|---|---|---|
| `gemini-3.8-flash` | US$ 0,75 | US$ 3,75 | checagem (padrão até 31/12/2026) |
| `gemini-3.1-flash-lite` | US$ 0,25 | US$ 1,50 | triagem (padrão) |
| `gemini-3.1-pro-preview` | US$ 2,00 | US$ 12,00 | sem nível gratuito |
| `gemini-4-argon` | US$ 2,00 | US$ 10,00 | topo de linha |

A busca do Google custa por consulta: 5.000/mês grátis com faturamento ativo, depois **US$ 14/1.000**
(US$ 0,014 por busca). Uma checagem no Gemini com busca sai por **US$ 0,02–0,04**.

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
| `provider` | Gemini | transporte e formato das chamadas |
| `chunkChars` / `chunkSeconds` | 260 / 30 s | tamanho da janela de transcrição |
| `concurrency` | 2 | checagens simultâneas; acima de 3 aumenta risco de 429 |
| `minPriority` | 2 | 1 = só o que é central; 3 = tudo, inclusive detalhe |
| `searchEngine` | `auto` | quem executa a busca no OpenRouter (ignorado no Gemini) |
| `maxResults` | 5 | resultados por busca |
| `maxUses` | 4 | teto de buscas por afirmação |
| `model` / `triageModel` / `judgeModel` | Flash 3.8 / Flash-Lite 3.1 / vazio | modelo de cada etapa |
| `duotoneHold` | 14 s | quanto tempo o vídeo fica colorido |
| `autoDuotone` | ligado | desliga se você só quiser os cartões |

---

## Se o OpenRouter responder 402

O 402 é falta de dinheiro, não bug: a conta está sem saldo, ou a **própria chave** tem um teto de gasto já
esgotado. Enquanto isso não é resolvido, **nada funciona** — nem a transcrição, nem a triagem, nem a busca.
Não há camada gratuita equivalente: a busca na web e a transcrição são cobradas.

O app trata isso de frente:

- consulta `GET /api/v1/key` no boot (não gasta crédito) e mostra o uso do dia/mês; se a chave tiver teto,
  mostra o que resta;
- quando uma chamada devolve 402, aparece uma **faixa vermelha no topo** com o motivo e o link para
  recarregar;
- a **fila de checagens e a captura de áudio param** em vez de repetir o mesmo erro a cada afirmação/trecho;
- o botão **consultar saldo** repete a consulta a qualquer momento.

Para resolver: [openrouter.ai/credits](https://openrouter.ai/credits) → adicionar crédito (cartão ou cripto,
mínimo de US$ 5). US$ 5 cobrem cerca de 100 afirmações checadas com Opus 5.5 ou ~14 horas de transcrição com
Whisper 1. Se a mensagem citar *limite da chave*, o problema é o teto configurado em
[openrouter.ai/workspaces/default/keys](https://openrouter.ai/workspaces/default/keys), não o saldo da conta.

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
assets/js/speech.js        Web Speech API, medidor de microfone + segmentador de janelas
assets/js/audio.js         captura do áudio da aba + transcrição (Gemini ou OpenRouter)
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
| 402 | créditos insuficientes (ou teto da própria chave esgotado) | o app mostra a faixa vermelha no topo e **para a fila** em vez de repetir o erro. Clique em **consultar saldo** para ver o uso; adicione crédito em [openrouter.ai/credits](https://openrouter.ai/credits). Se a mensagem falar em *limite da chave*, ajuste o teto da chave em [keys](https://openrouter.ai/workspaces/default/keys) |
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
