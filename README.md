# naubert-bot

Checagem de fatos **ao vivo** para debates. A página transcreve a fala pelo microfone, separa o que é
afirmação checável do que é opinião, verifica cada afirmação com busca restrita a uma lista de veículos
de imprensa e mostra o resultado **sobre o vídeo**, com um duotone verde ou vermelho e a matéria citada.

```
 microfone ──► Web Speech API ──► janelas de transcrição
                                        │
                                        ▼
                              triagem (Claude)  ──► opinião / previsão / promessa: descartadas
                                        │
                                        ▼
                    verificação com web_search restrita por allowed_domains
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

## Em 30 segundos

```bash
cp .env.example .env      # cole sua ANTHROPIC_API_KEY
npm start                 # http://localhost:8787
```

Abra a página, clique em **Simulação** para ver a tela funcionando sem gastar API.
Depois, em **Configurações**, cole o link do vídeo, ajuste os veículos permitidos e clique em **Iniciar escuta**.

Requisitos: Node 18+ (o servidor não tem dependências) e Chrome ou Edge no desktop (a Web Speech API não
existe no Firefox nem no Safari mobile).

---

## O que a tela faz

| Etapa | O que acontece | Onde está no código |
|---|---|---|
| Transcrição | O Chrome transcreve a fala; o segmentador fecha janelas de ~260 caracteres ou 30 s, o que vier primeiro, e guarda as últimas frases como contexto | `assets/js/speech.js` |
| Triagem | O Claude recebe o trecho e devolve afirmações classificadas como `checavel`, `opiniao`, `previsao`, `promessa`, `pergunta` ou `ataque_pessoal`, com prioridade de 1 a 3 | `assets/js/pipeline.js` |
| Verificação | Cada afirmação checável vira uma chamada com a ferramenta `web_search` limitada por `allowed_domains` à sua lista de veículos | `assets/js/pipeline.js` |
| Auditoria | Confere se cada URL citada apareceu nos resultados da busca, se o domínio está na lista e se o modelo a citou | `assets/js/audit.js` |
| Resultado | Duotone no vídeo, cartão sobreposto, lista lateral com fonte, trecho, confiança e latência | `assets/js/ui.js` |
| Custo | Contador de chamadas, buscas e custo estimado em dólar | `assets/js/pipeline.js` |

A triagem e a verificação são **duas chamadas separadas** — é isso que permite descartar opinião antes de
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

## Por que não é instantâneo

Uma checagem leva tipicamente **6 a 15 segundos**:

- triagem: 1–4 s;
- verificação: 3–12 s, dependendo de quantas buscas o modelo decide fazer;
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

O parâmetro `allowed_domains` recebe **domínios puros**, sem esquema:

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

- subdomínios entram automaticamente (`g1.globo.com` cobre `sub.g1.globo.com`);
- subcaminhos são aceitos (`g1.globo.com/fato-ou-fake` restringe àquele caminho);
- `allowed_domains` e `blocked_domains` são mutuamente exclusivos — o código usa só o primeiro;
- listas muito longas podem devolver `request_too_large`; a interface avisa acima de 25 domínios e bloqueia acima de 45;
- `web_search_20250305` é o padrão porque funciona em todos os modelos e devolve os resultados em blocos
  previsíveis. As versões `20260209`/`20260318` usam filtragem dinâmica e aninham os resultados dentro de
  execução de código; a auditoria entende os dois formatos, mas a versão básica é mais fácil de depurar.
- nas versões com filtragem dinâmica o código envia `allowed_callers: ["direct"]`: sem isso, a API espera
  executar a busca por código e pode devolver 400.

### Veículos pré-estabelecidos

O padrão combina agências de checagem (Lupa, Aos Fatos, Comprova), grande imprensa (g1, Folha, UOL,
Estadão, CNN Brasil, Veja, Exame, Valor, Gazeta do Povo, CartaCapital) e fontes oficiais (gov.br, IBGE,
IPEA, TSE, STF, BCB, Reuters, BBC). Há presets na tela de configurações para começar de outro recorte.
**A lista é sua escolha editorial** — o sistema não decide o que é imprensa confiável.

---

## A auditoria de fontes

Sem isso, um modelo de linguagem pode inventar uma URL plausível. Toda resposta da busca vem com
`server_tool_use` (a consulta), `web_search_tool_result` (o que voltou) e citações. A auditoria faz três perguntas:

1. **O domínio está na lista?** (`domainOk`)
2. **A URL apareceu nos resultados desta busca?** (`seenInSearch`) — comparação normalizada, ignorando `www`,
   barra final, âncora e parâmetros de rastreamento; se a URL não bater, tenta pelo título.
3. **O modelo citou formalmente a URL?** (`citedByModel`) — reforço, não obrigação.

Só é **confirmada** quando 1 e 2 valem. Se nenhuma fonte passar, o veredito é **rebaixado para
NÃO VERIFICADO** e o cartão mostra o veredito original e o motivo do rebaixamento. Ou seja: o sistema
nunca afirma “verdadeiro” ou “falso” sem uma fonte que tenha voltado da busca restrita.

---

## Modelos, custo e configuração

O padrão é `claude-opus-5-5`. A triagem pode usar um modelo mais barato (`claude-haiku-5-5`) para reduzir custo,
já que ela só classifica texto. O raciocínio adaptativo fica ligado na checagem e desligado na triagem.

Preços de referência (API da Anthropic, outubro de 2026):

| Modelo | Entrada / 1M | Saída / 1M |
|---|---|---|
| Opus 5.5 | US$ 4 | US$ 20 |
| Sonnet 5.5 | US$ 2 | US$ 10 |
| Haiku 5.5 | US$ 0,10 | US$ 0,50 |

Cada busca custa US$ 10 por 1.000 (US$ 0,01 por busca). Uma checagem com Opus 5.5, 3 mil tokens de entrada,
800 de saída e 2 buscas fica em torno de **US$ 0,05**. Um debate de duas horas com 40 afirmações checadas
fica na casa de **US$ 2**. O contador na tela soma isso em tempo real, incluindo as buscas.

### Configurações que importam

| Campo | Padrão | Efeito |
|---|---|---|
| `chunkChars` / `chunkSeconds` | 260 / 30 s | tamanho da janela de transcrição |
| `concurrency` | 2 | checagens simultâneas; acima de 3 aumenta risco de 429 |
| `minPriority` | 2 | 1 = só o que é central; 3 = tudo, inclusive detalhe |
| `maxUses` | 4 | teto de buscas por afirmação |
| `searchTool` | `web_search_20250305` | versão da ferramenta de busca |
| `model` / `triageModel` | Opus 5.5 / mesmo | modelo de cada etapa |
| `duotoneHold` | 14 s | quanto tempo o vídeo fica colorido |
| `autoDuotone` | ligado | desliga se você só quiser os cartões |

---

## Segurança e privacidade

- **A chave da API fica no servidor.** O modo padrão é o proxy (`server.js`), que guarda `ANTHROPIC_API_KEY`
  no processo e nunca a envia ao navegador. O modo “direto” existe para teste e deixa a chave no
  `localStorage` — não use em máquina compartilhada.
- **O áudio vai para o Google.** A Web Speech API do Chrome transcreve nos servidores da Google; a página
  não grava áudio nem mantém arquivo. Se o microfone estiver bloqueado, a transcrição não funciona.
- **A transcrição vai para a Anthropic** dentro das chamadas de triagem e checagem, junto com os domínios
  permitidos. Nada é enviado a outros serviços.
- **O servidor não registra conteúdo.** O log mostra método, rota, status e tempo — nunca o corpo da
  requisição, a transcrição ou a chave.
- **`PROXY_TOKEN`** opcional exige um header extra em `/api/messages`; útil se você expõe o servidor para fora
  de localhost. O CORS libera apenas localhost, `*.e2b.app` e o que estiver em `ALLOWED_ORIGINS`.
- **Nada é publicado automaticamente.** Exportação em Markdown/JSON é manual.

---

## Estrutura

```
index.html               tela única
assets/css/app.css       estética de sala de controle + duotone
assets/js/config.js      modelos, vereditos, defaults
assets/js/outlets.js     domínios, presets, normalização e comparação
assets/js/store.js       localStorage + emissor de eventos
assets/js/anthropic.js   cliente da Messages API (proxy ou direto)
assets/js/audit.js       auditoria de fontes (o núcleo anti-invenção)
assets/js/pipeline.js    triagem, verificação, fila, dedupe, custo
assets/js/speech.js      Web Speech API + segmentador de janelas
assets/js/pip.js         janela flutuante (Document Picture-in-Picture)
assets/js/demo.js        simulação sem API
assets/js/ui.js          cartões, flash, duotone, ajustes, exportação
assets/js/app.js         fiação geral
server.js                servidor estático + proxy da API (sem dependências)
test/audit.test.mjs      22 testes da auditoria, das degradações automáticas e do formato
docs/decisoes-tecnicas.md  por que cada escolha foi feita
```

---

## Testes

```bash
npm test
```

Cobrem normalização de domínio e URL, regra de subdomínio, extração de evidências (inclusive resultados
aninhados na filtragem dinâmica), detecção de fonte inventada, rebaixamento de veredito sem fonte e
normalização de vereditos.

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
| “proxy sem chave” | `.env` ausente | copie `.env.example`, preencha e reinicie |
| 401 | chave inválida | confira `ANTHROPIC_API_KEY` |
| 400 em `output_config` | conta/modelo sem structured outputs | o sistema repete sem schema automaticamente; se persistir, preencha o header beta |
| 400 em `thinking` | modelo antigo (Haiku 4.5) | desligue o raciocínio ou use um modelo 4.6+ |
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
- testes de integração com respostas gravadas da API.
