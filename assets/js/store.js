/* naubert-bot · store.js
 * Configuração persistida em localStorage + emissor de eventos mínimo.
 */
(function (global) {
  'use strict';
  var NB = (global.NB = global.NB || {});
  var KEY = 'naubert-bot:v2'; // v2 = provedor OpenRouter
  var SETTINGS_VERSION = 2;    // 2 = Gemini é o padrão

  // Padrões da versão anterior. Quem nunca mexeu nesses campos é migrado para
  // o novo provedor; quem escolheu outro modelo à mão continua onde estava.
  var LEGACY = {
    model: 'anthropic/claude-opus-5.5',
    triageModel: 'anthropic/claude-haiku-5.5'
  };

  function migrate(saved) {
    if (!saved || saved.settingsVersion === SETTINGS_VERSION) return null;
    var out = Object.assign({}, saved);
    var neverTouched =
      (!saved.provider || saved.provider === 'openrouter') &&
      (!saved.model || saved.model === LEGACY.model) &&
      (!saved.triageModel || saved.triageModel === LEGACY.triageModel);
    if (neverTouched) {
      out.provider = 'gemini';
      out.model = 'gemini-3.8-flash';
      out.triageModel = 'gemini-3.1-flash-lite';
      out.sttModel = 'gemini-3.5-transcribe';
    }
    out.settingsVersion = SETTINGS_VERSION;
    return out;
  }

  function deepMerge(base, patch) {
    var out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    Object.keys(patch || {}).forEach(function (k) {
      var v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        out[k] = deepMerge(base[k], v);
      } else if (v !== undefined) {
        out[k] = v;
      }
    });
    return out;
  }

  function Store() {
    var saved = this._read();
    var migrated = migrate(saved);
    this.state = deepMerge(NB.config.defaults(), migrated || saved || {});
    this.migrated = !!migrated && migrated.provider !== (saved && saved.provider);
    if (migrated) {
      // grava já migrado: a próxima abertura não passa por aqui de novo
      try {
        global.localStorage.setItem(KEY, JSON.stringify(this.state));
      } catch (e) {
        /* sem localStorage: segue só em memória */
      }
    }
    // A lista de veículos é guardada à parte por ser grande.
    var savedOutlets = null;
    try {
      savedOutlets = global.localStorage.getItem(KEY + ':outlets');
    } catch (e) {
      savedOutlets = null;
    }
    this.outlets = savedOutlets ? NB.outlets.parseList(savedOutlets) : NB.outlets.DEFAULT_LIST.slice();
  }

  Store.prototype._read = function () {
    try {
      var raw = global.localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  };

  Store.prototype.save = function () {
    try {
      global.localStorage.setItem(KEY, JSON.stringify(this.state));
      global.localStorage.setItem(KEY + ':outlets', NB.outlets.toText(this.outlets));
    } catch (e) {
      /* modo privado / cota cheia: segue sem persistir */
    }
    return this;
  };

  Store.prototype.set = function (patch) {
    this.state = deepMerge(this.state, patch);
    return this.save();
  };

  Store.prototype.setOutlets = function (list) {
    this.outlets = list;
    return this.save();
  };

  Store.prototype.reset = function () {
    this.state = deepMerge(NB.config.defaults(), { settingsVersion: SETTINGS_VERSION });
    this.outlets = NB.outlets.DEFAULT_LIST.slice();
    return this.save();
  };

  NB.Store = Store;

  /* ----------------------------------------------------------------- bus de eventos */

  function Emitter() {
    this._h = Object.create(null);
  }
  Emitter.prototype.on = function (name, fn) {
    (this._h[name] = this._h[name] || []).push(fn);
    return this;
  };
  Emitter.prototype.emit = function (name, payload) {
    (this._h[name] || []).forEach(function (fn) {
      try {
        fn(payload);
      } catch (e) {
        console.error('[naubert-bot] handler', name, e);
      }
    });
    return this;
  };
  NB.Emitter = Emitter;
})(window);
