# WinDirStat 2.9.3 Desktop para PC (Reconstrução Clean-Room via REA)

Este pacote contém o aplicativo **WinDirStat 2.9.3** reconstruído com o **REA (`rea-agents@6.7.0`)**, pronto para rodar no seu PC (**Windows, Linux ou macOS**).

## Como Executar no Seu PC (3 Formas)

### 1. Um Clique no Windows / Linux / macOS (Recomendado)
- **No Windows**: dê duplo-clique em **`Iniciar-WinDirStat-Windows.bat`**.
- **No Linux / macOS**: execute no terminal:
  ```bash
  chmod +x iniciar-windirstat-linux-mac.sh
  ./iniciar-windirstat-linux-mac.sh
  ```
Isso inicia o motor local (`server.mjs`) e abre automaticamente a janela do aplicativo com **Cushion Treemap 3D**, **Sunburst Radial**, **FlameGraph**, **Árvore de Diretórios**, **Top Maiores Arquivos**, **Detector de Duplicatas** e **Seletor de Pastas do PC**.

### 2. Janela Desktop Nativa em Python + Tkinter (Zero Dependências)
Se você tem Python instalado no PC e prefere uma janela nativa do sistema operacional sem usar navegador:
```bash
python windirstat_desktop.py
# Ou passando uma unidade/pasta diretamente:
python windirstat_desktop.py C:\
```

### 3. Modo Electron Desktop
Se desejar executar dentro do container nativo do Electron:
```bash
npx electron .
```
