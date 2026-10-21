/* naubert-bot · pip.js
 *
 * Janela flutuante com o veredito, usando a Document Picture-in-Picture API
 * (Chrome 116+). É o jeito de manter a checagem visível POR CIMA da Globo Play:
 * a Globo não permite embutir o player em outra página, mas uma janela PiP
 * fica sempre à frente das outras janelas do sistema.
 *
 * A janela é um documento próprio — por isso o CSS é injetado inline, sem
 * depender de assets externos.
 */
(function (global) {
  'use strict';
  var NB = (global.NB = global.NB || {});

  var win = null;
  var refs = null;
  var lastResult = null;

  var STYLE = [
    ':root{color-scheme:dark}',
    '*{box-sizing:border-box}',
    'html,body{margin:0;height:100%;background:#06080b;color:#e8eef5;',
    'font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
    '-webkit-font-smoothing:antialiased;overflow:hidden}',
    '.wrap{height:100%;display:flex;flex-direction:column;padding:12px 14px 10px;',
    'border-top:3px solid var(--tone,#7c8899);background:',
    'radial-gradient(420px 200px at 100% 0%,color-mix(in srgb,var(--tone,#7c8899) 12%,transparent),transparent 70%),#06080b}',
    '.top{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
    '.brand{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#6b7887;font-weight:600}',
    '.live{margin-left:auto;display:inline-flex;align-items:center;gap:5px;font-size:9px;',
    'letter-spacing:.1em;color:#f43f5e;border:1px solid rgba(244,63,94,.4);',
    'background:rgba(244,63,94,.12);padding:2px 6px;border-radius:3px;font-weight:700}',
    '.live i{width:5px;height:5px;border-radius:50%;background:#f43f5e;animation:b 1.6s infinite}',
    '@keyframes b{0%,100%{opacity:1}50%{opacity:.3}}',
    '.badge{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.12em;',
    'color:#05080a;background:var(--tone,#7c8899);padding:3px 8px;border-radius:3px;margin-bottom:7px}',
    '.claim{font-size:15px;line-height:1.35;font-weight:600;margin:0 0 7px;color:#fff;',
    'display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}',
    '.expl{font-size:11.5px;line-height:1.5;color:#9aa7b4;margin:0 0 9px;',
    'display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}',
    '.src{margin-top:auto;display:flex;align-items:center;gap:7px;font-size:10.5px;color:#9aa7b4;',
    'border-top:1px solid rgba(255,255,255,.09);padding-top:8px;text-decoration:none}',
    '.src:hover{color:#fff}',
    '.outlet{font-weight:700;color:#e8eef5;border:1px solid rgba(255,255,255,.16);',
    'padding:1px 5px;border-radius:3px;flex:none;font-size:10px}',
    '.title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.meta{display:flex;gap:8px;font-size:9px;letter-spacing:.05em;text-transform:uppercase;',
    'color:#6b7887;margin-top:7px;flex-wrap:wrap}',
    '.meta .ok{color:#22c55e}.meta .warn{color:#f59e0b}',
    '.idle{padding:20px 4px;text-align:center}',
    '.idle .k{font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:#6b7887;margin-bottom:8px}',
    '.idle p{font-size:12px;line-height:1.55;color:#9aa7b4;margin:0}',
    '.foot{display:flex;align-items:center;justify-content:space-between;margin-top:8px;',
    'font-size:8.5px;letter-spacing:.1em;text-transform:uppercase;color:#4e5a67}',
    '.foot button{background:none;border:0;color:#6b7887;font-size:9px;cursor:pointer;padding:0;',
    'text-decoration:underline;text-underline-offset:2px;text-transform:uppercase;letter-spacing:.08em}',
    '.foot button:hover{color:#e8eef5}',
  ].join('');

  function supported() {
    return typeof global.documentPictureInPicture !== 'undefined' && !!global.documentPictureInPicture.requestWindow;
  }

  function isOpen() {
    return !!win && !win.closed;
  }

  function build() {
    var doc = win.document;
    doc.head.innerHTML = '';
    var style = doc.createElement('style');
    style.textContent = STYLE;
    doc.head.appendChild(style);
    doc.title = 'naubert-bot · checagem';

    doc.body.innerHTML =
      '<div class="wrap" id="wrap">' +
        '<div class="top">' +
          '<span class="brand">naubert-bot</span>' +
          '<span class="live"><i></i>ao vivo</span>' +
        '</div>' +
        '<div id="body" class="idle">' +
          '<div class="k">em espera</div>' +
          '<p>Aguardando a primeira checagem.<br>Deixe esta janela sobre o vídeo do debate.</p>' +
        '</div>' +
        '<div class="foot"><span id="count">0 checagens</span><button id="close" type="button">fechar</button></div>' +
      '</div>';

    refs = {
      wrap: doc.getElementById('wrap'),
      body: doc.getElementById('body'),
      count: doc.getElementById('count'),
    };

    doc.getElementById('close').addEventListener('click', close);
    win.addEventListener('pagehide', function () {
      win = null;
      refs = null;
    });

    if (lastResult) render(lastResult);
  }

  function render(result) {
    if (!refs) return;
    var meta = (NB.config.VERDICTS[result.veredito] || NB.config.VERDICTS.NAO_VERIFICADO);
    refs.wrap.style.setProperty('--tone', meta.cssVar);

    var src = (result.fontes || []).filter(function (f) { return f.status === 'confirmada'; })[0] ||
      (result.fontes || [])[0];
    var conf = Math.round((result.confianca || 0) * 100);
    var secs = result.latencia ? (result.latencia / 1000) : 0;

    refs.body.className = '';
    refs.body.innerHTML =
      '<span class="badge">' + meta.label + '</span>' +
      '<p class="claim">' + escapeHtml(result.texto || '') + '</p>' +
      (result.correcao || result.explicacao
        ? '<p class="expl">' + escapeHtml(result.correcao || result.explicacao) + '</p>'
        : '') +
      (src
        ? '<a class="src" href="' + escapeHtml(safeHref(src.url)) + '" target="_blank">' +
            '<span class="outlet">' + escapeHtml(src.veiculo || '') + '</span>' +
            '<span class="title">' + escapeHtml(src.titulo || src.url) + '</span>' +
          '</a>'
        : '<div class="src"><span class="outlet" style="color:#f59e0b;border-color:rgba(245,158,11,.4)">sem fonte</span>' +
            '<span class="title">nenhuma fonte passou na auditoria</span></div>') +
      '<div class="meta">' +
        (src ? '<span class="ok">✓ fonte confirmada</span>' : '<span class="warn">⚠ não confirmada</span>') +
        '<span>' + conf + '%</span>' +
        '<span>' + secs.toFixed(1).replace('.', ',') + ' s</span>' +
      '</div>';
  }

  function safeHref(url) {
    return /^https?:\/\//i.test(String(url || '')) ? String(url) : '#';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function open() {
    if (!supported()) return false;
    if (isOpen()) {
      win.focus();
      return true;
    }
    try {
      win = await global.documentPictureInPicture.requestWindow({ width: 400, height: 260 });
      build();
      return true;
    } catch (e) {
      win = null;
      return false;
    }
  }

  function close() {
    if (win && !win.closed) win.close();
    win = null;
    refs = null;
  }

  async function toggle() {
    if (isOpen()) {
      close();
      return false;
    }
    return open();
  }

  function update(result) {
    lastResult = result;
    if (isOpen()) render(result);
  }

  function setCount(n) {
    if (refs && refs.count) refs.count.textContent = n + (n === 1 ? ' checagem' : ' checagens');
  }

  NB.Pip = {
    supported: supported,
    isOpen: isOpen,
    open: open,
    close: close,
    toggle: toggle,
    update: update,
    setCount: setCount
  };
})(window);
