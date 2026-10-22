# Sonora Studio — painel local para spotDL

Painel em português para enfileirar faixas, álbuns e playlists do Spotify pelo [spotDL](https://github.com/spotDL/spotify-downloader) (CLI oficial instalado via PyPI). Os arquivos são organizados em `downloads/{artist}/{album}/` e salvos com a capa do álbum e os metadados disponíveis.

> **Importante:** spotDL não baixa o áudio diretamente do Spotify. Ele localiza uma versão correspondente em provedores de áudio (como o YouTube) e usa as informações do Spotify para preencher os metadados e a arte. Use somente conteúdo que você tem autorização para baixar e respeite os termos dos serviços e a legislação local. Este projeto não é afiliado ao Spotify nem ao spotDL.

## O que o painel oferece

- Interface web responsiva em português, sem dependências de frontend.
- Fila local para links de faixas, álbuns e playlists.
- Escolha de formato (MP3, M4A, FLAC, OGG, OPUS ou WAV) e qualidade.
- Capa e metadados incorporados pelo spotDL; arquivos organizados por artista e álbum.
- Registro por tarefa e indicadores de spotDL, FFmpeg e Deno.
- Preparação de FFmpeg e Deno pelo próprio painel quando spotDL já estiver instalado.
- API validada, fila serial, sem shell para executar URLs, e destino configurável.

## Requisitos

- Python 3.10 a 3.14. spotDL 4.5.2 ainda não é compatível com Python 3.15; recomendamos Python 3.14 ou 3.13.
- Acesso à internet para instalar dependências e baixar os recursos de FFmpeg/Deno.
- FFmpeg (obrigatório para conversão e gravação de tags). Deno é recomendado pelo spotDL para algumas fontes do YouTube.

## Instalação rápida

### Linux / macOS

```bash
./setup.sh
.venv/bin/python server.py
```

Abra <http://localhost:8765>.

O instalador seleciona uma versão compatível do Python, cria o ambiente virtual, instala spotDL e prepara FFmpeg. Deno é tentado como etapa opcional/recomendada. Se preferir instalar manualmente, use Python 3.14 (ou 3.13):

```bash
python3.14 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m spotdl --download-ffmpeg
python -m spotdl --download-deno  # opcional, recomendado
python server.py
```

Se `pip` disser que não há versão compatível do spotDL, confira `python --version`: Python 3.15 ainda não é suportado. No Windows, o `setup.ps1` procura automaticamente uma instalação de Python 3.14 a 3.10 via launcher `py`; uma `.venv` antiga incompatível será recriada.

### Windows (PowerShell)

```powershell
.\setup.ps1
.\.venv\Scripts\python.exe server.py
```

O instalador usa `py` para escolher a versão compatível mais recente. Se você tiver apenas Python 3.15, instale Python 3.14 (ou 3.13) e rode `setup.ps1` novamente. Depois, acesse <http://localhost:8765>.

## Configuração

Por padrão, os arquivos ficam na pasta `downloads/` deste projeto. Para alterar o destino, defina `SPOTDL_OUTPUT_DIR` antes de iniciar o painel:

```bash
SPOTDL_OUTPUT_DIR="$HOME/Music" .venv/bin/python server.py
```

No PowerShell:

```powershell
$env:SPOTDL_OUTPUT_DIR = "$HOME\Music"
.\.venv\Scripts\python.exe server.py
```

O servidor usa `0.0.0.0` por padrão para permitir a pré-visualização. Em um computador pessoal, prefira mantê-lo em uma rede confiável e não o exponha diretamente à internet: o painel não implementa autenticação de usuários.

## Uso

1. Instale spotDL e FFmpeg pelos comandos acima (ou pela seção **Integração** do painel).
2. Cole um link HTTPS `open.spotify.com` ou uma URI `spotify:track:…`, `spotify:album:…` ou `spotify:playlist:…`.
3. Escolha o formato e a qualidade, então selecione **Adicionar à fila**.
4. Acompanhe o estado e o registro na seção **Fila de downloads**.

A fila e os registros ficam em memória enquanto o servidor está ativo. Os arquivos baixados permanecem no diretório de destino.

## Desenvolvimento e testes

A interface e a API usam apenas a biblioteca padrão do Python. Para testar a validação e a montagem do comando:

```bash
python -m unittest discover -s tests -v
```
