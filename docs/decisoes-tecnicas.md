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

- **22 testes de unidade** (`npm test`) sobre normalização de domínio, regra de subdomínio, extração de
  evidências (incluindo blocos aninhados da filtragem dinâmica), detecção de fonte inventada, comparação
  com `www`/barra/UTM, rebaixamento de veredito e normalização de strings de veredito.
- **Teste de integração em DOM real (jsdom)** com respostas gravadas da API: boot, health check, entrada
  manual, janela, triagem, verificação, auditoria, cartão, flash, duotone, timeline, custo e simulação —
  31 verificações, zero erro de console. O script desse teste não é versionado porque depende de jsdom
  instalado à parte; o roteiro está descrito aqui e pode ser recriado.
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
