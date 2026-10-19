# Protocolo local Gree / EWPE (UDP 7000)

Documento técnico do que foi observado ao analisar o tráfego do aplicativo **GREE+**
(Android/iOS) falando com um ar-condicionado na mesma rede. Serve de base para a
implementação em `greeplus/`.

> Use apenas em equipamentos seus. O objetivo aqui é interoperabilidade local,
> não burlar contas, assinaturas ou proteções.

---

## 1. Visão geral

- Transporte: **UDP, porta 7000**, datagramas JSON em UTF-8.
- Descoberta: broadcast (`255.255.255.255`) ou unicast para o IP do aparelho.
- Toda mensagem "de dados" é um envelope JSON com o campo `pack` em Base64, contendo
  um segundo JSON cifrado.
- Duas gerações de cifra coexistem:
  - **V1**: AES-128-ECB + PKCS#7, encontrada nos módulos Wi-Fi mais antigos;
  - **V2**: AES-128-GCM com nonce e AAD fixos, nos módulos mais recentes (Qualcomm).
- O pareamento (`bind`) devolve uma **chave por aparelho**, usada em `status`/`cmd`.
  As chaves genéricas servem apenas para descoberta e para o próprio `bind`.

---

## 2. Chaves e parâmetros

| Item | Valor |
|---|---|
| Chave genérica V1 | `a3K8Bx%2r8Y7#xDh` (16 bytes ASCII) |
| Chave genérica V2 | `{yxAHAY_Lm6pbC/<` (16 bytes ASCII) |
| Nonce GCM (V2) | `54 40 78 44 49 67 5A 51 6C 5E 63 13` (12 bytes) |
| AAD GCM (V2) | `qualcomm-test` |
| Chave do aparelho | devolvida no `bindok`, 16 caracteres ASCII (pode variar) |

Esses valores são constantes do firmware/app — iguais em todas as unidades de cada
geração. A chave do aparelho é o único segredo real e é obtida no pareamento.

---

## 3. Envelope

```json
{
  "cid": "app",
  "i": 1,
  "t": "pack",
  "uid": 0,
  "tcid": "502cc6aabbcc",
  "pack": "<Base64>",
  "tag": "<Base64>"
}
```

| Campo | Significado |
|---|---|
| `cid` | remetente: `"app"` para o aplicativo/PC, MAC do aparelho nas respostas |
| `tcid` | destinatário: MAC do aparelho nos pedidos, `"app"` nas respostas |
| `i` | `1` em `bind` (e no scan), `0` nas demais mensagens |
| `uid` | `0` (não usado no protocolo local) |
| `t` | `"pack"` para mensagens cifradas, `"scan"` para a busca |
| `pack` | JSON cifrado, em Base64 |
| `tag` | **só V2**: tag de autenticação GCM, em Base64 |

Nas respostas de descoberta, `i` também aparece e `tcid` vem vazio.

---

## 4. Descoberta (scan)

Pedido **em texto claro**, enviado ao broadcast da rede ou em unicast:

```json
{"t": "scan"}
```

Resposta (envelope + `pack` decifrado com a chave genérica da geração):

```json
{
  "t": "pack",
  "i": 1,
  "uid": 0,
  "cid": "502cc6aabbcc",
  "tcid": "",
  "pack": "<Base64>"
}
```

Conteúdo decifrado:

```json
{
  "t": "dev",
  "cid": "502cc6aabbcc",
  "mac": "502cc6aabbcc",
  "bc": "gree",
  "brand": "gree",
  "catalog": "gree",
  "mid": "10001",
  "model": "gree",
  "name": "Sala",
  "series": "gree",
  "vender": "1",
  "ver": "V1.1.13",
  "lock": 0
}
```

`mid` identifica a família/modelo e é útil para escolher quais propriedades consultar.
Alguns firmwares V2 respondem ao scan **já em GCM**; por isso o cliente tenta V1 e,
se falhar, V2.

---

## 5. Pareamento (bind)

Pedido (índice `i = 1`), `pack` cifrado com a chave **genérica**:

```json
{
  "cid": "app",
  "i": 1,
  "t": "pack",
  "uid": 0,
  "tcid": "502cc6aabbcc",
  "pack": "<Base64 de {\"mac\":\"502cc6aabbcc\",\"t\":\"bind\",\"uid\":0}>"
}
```

Resposta (`pack` ainda com a chave genérica):

```json
{"t": "bindok", "mac": "502cc6aabbcc", "key": "Pq9St2Vw5YzXxXxX", "r": 200}
```

A partir daqui todas as mensagens usam `key` (mesma geração de cifra). O campo `r`
é o código de resultado (`200` = ok).

> Se o aparelho for pareado de novo no app oficial, a chave muda e o bind precisa ser
> refeito. Este cliente detecta a falha e refaz o pareamento automaticamente na
> interface web.

---

## 6. Consulta de estado (status)

Pedido (`i = 0`), cifrado com a chave do aparelho:

```json
{
  "cid": "app", "i": 0, "t": "pack", "uid": 0, "tcid": "502cc6aabbcc",
  "pack": "<Base64 de {\"cols\":[\"Pow\",\"Mod\",\"SetTem\"],\"mac\":\"502cc6aabbcc\",\"t\":\"status\"}>"
}
```

Resposta:

```json
{
  "t": "dat",
  "mac": "502cc6aabbcc",
  "cols": ["Pow", "Mod", "SetTem"],
  "dat": [1, 1, 24]
}
```

`cols` e `dat` são **listas posicionais**: o n-ésimo valor corresponde à n-ésima
coluna. Propriedades não suportadas pelo modelo simplesmente não aparecem na resposta.

---

## 7. Comando (cmd)

Pedido:

```json
{
  "cid": "app", "i": 0, "t": "pack", "uid": 0, "tcid": "502cc6aabbcc",
  "pack": "<Base64 de {\"opt\":[\"Pow\",\"SetTem\",\"Mod\"],\"p\":[1,22,1],\"mac\":\"502cc6aabbcc\",\"t\":\"cmd\"}>"
}
```

Resposta:

```json
{"t": "res", "mac": "502cc6aabbcc", "opt": ["Pow","SetTem","Mod"], "val": [1,22,1], "r": 200}
```

O aplicativo oficial sempre inclui `BuzzerCtrl` (`1` = bipe habilitado, `0` = silencioso)
nos comandos; firmwares novos usam esse campo em vez de `Buzzer_ON_OFF`.

---

## 8. Cifras em detalhe

### V1 — AES-128-ECB

1. Serializa o JSON interno com `json.dumps` (separadores padrão).
2. Aplica padding **PKCS#7** até múltiplo de 16 bytes.
3. Cifra em AES-128-ECB com a chave ASCII.
4. Codifica em Base64 e coloca em `pack`.

Decifrar é o inverso. Alguns firmwares usam padding em caracteres ASCII imprimíveis;
por isso a leitura descarta tudo após o último `}` antes de interpretar o JSON.

### V2 — AES-128-GCM

1. Serializa o JSON interno (sem padding).
2. Cifra com AES-128-GCM usando `nonce` e `AAD` fixos da tabela acima.
3. `pack` = Base64(ciphertext); `tag` = Base64(tag GCM).
4. O envelope recebe o campo extra `tag`.

O cliente valida a tag quando ela está presente; se um firmware antigo não enviar
`tag` em alguma resposta, a decifragem continua (sem verificação de autenticidade).

---

## 9. Propriedades observadas

| Propriedade | Faixa / valores | Observação |
|---|---|---|
| `Pow` | 0/1 | liga/desliga |
| `Mod` | 0 auto, 1 cool, 2 dry, 3 fan, 4 heat | modo de operação |
| `SetTem` | 8–30 | alvo em °C (ver `TemUn`) |
| `TemSen` | inteiro | sensor ambiente; na maioria dos modelos tem **offset +40** |
| `TemUn` | 0 °C, 1 °F | unidade configurada no aparelho |
| `TemRec` | 0/1 | fração de 0,5 °C do alvo (em °F) |
| `WdSpd` | 0 auto … 5 alto | velocidade do ventilador |
| `SwUpDn` | 0–11 | posição/oscilação da aleta vertical |
| `SwingLfRig` | 0–6 | aleta horizontal |
| `Lig` | 0/1 | luz do painel |
| `SwhSlp` / `SlpMod` | 0/1 | modo sleep (enviar os dois juntos) |
| `Tur` | 0/1 | turbo |
| `Quiet` | 0 ou 2 | modo silencioso (2 = ativo) |
| `Blo` | 0/1 | XFan (secagem da serpentina) |
| `Health` | 0/1 | gerador de íons |
| `Air` | 0/1 | entrada de ar novo, quando existe |
| `StHt` | 0/1 | aquecimento constante (8 °C) |
| `SvSt` | 0/1 | economia de energia |
| `HeatCoolType` | 0/1 | tipo heat/cool do modelo |
| `BuzzerCtrl` | 0/1 | bipe ao receber comando |
| `Dwet`, `DwatSen`, `Dfltr`, `DwatFul`, `Dmod` | — | desumidificadores |
| `hid` | string | identificação de firmware, ex.: `362001000762+U-CS532AE(LT)V3.31.bin` |

`TemSen` com offset: valor 66 → 26 °C. Modelos com `relearn` podem reportar sem o
offset; a heurística usada é `valor >= 40 ? valor - 40 : valor`.

---

## 10. Capturando e decifrando

Com o celular e o PC na mesma rede:

```bash
# Linux/macOS
sudo tcpdump -i any -n -s0 -A udp port 7000

# Windows: Wireshark, filtro "udp.port == 7000"
```

Copie o valor de `pack` de um pacote e decifre com a própria ferramenta:

```bash
python gree.py decode --pack 'B64...'                 # tenta as chaves genéricas (v1 e v2)
python gree.py decode --pack 'B64...' --tag 'B64...'  # respostas v2
python gree.py decode --pack 'B64...' --key 'ChaveDoAparelho' --protocol v1
```

Saída: o JSON interno já formatado.

---

## 11. Limites deste documento

- O protocolo não é oficial e pode mudar por firmware.
- Alguns modelos expõem propriedades adicionais; `status --raw` revela o que o seu
  aparelho responde.
- Recursos de nuvem (agenda, consumo, atualização de firmware) usam HTTPS e não são
  cobertos aqui.
