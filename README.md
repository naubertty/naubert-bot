# GREE+ no PC — controle local do ar-condicionado

Engenharia reversa do protocolo do aplicativo **GREE+ / EWPE Smart** e um controlador
que roda no seu computador: descoberta na rede, pareamento, leitura de estado, comandos
e uma interface web. Tudo **direto via UDP na rede local**, sem nuvem, sem conta e sem
dependências externas.

> Funciona com aparelhos Gree e marcas que usam a mesma placa Wi-Fi (EWPE): Gree,
> Cooper&Hunter, Sinclair, Tosot, Lomo, Heiwa, entre outras.

---

## Windows — sem Git, em 4 passos

1. **Baixe o projeto pronto** (não precisa instalar Git):
   [naubert-bot.zip](https://github.com/naubertty/naubert-bot/archive/refs/heads/arena/d4b4eb20-naubert-bot.zip)
2. Clique com o **botão direito** no ZIP → **Extrair tudo** e escolha uma pasta simples,
   por exemplo `C:\gree`.
3. Se ainda não tiver Python: instale de [python.org/downloads](https://www.python.org/downloads/)
   e **marque “Add python.exe to PATH”** na primeira tela do instalador.
4. Abra a pasta extraída e dê **dois cliques** em um destes arquivos:

| Arquivo | O que faz |
|---|---|
| `INICIAR-DEMO.bat` | testa a interface com um aparelho **simulado** (não precisa de ar-condicionado) |
| `INICIAR-AR-CONDICIONADO.bat` | procura o aparelho na rede, pareia e abre o controle |
| `DIAGNOSTICO.bat` | se algo falhar: testa tudo e gera `diagnostico.txt` para enviar a quem ajuda |

> Não digite comandos dentro de `C:\Windows\System32`. Os arquivos `.bat` já abrem na
> pasta certa. Se o Windows mostrar “O Windows protegeu o computador”, clique em
> **Mais informações → Executar assim mesmo** (o código é aberto, você pode ler).

---

## Começando em 3 passos

Pré-requisito: **Python 3.9+** (Windows, macOS ou Linux). Não precisa instalar nada além dele.

```bash
# 1. descubra o aparelho na rede
python gree.py scan

# 2. pareie (troca de chave local; salva em greeplus.json)
python gree.py bind --ip 192.168.0.50

# 3. controle
python gree.py status
python gree.py set temp=22 mode=cool fan=auto
python gree.py web            # abre a interface no navegador
```

No Windows, se `python` não for reconhecido, use `py` (ex.: `py gree.py scan`).
A interface web também funciona com um aparelho simulado, sem ar-condicionado:

```bash
python gree.py web --demo --open
```

---

## Interface web

`python gree.py web` sobe um servidor em `http://localhost:8080` com a página de controle:
ligar/desligar, temperatura, modos, ventoinha, aleta e extras (luz, sleep, turbo, quieto,
XFan, íon, ar novo). O estado é atualizado a cada 4 segundos.

A página é servida **pelo seu PC** e conversa com o servidor local; o servidor é quem fala
UDP com o ar-condicionado. Nenhum dado é enviado para a internet.

Opções úteis:

| Comando | Para quê |
|---|---|
| `python gree.py web --demo` | sobe um aparelho emulado em `127.0.0.1:7000` |
| `python gree.py web --host 127.0.0.1` | escuta só na máquina local (padrão: `0.0.0.0`) |
| `python gree.py web --http-port 9000` | troca a porta da interface |
| `python gree.py web --open` | abre o navegador automaticamente |

> Se a interface estiver exposta na rede (`0.0.0.0`), qualquer pessoa na mesma rede pode
> controlar o aparelho. Use `--host 127.0.0.1` se quiser restringir ao seu PC.

---

## Linha de comando

```
python gree.py scan [--target 192.168.0.255] [--timeout 3] [--json]
python gree.py bind --ip 192.168.0.50 [--protocol v1|v2] [--config greeplus.json]
python gree.py status [--raw] [--json]
python gree.py set pow=on mode=cool temp=22 fan=3 swing=oscilar light=on
python gree.py watch --interval 5
python gree.py emulator [--protocol v1|v2] [--port 7000]
python gree.py diagnose          # relatório de rede + tentativa de bind v1/v2
```

Depois do `bind`, o IP, o MAC e a chave ficam salvos em `greeplus.json`, então os demais
comandos não precisam de argumentos. Variáveis e opções:

- `--config arquivo` — usa outro arquivo de configuração;
- `GREEPLUS_CONFIG=arquivo` — o mesmo, por variável de ambiente;
- `--json` — saída legível por máquina (útil para scripts e automação);
- `--no-color` — sem cores no terminal.

### Propriedades aceitas no `set`

| Nome amigável | Propriedade | Valores |
|---|---|---|
| `pow` / `power` | `Pow` | `on`, `off`, `1`, `0` |
| `mode` / `modo` | `Mod` | `auto`, `cool`, `dry`, `fan`, `heat` |
| `temp` / `temperatura` | `SetTem` | 8–30 °C |
| `fan` / `ventilador` | `WdSpd` | `auto`, `low`, `medium-low`, `medium`, `medium-high`, `high` ou 0–5 |
| `swing` / `aleta` | `SwUpDn` | `parado`, `oscilar`, `superior`, `meio`, `inferior`, 0–11 |
| `light` / `luz` | `Lig` | `on`, `off` |
| `sleep` | `SwhSlp` + `SlpMod` | `on`, `off` |
| `turbo` | `Tur` | `on`, `off` |
| `quiet` | `Quiet` | `on` (2), `off` (0) |
| `xfan` | `Blo` | `on`, `off` |
| `health` / `ion` | `Health` | `on`, `off` |
| `air` / `ar novo` | `Air` | `on`, `off` |

Qualquer outra propriedade do protocolo pode ser enviada diretamente, por exemplo
`python gree.py set SvSt=1` ou `python gree.py set HeatCoolType=1`.

---

## Como a engenharia reversa foi feita

O aplicativo GREE+ fala com o ar-condicionado por **UDP na porta 7000**, usando JSON com o
payload cifrado. O caminho percorrido:

1. **Captura de tráfego** — com o celular e o PC na mesma rede, um `tcpdump`/Wireshark
   mostra pacotes UDP/7000 em texto claro (`{"t":"scan"}`) e envelopes com um campo
   `pack` em Base64.
2. **Identificação da cifra** — o Base64 decodifica para blocos de 16 bytes; testes de
   entropia e o padding PKCS#7 indicam **AES-128-ECB**. A chave genérica
   `a3K8Bx%2r8Y7#xDh` aparece embutida no APK e decifra as respostas de descoberta.
3. **Pareamento** — um `bind` cifrado com essa chave genérica faz o aparelho devolver a
   **chave única daquele aparelho** (`bindok` → `key`), usada dali em diante.
4. **Comandos** — o app envia `status` (lista de propriedades) e `cmd` (pares
   `opt`/`p`), sempre dentro do envelope `pack`.
5. **Firmwares novos** — módulos Wi-Fi mais recentes trocaram o ECB por **AES-128-GCM**
   com nonce e AAD fixos (chave genérica `{yxAHAY_Lm6pbC/<`). O cliente detecta
   automaticamente qual geração o aparelho usa (`v1`/`v2`) durante o `bind`.

O detalhamento de cada pacote, chaves, campos e tabela de propriedades está em
**[PROTOCOL.md](PROTOCOL.md)**. A implementação deste repositório é independente: o
protocolo foi reconstruído a partir do comportamento observado e de pesquisa pública
(ver *Referências*), sem copiar código de terceiros.

### Por que não é preciso "descompilar o app" para usar

A parte útil já é conhecida e documentada pela comunidade. O que faltava era uma ferramenta
simples de PC, em português, que fizesse descoberta → pareamento → controle e uma interface
gráfica. É isso que este repositório entrega — incluindo um emulador para testar a lógica
sem depender do aparelho.

---

## Solução de problemas

| Sintoma | Causa provável / solução |
|---|---|
| `Nenhum aparelho respondeu` | PC e aparelho em redes/VLANs diferentes, Wi-Fi de convidados com isolamento, ou firewall bloqueando UDP. Teste `ping <ip>` e use `scan --target <ip>`. |
| `Sem resposta` no `status` | A chave mudou (o app Gree+ foi usado para reparear) ou outro celular assumiu o controle. Rode `bind` de novo. |
| `bind` funciona, mas comandos não | Alguns modelos usam a geração **v2**; force com `--protocol v2`. |
| A busca acha, mas "Conectar" falha | Firmwares novos (ex.: **V3.4.M**) só aceitam o pareamento na mesma sessão UDP do scan. Atualize o projeto (baixe o ZIP de novo) — o fluxo já faz scan + bind no mesmo socket. Se continuar, rode `DIAGNOSTICO.bat` e envie o `diagnostico.txt`. |
| Interface web abre, mas não conecta | O servidor precisa estar no mesmo PC/rede que alcança o aparelho; verifique o IP salvo em `greeplus.json`. |
| Porta 7000 ocupada | Feche outros servidores locais (Home Assistant, emulador) ou use `--port` para o emulador. |
| Windows bloqueia a busca | Libere o Python no firewall do Windows (Redes privadas), ou conecte por IP. |
| Temperatura em °F | O aparelho está configurado em Fahrenheit; ajuste a unidade no controle remoto. A interface avisa. |

---

## Limitações conhecidas

- **Sem recursos de nuvem**: agendamentos, consumo de energia e atualização de firmware do
  app original continuam dependendo do app/servidor da Gree. Este projeto cobre o controle
  local.
- **Modelos variam**: nem toda propriedade existe em todo aparelho. `status --raw` mostra o
  que o seu modelo reporta; colunas desconhecidas são ignoradas pelo aparelho.
- **Uma unidade por sessão**: o cliente controla um aparelho por vez (a CLI aceita `--ip`
  para alternar; a interface web guarda o último).
- **Fahrenheit**: `SetTem` usa uma codificação diferente em °F; a interface bloqueia os
  botões de temperatura quando detecta `TemUn=1` (a aleta/modo continuam funcionando).
- **Segurança do protocolo**: a chave é fixa/estática e o canal não tem autenticação forte.
  Este projeto não contorna nenhuma proteção de conta — apenas fala o mesmo protocolo local
  que o app usa no seu próprio aparelho.

---

## Estrutura do projeto

```
gree.py                 atalho da CLI
greeplus/
  crypto.py             AES-128 (ECB e GCM) em Python puro, sem dependências
  packets.py            montagem/decodificação dos envelopes e propriedades
  client.py             descoberta, bind, status e comandos via UDP
  cli.py                interface de linha de comando (PT-BR)
  web.py                servidor HTTP local + API
  webui.html            interface web (HTML/CSS/JS sem framework)
  emulator.py           aparelho Gree falso para testes/demonstração
tests/                  testes: vetores AES/GCM, pacotes, UDP real, CLI e HTTP
PROTOCOL.md             documentação técnica do protocolo
```

Rodar os testes (opcional; precisa de `pytest`):

```bash
python -m pip install pytest
python -m pytest
```

---

## Referências

- [cmroche/greeclimate](https://github.com/cmroche/greeclimate) — biblioteca usada pela
  integração oficial do Home Assistant; referência de comportamento para V1/V2.
- [tomikaa87/gree-remote](https://github.com/tomikaa87/gree-remote) — primeira descrição
  pública do protocolo (scan/bind).
- [Home Assistant – Gree Climate](https://www.home-assistant.io/integrations/gree/) —
  integração e relatos de campo de diversos modelos.
- [Kaspars Dambis – notas sobre Gree Amber Nordic](https://kaspars.net/blog/gree-amber-nordic-gwh09yd-s6dba1)
  — capturas reais de pacotes e chave genérica.

## Licença

MIT — use, modifique e compartilhe. O projeto não é afiliado à Gree; marcas citadas
pertencem aos seus donos. Use apenas em aparelhos que você possui.
