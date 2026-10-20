# Dossiê de Engenharia Reversa: WinDirStat 2.9.3 (via REA)

Este documento registra a investigação e reconstrução _clean-room_ do **WinDirStat 2.9.3** (`windirstat/windirstat`) conduzida com o **REA (`rea-agents@6.7.0`)**, preservando a cadeia de custódia criptográfica (`Evidence IDs`, `SHA-256` e `HistoricalSourceManifest`) e a correspondência matemática exata dos algoritmos de visualização e varredura.

---

## 1. Proveniência e Evidências Geradas pelo REA

| Operação REA | Comando Executado | Identificador / Digest | Escopo Observado |
| :--- | :--- | :--- | :--- |
| `import_reference_source` | `rea import-reference-source _reference/windirstat/repo --detail summary --outline-depth 3 --format json` | Manifest: `hsm_0cd4323b0936071cb108f08b3b883c6e3a011a10bdc016bd7454a56d32fad44d`<br>Graph SHA-256: `ce0108bc72d9c43d528d25f67ad58a285fc829731519d3fd1d826d2f5df552b8`<br>Root SHA-256: `bd2b0886e1b698a4d64469dc994bcd96d27ac52c3cc1376a8e0b95c78d3dd348` | Commit `9320b4f57f68dff3e572a3aa6b6015edb6f2262e` (`v2.9.3`), 287 entradas (267 arquivos, 20 diretórios), `4.019.556` bytes verificados |
| `inspect_desktop_application` | `rea inspect-desktop-application _reference/windirstat/repo --detail summary --evidence_output _reference/windirstat/desktop-evidence-bundle --format json` | Parent Evidence: `ev_d6b48f6e8a5c1746db23808df7f245199653c6b8191da381b1300956be580773`<br>View Evidence: `ev_fe1d408f226967bea2172958c3404f6339adbb1e5d7817fe7ac7f4182336fdd1`<br>Snapshot SHA-256: `e445341cde316adae9f7875f1d077d170dd8a24d8d914937faf8b10e99561bfc` | 336 entradas examinadas, cobertura `complete-within-scan` |
| `analyze_javascript_application` | `rea analyze-javascript-application website/public/windirstat --format json` | Evidence: `ev_ab25adfca0891ec58322867157368a76b823e23b8e156f8bd6a52e6c18653f4d`<br>Manifest: `agm_5ced8b668b3562438aa327fc090c645d519a42b98cccd4cfa9b9878ed864747a`<br>Graph SHA-256: `e15fc32b06af8c0d23828f21de592985c7b06f822b96c1bbc54c8b4888b2d2f8` | Grafo estático e semântico da reconstrução web (`website/public/windirstat`) |

---

## 2. Arquitetura Interna do WinDirStat 2.9.3

A arquitetura do WinDirStat é dividida em quatro subsistemas principais:

```
┌───────────────────────────────────────────────────────────────────────────┐
│                         WinDirStatMainFrame / Views                       │
│  ┌──────────────────────┐ ┌─────────────────────┐ ┌────────────────────┐  │
│  │   FileTabbedView     │ │    ExtensionView    │ │ VisualizationPane  │  │
│  │ - CTreeListControl   │ │ - CExtensionList    │ │ - CTreeMapView     │  │
│  │ - CFileTopControl    │ │   (18-color cushion │ │ - CSunburstView    │  │
│  │ - CFileDupeControl   │ │    legend swatches) │ │ - CFlameGraphView  │  │
│  │ - CFileSearchControl │ └─────────────────────┘ └────────────────────┘  │
│  └──────────┬───────────┘            ▲                       ▲            │
└─────────────┼────────────────────────┼───────────────────────┼────────────┘
              │                        │                       │
              ▼                        ┴───────────────────────┘
┌───────────────────────────────────────────────────────────────────────────┐
│                   Modelo Hierárquico Unificado (`CItem`)                  │
│  Herda de `CTreeListItem` (zero clonagem entre modelo de dados e UI).     │
│  Mantém `m_sizePhysical`, `m_sizeLogical`, `m_lastChange`, `m_index`,     │
│  e bitmask `ITEMTYPE` de 32 bits (`IT_*`, `ITHASH_*`, `ITRP_*`, `ITF_*`). │
└──────────────────────────────────────▲────────────────────────────────────┘
                                       │
┌──────────────────────────────────────┴────────────────────────────────────┐
│                    Motores de Varredura (`Finder*`)                       │
│  - `FinderNtfs`: leitura direta da MFT (`FILE_RECORD` 'FILE' 0x454C4946)  │
│  - `FinderBasic`: pool multi-thread com `BlockingQueue` + `FindFirstFile` │
│  - `FinderMtp` / `FinderRemote`: dispositivos portáteis WPD e shares SMB  │
└───────────────────────────────────────────────────────────────────────────┘
```

### 2.1. Modelo de Dados Unificado (`CItem` — `windirstat/Item.h`, `Item.cpp`)
- **Zero-Copy UI Binding**: `CItem` deriva diretamente de `CTreeListItem` com `__declspec(empty_bases)`. Nenhum nó é duplicado para exibição na árvore visual (`CTreeListControl`).
- **Bitmask `ITEMTYPE` (`uint32_t`)**:
  - **Bits 0–9 (`IT_MASK = 0x00003FFF`)**: tipo estrutural do nó:
    - `IT_MYCOMPUTER (1 << 0)`, `IT_DRIVE (1 << 1)`, `IT_DIRECTORY (1 << 2)`, `IT_FILE (1 << 3)`
    - Pseudo-itens especiais: `IT_FREESPACE (1 << 4)` (`<Free Space>`), `IT_UNKNOWN (1 << 5)` (`<Unknown>`), `IT_HLINKS (1 << 6)` (`<Hardlinks>` e subconjuntos `IT_HLINKS_SET`, `IT_HLINKS_IDX`, `IT_HLINKS_FILE` para evitar contagem duplicada de hardlinks NTFS).
  - **Bits 16–19 (`ITHASH_MASK = 0x000F0000`)**: estágio de hash progressivo para detecção de duplicatas (`ITHASH_SKIP`, `ITHASH_SMALL`, `ITHASH_MEDIUM`, `ITHASH_LARGE`).
  - **Bits 20–23 (`ITRP_MASK = 0x00F00000`)**: reparse points (`ITRP_SYMLINK`, `ITRP_MOUNT`, `ITRP_JUNCTION`, `ITRP_CLOUD` para arquivos OneDrive/Cloud placeholders).
- **Tamanho Físico vs. Lógico**:
  - `m_sizeLogical`: tamanho declarado do arquivo (EOF).
  - `m_sizePhysical`: bytes efetivamente alocados no disco (considerando alinhamento de cluster, compressão NTFS, arquivos esparsos e placeholders de nuvem não hidratados).

---

## 3. Motores de Varredura de Alta Velocidade (`FinderNtfs.cpp` & `FinderBasic.cpp`)

### 3.1. Leitura Direta da MFT (`FinderNtfs.cpp`)
Quando executado com privilégios suficientes em volumes NTFS locais, o WinDirStat contorna a enumeração Win32 tradicional e interpreta diretamente os registros da **Master File Table (MFT)**:
- Valida o cabeçalho `FILE_RECORD` verificando `Signature == 0x454C4946` (`'FILE'`) e o bit `Flags & 0x0001` (`IsInUse`) e `Flags & 0x0002` (`IsDirectory`).
- Identifica cada registro pelo `SegmentNumber` de 48 bits (`(SegmentNumberHighPart << 32) | SegmentNumberLowPart`) combinado com `SequenceNumber` (16 bits).
- Percorre os atributos variáveis (`ATTRIBUTE_RECORD`) a partir de `FirstAttributeOffset`:
  - `0x10` (`AttributeStandardInformation`): timestamps e flags básicos.
  - `0x30` (`AttributeFileName`): nome Unicode, `ParentDirectory` (48 bits) e filtro de nomes curtos DOS (`Flags == 0x02`).
  - `0x80` (`AttributeData`): distingue dados **Residentes** (armazenados dentro do próprio registro MFT) de **Não-Residentes** (`FormCode & 0x0001`), lendo `AllocatedLength`, `FileSize` e `Compressed` para arquivos comprimidos/esparsos.
  - `0xC0` (`AttributeReparsePoint`): identifica symlinks, junctions, mount points e cloud files.

### 3.2. Varredura Paralela (`FinderBasic.cpp` + `BlockingQueue.h`)
Para volumes não-NTFS, pastas individuais ou sem privilégio de volume bruto, utiliza `FindFirstFileExW` com `FindExInfoBasic` e `FIND_FIRST_EX_LARGE_FETCH`, distribuindo subdiretórios em uma fila bloqueante (`BlockingQueue<CItem*>`) consumida por múltiplas threads trabalhadoras.

---

## 4. Engenharia Reversa Matemática do Cushion Treemap (`TreeMap.h`, `TreeMap.cpp`, `TreeMapLayout.cpp`)

O visual característico do WinDirStat (baseado em _Cushion Treemaps_ de Jarke J. van Wijk & Huub van de Wetering e no KDirStat/SequoiaView) é produzido por três componentes matemáticos exatos:

### 4.1. Superfície Parabólica Cumulativa (`CTreeMap::AddRidge`)
Cada nó na árvore possui um vetor de coeficientes `Surface = [s0, s1, s2, s3]` (inicializado em `[0, 0, 0, 0]` na raiz) e uma altura de crista `ridgeHeight` (inicializada em $H = 0.38$). Ao descer um nível na hierarquia, a altura é multiplicada pelo fator de escala $F = 0.91$:

$$h_{\text{filho}} = h_{\text{pai}} \cdot F$$

Para cada retângulo filho $R = [x_1, x_2] \times [y_1, y_2]$ com largura $W = x_2 - x_1$ e altura $H_r = y_2 - y_1$, `AddRidge` acumula uma parábola côncava em $x$ e $y$:

$$w_f = \frac{4h}{x_2 - x_1}, \qquad h_f = \frac{4h}{y_2 - y_1}$$

$$s_0 \leftarrow s_0 - w_f, \qquad s_2 \leftarrow s_2 + w_f \cdot (x_2 + x_1)$$

$$s_1 \leftarrow s_1 - h_f, \qquad s_3 \leftarrow s_3 + h_f \cdot (y_2 + y_1)$$

### 4.2. Sombreamento Lambertiano por Pixel (`CTreeMap::DrawCushion`)
O vetor da fonte de luz é normalizado em `CTreeMap::SetOptions` fixando $l_z = 10$:

$$\vec{L} = \frac{(L_x, L_y, 10)}{\sqrt{L_x^2 + L_y^2 + 100}}$$

Com os valores padrão ($L_x = -1.0$, $L_y = -1.0$), a luz vem do canto superior esquerdo. Para cada pixel $(i_x, i_y)$ dentro de uma folha (`RenderLeaf`), avaliado no centro do pixel $(i_x + 0.5, i_y + 0.5)$, as derivadas parciais da superfície determinam o vetor normal $[n_x, n_y, 1]$:

$$n_x = -\bigl(2 s_0 (i_x + 0.5) + s_2\bigr), \qquad n_y = -\bigl(2 s_1 (i_y + 0.5) + s_3\bigr)$$

O cosseno do ângulo entre a normal e a fonte de luz é:

$$\cos\alpha = \min\!\left(1.0,\; \frac{n_x l_x + n_y l_y + l_z}{\sqrt{n_x^2 + n_y^2 + 1.0}}\right)$$

A intensidade luminosa final $I \in [I_a, 1.0]$ combina a luz ambiente $I_a$ (`ambientLight = 0.13`) e a luz difusa $I_s = 1 - I_a$:

$$I = I_a + (1 - I_a)\max(0.0, \cos\alpha)$$

Por otimização em `DrawCushion`, $n_x$ é atualizado incrementalmente ao longo da linha horizontal com passo constante $\Delta n_x = -2 s_0$.

### 4.3. Espaço de Cores e Redistribuição de Saturação (`CColorSpace`)
Todas as 18 cores padrão (`DefaultCushionColors`) são normalizadas em `GetDefaultPalette()` para terem exatamente o mesmo brilho aritmético `GraphPaletteBrightness = 0.6`:

$$B_{\text{aritmético}}(R,G,B) = \frac{R + G + B}{3 \times 255}$$

Quando um canal $(R, G \text{ ou } B)$ ultrapassa `255` durante `MakeBrightColor` ou `DrawCushion`, `CColorSpace::NormalizeColor` chama `DistributeFirst(first, second, third)` para redistribuir o excesso igualmente entre os outros dois canais em vez de simplesmente truncar em `255` (o que preserva a luminosidade percebida nos brilhos especulares das almofadas):

```cpp
const int h = (first - 255) / 2;
first = 255;
second += h;
third += h;
```

### 4.4. Algoritmos de Layout (`TreeMapLayout.cpp` & `HilbertMooreTreeMap.cpp`)
O WinDirStat 2.9.3 suporta 4 estilos de particionamento (`TreeMapLayout::Style`):
1. **`Rows` (`ArrangeRows` — estilo KDirStat)**:
   - Divide o retângulo em faixas horizontais (se $\text{Width} \ge \text{Height}$) ou verticais (caso contrário).
   - Adiciona filhos ordenados decrescentemente por peso na faixa atual enquanto a proporção do filho satisfizer `childWidth / candidateFraction >= MinProportion` (`0.4`).
2. **`Squarified` (`ArrangeSquarified` — estilo SequoiaView / Bruls et al.)**:
   - Minimiza gulosamente o pior _aspect ratio_ da faixa atual:
     $$\text{worst} = \max\!\left(\frac{w^2 \cdot s_{\max}}{s^2},\; \frac{s^2}{w^2 \cdot s_{\min}}\right)$$
     onde $w^2 = \text{rowThickness}^2 \cdot \text{weightPerPixel}$, $s$ é a soma dos pesos na faixa, $s_{\max}$ o maior item da faixa e $s_{\min}$ o item recém-testado.
3. **`Hilbert` e `Moore` (`HilbertMooreTreeMap.cpp`)**:
   - Particionamento recursivo em quadrantes seguindo curvas de preenchimento de espaço de Hilbert e Moore (adaptado do protótipo do Hasso Plattner Institute) usando 14 padrões de divisão (`Identity`, `Hilbert2`, `Moore2`, `Snake3`, `First3`, `Middle3`, `Last3`, `Snake4`, etc.).

### 4.5. Índice Espacial de Hit-Testing (`CTreeMap::BuildHitTestIndex`)
Para responder instantaneamente a `FindItemByPoint(point)` ao mover o mouse ou clicar:
- A área de renderização é dividida em uma grade uniforme de células de **$16 \times 16$ pixels** (`HitTestCellSize = 16`).
- Nós internos (diretórios) têm seus filhos ladrilhando um retângulo interno; para evitar indexar a área inteira de cada ancestral em todas as células (o que multiplicaria o uso de memória pela profundidade da árvore), `BuildHitTestIndex` decompõe a borda exclusiva do diretório em até **4 faixas retangulares** (topo, base, esquerda, direita) e armazena os candidatos em vetores CSR compactos (`m_hitTestCellOffsets` e `m_hitTestEntries`).

---

## 5. Aplicação Web Reconstruída (`/windirstat/`)

A reconstrução interativa está disponível em `website/public/windirstat/` (servida no preview ao vivo em `/windirstat/`) e implementa fielmente:
- **`CTreeMap` + `TreeMapLayout`**: renderização pixel-a-pixel em `<canvas>` com `AddRidge`, `DrawCushion`, `MakeBrightColor`, `NormalizeColor`, `ArrangeRows` (KDirStat) e `ArrangeSquarified` (SequoiaView).
- **Presets Oficiais do WinDirStat 2.9.3**: `Classic`, `Calm`, `Flat`, `Pastel` e `HighContrast`, além de controles deslizantes em tempo real para `Brightness`, `Cushion Height (H)`, `Scale Factor (F)` e `Ambient Light (Ia)`.
- **Visualizações Extras do 2.9.3**: alternância para **Sunburst Radial (`CSunburst`)** e **FlameGraph (`CFlameGraph`)**.
- **Painéis Sincronizados**:
  - `CTreeListControl` com barras gráficas de subárvore (`COL_SIZE_PROPORTION`), tamanhos físico/lógico e zoom por duplo-clique.
  - `CExtensionListControl` com amostras 3D renderizadas via `DrawColorPreview`.
  - `CFileTopControl` (maiores arquivos) e `CFileDupeControl` (agrupamento de duplicatas por hash/tamanho e cálculo de espaço desperdiçado).
