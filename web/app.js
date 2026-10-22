const elements = {
  connectionDot: document.getElementById('connectionDot'),
  connectionLabel: document.getElementById('connectionLabel'),
  todayLabel: document.getElementById('todayLabel'),
  destinationLabel: document.getElementById('destinationLabel'),
  queuedCount: document.getElementById('queuedCount'),
  runningCount: document.getElementById('runningCount'),
  completedCount: document.getElementById('completedCount'),
  navPending: document.getElementById('navPending'),
  libraryCount: document.getElementById('libraryCount'),
  downloadForm: document.getElementById('downloadForm'),
  spotifyUrl: document.getElementById('spotifyUrl'),
  urlField: document.getElementById('urlField'),
  urlError: document.getElementById('urlError'),
  clearUrl: document.getElementById('clearUrl'),
  audioFormat: document.getElementById('audioFormat'),
  bitrate: document.getElementById('bitrate'),
  submitButton: document.getElementById('submitButton'),
  submitLabel: document.getElementById('submitLabel'),
  spotdlDetail: document.getElementById('spotdlDetail'),
  spotdlState: document.getElementById('spotdlState'),
  ffmpegState: document.getElementById('ffmpegState'),
  denoState: document.getElementById('denoState'),
  integrationLight: document.getElementById('integrationLight'),
  integrationMessage: document.getElementById('integrationMessage'),
  prepareButton: document.getElementById('prepareButton'),
  installHint: document.getElementById('installHint'),
  installHintText: document.getElementById('installHintText'),
  installHintCommand: document.getElementById('installHintCommand'),
  refreshButton: document.getElementById('refreshButton'),
  queueSubtitle: document.getElementById('queueSubtitle'),
  jobList: document.getElementById('jobList'),
  librarySubtitle: document.getElementById('librarySubtitle'),
  libraryLocation: document.getElementById('libraryLocation'),
  libraryGrid: document.getElementById('libraryGrid'),
  libraryEmpty: document.getElementById('libraryEmpty'),
  libraryEmptyTitle: document.getElementById('libraryEmptyTitle'),
  libraryEmptyText: document.getElementById('libraryEmptyText'),
  librarySearch: document.getElementById('librarySearch'),
  libraryRefreshButton: document.getElementById('libraryRefreshButton'),
  librarySettingsButton: document.getElementById('librarySettingsButton'),
  emptyLibrarySettingsButton: document.getElementById('emptyLibrarySettingsButton'),
  settingsDialog: document.getElementById('settingsDialog'),
  settingsForm: document.getElementById('settingsForm'),
  outputDirInput: document.getElementById('outputDirInput'),
  settingsCurrentDir: document.getElementById('settingsCurrentDir'),
  settingsHelp: document.getElementById('settingsHelp'),
  settingsNotice: document.getElementById('settingsNotice'),
  settingsError: document.getElementById('settingsError'),
  saveSettingsButton: document.getElementById('saveSettingsButton'),
  closeSettingsButton: document.getElementById('closeSettingsButton'),
  resetDestinationButton: document.getElementById('resetDestinationButton'),
  navConfigButton: document.getElementById('navConfigButton'),
  openDestinationSettings: document.getElementById('openDestinationSettings'),
  toast: document.getElementById('toast'),
};

let currentHealth = null;
let toastTimeout = null;
let jobsRefreshing = false;
let libraryRefreshing = false;
let libraryRefreshPending = false;
let libraryItems = [];
let libraryTotal = 0;
let libraryTruncated = false;
let lastCompletedSignature = null;

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', isError);
  elements.toast.classList.add('visible');
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => elements.toast.classList.remove('visible'), 3600);
}

function setToolState(element, state, text) {
  element.className = `tool-state ${state}`;
  element.textContent = text;
}

function updateHealth(health) {
  currentHealth = health;
  elements.connectionLabel.textContent = 'online';
  elements.connectionDot.classList.add('connected');
  elements.destinationLabel.textContent = health.output_dir || './downloads';
  elements.destinationLabel.title = health.output_dir || './downloads';
  elements.libraryLocation.textContent = health.output_dir || './downloads';
  elements.settingsCurrentDir.textContent = health.output_dir || './downloads';
  const destinationLocked = Boolean(health.output_dir_locked);
  elements.outputDirInput.disabled = destinationLocked;
  elements.saveSettingsButton.disabled = destinationLocked;
  elements.resetDestinationButton.disabled = destinationLocked;
  elements.settingsHelp.textContent = destinationLocked
    ? 'O destino está fixado pela variável de ambiente SPOTDL_OUTPUT_DIR.'
    : 'Informe um caminho completo ou relativo ao projeto. A pasta será criada se ainda não existir.';
  elements.settingsNotice.textContent = destinationLocked
    ? 'Altere SPOTDL_OUTPUT_DIR no terminal para mudar o destino.'
    : 'Arquivos já baixados permanecem na pasta antiga; mudar o destino não os move.';

  const unsupportedPython = health.python_supported === false;
  if (unsupportedPython) {
    elements.spotdlDetail.textContent = `Python ${health.python_version || ''} não suportado`;
    setToolState(elements.spotdlState, 'bad', 'PYTHON');
  } else if (health.spotdl_installed) {
    elements.spotdlDetail.textContent = health.spotdl_version
      ? `Versão ${health.spotdl_version} · pronta`
      : 'Instalação encontrada';
    setToolState(elements.spotdlState, 'good', 'ENCONTRADO');
  } else {
    elements.spotdlDetail.textContent = 'Instalação necessária';
    setToolState(elements.spotdlState, 'bad', 'AUSENTE');
  }

  setToolState(
    elements.ffmpegState,
    health.ffmpeg_installed ? 'good' : 'bad',
    health.ffmpeg_installed ? 'PRONTO' : 'NECESSÁRIO',
  );
  setToolState(
    elements.denoState,
    health.deno_installed ? 'good' : 'waiting',
    health.deno_installed ? 'PRONTO' : 'RECOMENDADO',
  );

  elements.integrationLight.classList.toggle('ready', Boolean(health.can_download));
  elements.integrationLight.setAttribute(
    'aria-label',
    health.can_download ? 'Integração pronta' : 'Configuração necessária',
  );

  if (!health.spotdl_installed || unsupportedPython) {
    if (unsupportedPython) {
      elements.integrationMessage.textContent = `Python ${health.python_version} não é compatível com spotDL 4.5.2. Instale Python 3.14 ou 3.13 e refaça o ambiente.`;
      elements.installHintText.textContent = 'Depois de instalar Python 3.14/3.13, rode o instalador:';
      elements.submitLabel.textContent = 'Use Python 3.14 ou 3.13';
    } else {
      elements.integrationMessage.textContent = 'O painel está ativo. Instale o spotDL para habilitar a fila de downloads.';
      elements.installHintText.textContent = 'Execute o instalador incluído no projeto:';
      elements.submitLabel.textContent = 'Instale o spotDL para continuar';
    }
    elements.installHintCommand.textContent = health.setup_command || 'bash setup.sh';
    elements.installHint.hidden = false;
    elements.prepareButton.hidden = true;
    elements.submitButton.disabled = true;
  } else if (!health.ffmpeg_installed) {
    elements.integrationMessage.textContent = 'O FFmpeg é necessário para converter áudio e gravar os metadados.';
    elements.installHint.hidden = true;
    elements.prepareButton.hidden = false;
    elements.prepareButton.disabled = false;
    elements.prepareButton.innerHTML = 'Preparar ferramentas <span aria-hidden="true">↗</span>';
    elements.submitButton.disabled = true;
    elements.submitLabel.textContent = 'Prepare o FFmpeg para continuar';
  } else {
    elements.installHint.hidden = true;
    elements.submitButton.disabled = false;
    elements.submitLabel.textContent = 'Adicionar à fila';
    if (!health.deno_installed) {
      elements.integrationMessage.textContent = 'Pronto para baixar. O Deno é recomendado para melhorar a compatibilidade com algumas fontes.';
      elements.prepareButton.hidden = false;
      elements.prepareButton.disabled = false;
      elements.prepareButton.innerHTML = 'Preparar ferramentas <span aria-hidden="true">↗</span>';
    } else {
      elements.integrationMessage.textContent = 'Tudo pronto. spotDL, FFmpeg e Deno estão disponíveis neste ambiente.';
      elements.prepareButton.hidden = true;
    }
  }
}

async function refreshHealth() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    if (!response.ok) throw new Error('Não foi possível consultar o ambiente.');
    updateHealth(await response.json());
  } catch (error) {
    elements.connectionLabel.textContent = 'sem conexão';
    elements.connectionDot.classList.remove('connected');
    elements.integrationMessage.textContent = 'Não foi possível consultar o servidor local. Atualize a página para tentar novamente.';
    elements.submitButton.disabled = true;
    elements.submitLabel.textContent = 'Servidor indisponível';
  }
}

function formatJobKind(job) {
  if (job.kind === 'prepare') return { title: 'Preparação de ferramentas', detail: 'FFmpeg e Deno · spotDL' };
  const url = String(job.url || '');
  let kind = 'Conteúdo do Spotify';
  let shortId = '';
  const uriMatch = url.match(/^spotify:(track|playlist|album):([A-Za-z0-9]+)/i);
  if (uriMatch) {
    kind = labelForKind(uriMatch[1]);
    shortId = uriMatch[2].slice(0, 7);
  } else {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      const type = segments.find((part) => ['track', 'playlist', 'album'].includes(part));
      const id = segments.at(-1);
      if (type) kind = labelForKind(type);
      if (id) shortId = id.slice(0, 7);
    } catch (_) {
      // The backend already validates the link. This is only a display fallback.
    }
  }
  return {
    title: `${kind}${shortId ? ` · ${shortId}…` : ''}`,
    detail: 'Spotify · capa e metadados incluídos',
  };
}

function labelForKind(kind) {
  const labels = { track: 'Faixa', playlist: 'Playlist', album: 'Álbum' };
  return labels[String(kind).toLowerCase()] || 'Conteúdo';
}

function statusForJob(status) {
  const labels = {
    queued: ['queued', 'Na fila'],
    running: ['running', 'Baixando'],
    completed: ['completed', 'Concluído'],
    failed: ['failed', 'Falhou'],
  };
  return labels[status] || ['queued', 'Aguardando'];
}

function timeForJob(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function createJobEntry(job) {
  const entry = createElement('article', 'job-entry');
  const row = createElement('div', 'job-row');
  const info = createElement('div', 'job-info');
  const cover = createElement('div', 'job-cover');
  cover.setAttribute('aria-hidden', 'true');
  cover.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  const copy = createElement('div', 'job-copy');
  const label = formatJobKind(job);
  copy.append(createElement('strong', '', label.title));
  copy.append(createElement('span', '', label.detail));
  info.append(cover, copy);

  const format = createElement('span', 'format-tag', job.kind === 'prepare' ? 'SETUP' : String(job.audio_format || 'mp3').toUpperCase());
  const [statusClass, statusText] = statusForJob(job.status);
  const status = createElement('span', `job-status ${statusClass}`, statusText);
  const date = createElement('span', 'job-date', timeForJob(job.created_at));
  row.append(info, format, status, date);
  entry.append(row);

  if (Array.isArray(job.logs) && job.logs.length) {
    const details = createElement('details', 'job-details');
    const summary = createElement('summary', '', 'Ver registro da tarefa');
    const logs = createElement('pre', 'job-logs', job.logs.join('\n'));
    details.append(summary, logs);
    entry.append(details);
  }
  return entry;
}

function renderJobs(jobs) {
  const downloads = jobs.filter((job) => job.kind === 'download');
  const queued = downloads.filter((job) => job.status === 'queued').length;
  const running = downloads.filter((job) => job.status === 'running').length;
  const completed = downloads.filter((job) => job.status === 'completed').length;
  elements.queuedCount.textContent = String(queued);
  elements.runningCount.textContent = String(running);
  elements.completedCount.textContent = String(completed);
  elements.navPending.textContent = String(queued + running);
  const completedSignature = downloads
    .filter((job) => job.status === 'completed')
    .map((job) => job.id)
    .sort()
    .join('|');
  if (lastCompletedSignature !== null && completedSignature !== lastCompletedSignature) refreshLibrary();
  lastCompletedSignature = completedSignature;
  elements.queueSubtitle.textContent = jobs.length
    ? `${jobs.length} tarefa${jobs.length === 1 ? '' : 's'} nesta sessão.`
    : 'Acompanhe cada arquivo em tempo real.';

  elements.jobList.replaceChildren();
  elements.jobList.setAttribute('aria-busy', 'false');
  if (!jobs.length) {
    const empty = createElement('div', 'empty-state');
    const icon = createElement('div', 'empty-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
    empty.append(icon, createElement('strong', '', 'Sua fila está vazia'), createElement('span', '', 'Cole um link do Spotify para adicionar a primeira tarefa.'));
    elements.jobList.append(empty);
    return;
  }
  for (const job of jobs) elements.jobList.append(createJobEntry(job));
}

async function refreshJobs() {
  if (jobsRefreshing) return;
  jobsRefreshing = true;
  try {
    const response = await fetch('/api/jobs', { cache: 'no-store' });
    if (!response.ok) throw new Error('Não foi possível atualizar a fila.');
    const data = await response.json();
    renderJobs(Array.isArray(data.jobs) ? data.jobs : []);
  } catch (_) {
    elements.jobList.setAttribute('aria-busy', 'false');
    if (!elements.jobList.children.length) {
      elements.jobList.append(createElement('div', 'empty-state', 'Não foi possível carregar a fila.'));
    }
  } finally {
    jobsRefreshing = false;
  }
}

function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function createLibraryCard(item) {
  const card = createElement('article', 'library-item');
  const art = createElement('div', 'library-art');
  art.setAttribute('aria-hidden', 'true');
  const fallback = createElement('div', 'library-art-fallback');
  fallback.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  art.append(fallback);
  if (item.artwork) {
    const image = document.createElement('img');
    image.src = `/api/artwork?path=${encodeURIComponent(item.path)}`;
    image.alt = '';
    image.loading = 'lazy';
    image.onerror = () => image.remove();
    art.append(image);
  }

  const title = createElement('h3', '', item.title || 'Faixa sem título');
  title.title = item.title || '';
  const artist = createElement('p', 'library-artist', item.artist || 'Artista desconhecido');
  artist.title = item.artist || '';
  const albumText = [item.album, item.year].filter(Boolean).join(' · ');
  const album = createElement('p', 'library-album', albumText || 'Álbum desconhecido');
  album.title = albumText;
  const footer = createElement('div', 'library-item-footer');
  footer.append(
    createElement('span', 'library-format', item.format || 'AUDIO'),
    createElement('span', 'library-size', formatBytes(item.size_bytes)),
  );
  card.append(art, title, artist, album, footer);
  return card;
}

function renderLibrary() {
  const query = elements.librarySearch.value.trim().toLocaleLowerCase('pt-BR');
  const visibleItems = libraryItems.filter((item) => {
    const searchable = `${item.title || ''} ${item.artist || ''} ${item.album || ''}`.toLocaleLowerCase('pt-BR');
    return !query || searchable.includes(query);
  });

  elements.libraryGrid.replaceChildren();
  elements.libraryGrid.setAttribute('aria-busy', 'false');
  elements.libraryCount.textContent = String(libraryTotal);
  elements.libraryLocation.textContent = currentHealth?.output_dir || './downloads';
  elements.librarySubtitle.textContent = libraryTruncated
    ? `Mostrando as ${visibleItems.length} mais recentes; há mais arquivos nesta pasta.`
    : `${libraryTotal} arquivo${libraryTotal === 1 ? '' : 's'} de áudio na pasta selecionada.`;

  if (!visibleItems.length) {
    elements.libraryEmpty.hidden = false;
    const searchActive = Boolean(query) && libraryTotal > 0;
    elements.libraryEmptyTitle.textContent = searchActive
      ? 'Nenhum resultado para essa busca'
      : 'Nenhuma música nesta pasta ainda';
    elements.libraryEmptyText.textContent = searchActive
      ? 'Tente buscar por outro título, artista ou álbum.'
      : 'Quando um download terminar, ele aparecerá aqui com a capa e os metadados.';
    elements.emptyLibrarySettingsButton.hidden = searchActive;
    return;
  }

  elements.libraryEmpty.hidden = true;
  for (const item of visibleItems) elements.libraryGrid.append(createLibraryCard(item));
}

async function refreshLibrary() {
  if (libraryRefreshing) {
    libraryRefreshPending = true;
    return;
  }
  libraryRefreshing = true;
  try {
    const response = await fetch('/api/library', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível carregar a biblioteca.');
    libraryItems = Array.isArray(data.items) ? data.items : [];
    libraryTotal = Number(data.total) || 0;
    libraryTruncated = Boolean(data.truncated);
    renderLibrary();
  } catch (error) {
    elements.libraryGrid.setAttribute('aria-busy', 'false');
    elements.libraryGrid.replaceChildren();
    elements.libraryEmpty.hidden = false;
    elements.libraryEmptyTitle.textContent = 'Não foi possível carregar a biblioteca';
    elements.libraryEmptyText.textContent = error.message || 'Verifique se o servidor está ativo e tente novamente.';
    elements.emptyLibrarySettingsButton.hidden = true;
  } finally {
    libraryRefreshing = false;
    if (libraryRefreshPending) {
      libraryRefreshPending = false;
      refreshLibrary();
    }
  }
}

function setFieldError(message) {
  elements.urlError.textContent = message;
  elements.urlField.classList.toggle('invalid', Boolean(message));
  elements.spotifyUrl.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function isLikelySpotifyLink(value) {
  const raw = value.trim();
  const uriMatch = raw.match(/^spotify:(track|playlist|album):([A-Za-z0-9]{10,64})$/i);
  if (uriMatch) return true;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || !['open.spotify.com', 'spotify.com', 'www.spotify.com'].includes(parsed.hostname.toLowerCase())) return false;
    return /^\/(?:intl-[A-Za-z0-9-]+\/)?(track|playlist|album)\/[A-Za-z0-9]{10,64}\/?$/i.test(parsed.pathname);
  } catch (_) {
    return false;
  }
}

async function submitDownload(event) {
  event.preventDefault();
  const url = elements.spotifyUrl.value.trim();
  if (!url) {
    setFieldError('Cole um link do Spotify.');
    elements.spotifyUrl.focus();
    return;
  }
  if (!isLikelySpotifyLink(url)) {
    setFieldError('Use um link de faixa, álbum ou playlist do Spotify.');
    elements.spotifyUrl.focus();
    return;
  }
  setFieldError('');
  if (!currentHealth || !currentHealth.can_download) {
    showToast('Configure o spotDL e o FFmpeg antes de adicionar downloads.', true);
    return;
  }

  const previousLabel = elements.submitLabel.textContent;
  elements.submitButton.disabled = true;
  elements.submitLabel.textContent = 'Adicionando à fila…';
  try {
    const response = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        url,
        format: elements.audioFormat.value,
        bitrate: elements.bitrate.value,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível adicionar esta tarefa.');
    elements.spotifyUrl.value = '';
    showToast('Link adicionado. O spotDL iniciará o download em breve.');
    await refreshJobs();
  } catch (error) {
    showToast(error.message || 'Erro ao adicionar o download.', true);
  } finally {
    elements.submitButton.disabled = !currentHealth?.can_download;
    elements.submitLabel.textContent = currentHealth?.can_download ? 'Adicionar à fila' : previousLabel;
  }
}

async function prepareTools() {
  if (!currentHealth?.spotdl_installed) {
    showToast('Instale o spotDL usando o comando exibido nesta seção.', true);
    return;
  }
  elements.prepareButton.disabled = true;
  elements.prepareButton.textContent = 'Preparando…';
  try {
    const response = await fetch('/api/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível preparar as ferramentas.');
    showToast('Preparação adicionada à fila. Acompanhe o registro abaixo.');
    await refreshJobs();
  } catch (error) {
    showToast(error.message || 'Erro ao preparar as ferramentas.', true);
  } finally {
    elements.prepareButton.disabled = false;
    await refreshHealth();
  }
}

function openSettingsDialog() {
  elements.settingsError.textContent = '';
  elements.outputDirInput.value = currentHealth?.output_dir || 'downloads';
  elements.settingsCurrentDir.textContent = currentHealth?.output_dir || 'downloads';
  elements.navConfigButton.classList.add('active');
  if (typeof elements.settingsDialog.showModal === 'function') {
    if (!elements.settingsDialog.open) elements.settingsDialog.showModal();
  } else {
    elements.settingsDialog.setAttribute('open', '');
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const value = elements.outputDirInput.value.trim();
  if (!value) {
    elements.settingsError.textContent = 'Informe o caminho da pasta.';
    elements.outputDirInput.focus();
    return;
  }
  elements.settingsError.textContent = '';
  elements.saveSettingsButton.disabled = true;
  elements.saveSettingsButton.textContent = 'Salvando…';
  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ output_dir: value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível salvar essa pasta.');
    elements.librarySearch.value = '';
    await refreshHealth();
    await refreshLibrary();
    elements.settingsDialog.close();
    showToast(`Destino atualizado: ${data.output_dir}`);
  } catch (error) {
    elements.settingsError.textContent = error.message || 'Erro ao salvar o destino.';
  } finally {
    elements.saveSettingsButton.textContent = 'Salvar destino';
    elements.saveSettingsButton.disabled = Boolean(currentHealth?.output_dir_locked);
  }
}

elements.downloadForm.addEventListener('submit', submitDownload);
elements.spotifyUrl.addEventListener('input', () => setFieldError(''));
elements.clearUrl.addEventListener('click', () => {
  elements.spotifyUrl.value = '';
  setFieldError('');
  elements.spotifyUrl.focus();
});
elements.prepareButton.addEventListener('click', prepareTools);
elements.refreshButton.addEventListener('click', () => {
  refreshJobs();
  refreshHealth();
});
elements.libraryRefreshButton.addEventListener('click', refreshLibrary);
elements.librarySearch.addEventListener('input', renderLibrary);
elements.navConfigButton.addEventListener('click', openSettingsDialog);
elements.openDestinationSettings.addEventListener('click', openSettingsDialog);
elements.librarySettingsButton.addEventListener('click', openSettingsDialog);
elements.emptyLibrarySettingsButton.addEventListener('click', openSettingsDialog);
elements.closeSettingsButton.addEventListener('click', () => elements.settingsDialog.close());
elements.resetDestinationButton.addEventListener('click', () => {
  elements.outputDirInput.value = 'downloads';
  elements.settingsError.textContent = '';
  elements.outputDirInput.focus();
});
elements.settingsForm.addEventListener('submit', saveSettings);
elements.settingsDialog.addEventListener('close', () => elements.navConfigButton.classList.remove('active'));
elements.settingsDialog.addEventListener('click', (event) => {
  if (event.target === elements.settingsDialog) elements.settingsDialog.close();
});
document.querySelectorAll('.side-nav .nav-link[href]').forEach((link) => {
  link.addEventListener('click', () => {
    document.querySelectorAll('.side-nav .nav-link').forEach((item) => item.classList.remove('active'));
    link.classList.add('active');
  });
});

const today = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })
  .format(new Date())
  .replace('.', '')
  .toUpperCase();
elements.todayLabel.textContent = today;

refreshHealth();
refreshJobs();
refreshLibrary();
window.setInterval(refreshJobs, 2500);
window.setInterval(refreshHealth, 15000);
window.setInterval(refreshLibrary, 12000);
