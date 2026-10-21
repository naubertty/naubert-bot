/* naubert-bot · store.js
 * Configuração persistida em localStorage + emissor de eventos mínimo.
 */
(function (global) {
  'use strict';
  var NB = (global.NB = global.NB || {});
  var KEY = 'naubert-bot:v2'; // v2 = provedor OpenRouter

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
    this.state = deepMerge(NB.config.defaults(), this._read() || {});
    // A lista de veículos é guardada à parte por ser grande.
    var saved = null;
    try {
      saved = global.localStorage.getItem(KEY + ':outlets');
    } catch (e) {
      saved = null;
    }
    this.outlets = saved ? NB.outlets.parseList(saved) : NB.outlets.DEFAULT_LIST.slice();
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
    this.state = NB.config.defaults();
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
