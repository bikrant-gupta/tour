/* ============================================
   TOUR EXPLORER — Authentication Gate
   
   Features:
   • Name + passkey login form
   • 1-hour session with multi-storage persistence
   • 5-attempt lockout → 6-hour block
   • Anti-tamper: MutationObserver, periodic checks,
     multi-layer storage (localStorage ×3, IndexedDB,
     cookies), XOR-encoded values, integrity hashes
   ============================================ */

(function () {
  'use strict';

  /* ---------- Configuration ---------- */
  const _C = Object.freeze({
    SESSION_MS:  3_600_000,          // 1 hour
    BLOCK_MS:   21_600_000,          // 6 hours
    MAX_FAILS:  5,
    CHECK_MS:   30_000,              // 30 s session poll
    TAMPER_MS:  800,                 // 800 ms tamper poll
    SALT:       '\x54\x30\x75\x52\x5f\x45\x78\x70\x6c\x30\x72\x33\x72\x5f\x53\x40\x6c\x74',
    V:          3,                   // storage version
  });

  /* Obfuscated storage key names — look like analytics cookies */
  const _K = Object.freeze({
    S1: '__cf_bm',    S2: '_gat_UA',          // session
    B1: '_ga_MRKX',   B2: '__utmb', B3: '_hjid',  // block
    IG: '__gsas_v',                             // integrity
    DB: '_sys_perf',   ST: '_metrics',          // IndexedDB
    SK: 'cfg_s',       BK: 'cfg_r',            // IDB keys
    CKS: '_ga_s',      CKB: '_ga_r',           // cookie names
  });

  /* Runtime state (closure-protected) */
  let _pwHash       = null;
  let _authenticated = false;
  let _sessionTimer  = null;
  let _tamperTimer   = null;
  let _observer      = null;
  let _appBooted     = false;
  let _currentUser   = '';
  let _modifying     = false;   // anti-tamper re-entrancy guard

  /* ================================================
     CRYPTO UTILITIES
     ================================================ */
  const Crypto = {
    async hash(text) {
      const buf = await crypto.subtle.digest(
        'SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf),
        b => b.toString(16).padStart(2, '0')).join('');
    },

    /** Multi-round salted hash */
    async mHash(text, rounds = 3) {
      let h = text + _C.SALT;
      for (let i = 0; i < rounds; i++)
        h = await this.hash(h + _C.SALT + i);
      return h;
    },

    fp() {
      return [
        navigator.userAgent, navigator.language,
        screen.width + 'x' + screen.height,
        screen.colorDepth,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
        navigator.hardwareConcurrency || 0,
        navigator.maxTouchPoints   || 0,
      ].join('::');
    },

    async fpHash() { return this.hash(this.fp()); },

    xEnc(str, key) {
      return btoa(str.split('').map((c, i) =>
        String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))
      ).join(''));
    },
    xDec(enc, key) {
      try {
        const d = atob(enc);
        return d.split('').map((c, i) =>
          String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))
        ).join('');
      } catch { return null; }
    },
  };

  /* ================================================
     MULTI-LAYER STORAGE  (localStorage, Cookies, IDB)
     ================================================ */
  const S = {
    /* --- localStorage --- */
    putLS(k, v) {
      try { localStorage.setItem(k,
        Crypto.xEnc(JSON.stringify(v), _C.SALT)); } catch {}
    },
    getLS(k) {
      try {
        const r = localStorage.getItem(k);
        if (!r) return null;
        const d = Crypto.xDec(r, _C.SALT);
        return d ? JSON.parse(d) : null;
      } catch { return null; }
    },
    delLS(k) { try { localStorage.removeItem(k); } catch {} },

    /* --- Cookies --- */
    putCK(k, v, maxAge) {
      try {
        document.cookie =
          `${k}=${encodeURIComponent(
            Crypto.xEnc(JSON.stringify(v), _C.SALT)
          )};path=/;max-age=${maxAge};SameSite=Strict`;
      } catch {}
    },
    getCK(k) {
      try {
        const m = document.cookie.match(
          new RegExp('(?:^|;\\s*)' + k + '=([^;]*)'));
        if (!m) return null;
        const d = Crypto.xDec(decodeURIComponent(m[1]), _C.SALT);
        return d ? JSON.parse(d) : null;
      } catch { return null; }
    },
    delCK(k) { document.cookie = `${k}=;path=/;max-age=0`; },

    /* --- IndexedDB --- */
    _dbP: null,
    _db() {
      if (this._dbP) return this._dbP;
      this._dbP = new Promise(r => {
        try {
          const rq = indexedDB.open(_K.DB, 1);
          rq.onupgradeneeded = () => {
            if (!rq.result.objectStoreNames.contains(_K.ST))
              rq.result.createObjectStore(_K.ST);
          };
          rq.onsuccess = () => r(rq.result);
          rq.onerror   = () => r(null);
        } catch { r(null); }
      });
      return this._dbP;
    },
    async putIDB(k, v) {
      try {
        const db = await this._db(); if (!db) return;
        const enc = Crypto.xEnc(JSON.stringify(v), _C.SALT);
        await new Promise(r => {
          const tx = db.transaction(_K.ST, 'readwrite');
          tx.objectStore(_K.ST).put(enc, k);
          tx.oncomplete = r; tx.onerror = r;
        });
      } catch {}
    },
    async getIDB(k) {
      try {
        const db = await this._db(); if (!db) return null;
        return new Promise(r => {
          const tx  = db.transaction(_K.ST, 'readonly');
          const rq  = tx.objectStore(_K.ST).get(k);
          rq.onsuccess = () => {
            if (!rq.result) return r(null);
            const d = Crypto.xDec(rq.result, _C.SALT);
            r(d ? JSON.parse(d) : null);
          };
          rq.onerror = () => r(null);
        });
      } catch { return null; }
    },
    async delIDB(k) {
      try {
        const db = await this._db(); if (!db) return;
        await new Promise(r => {
          const tx = db.transaction(_K.ST, 'readwrite');
          tx.objectStore(_K.ST).delete(k);
          tx.oncomplete = r;
        });
      } catch {}
    },
  };

  /* ================================================
     BLOCK MANAGER  (5 fails → 6-hour lockout)
     ================================================ */
  const Block = {
    async get() {
      const all = [
        S.getLS(_K.B1), S.getLS(_K.B2), S.getLS(_K.B3),
        S.getCK(_K.CKB),
        await S.getIDB(_K.BK),
      ];
      let best = null;
      for (const s of all) {
        if (!s || s.v !== _C.V) continue;
        if (!best || (s.bu || 0) > (best.bu || 0)) best = s;
      }
      return best || { a: 0, bu: 0, fp: '', v: _C.V };
    },
    async set(d) {
      d.v = _C.V;
      const ttl = Math.ceil(_C.BLOCK_MS / 1000) + 7200;
      S.putLS(_K.B1, d); S.putLS(_K.B2, d); S.putLS(_K.B3, d);
      S.putCK(_K.CKB, d, ttl);
      await S.putIDB(_K.BK, d);
    },
    async check() {
      const d = await this.get();
      if (d.bu && Date.now() < d.bu) return d;
      if (d.bu && Date.now() >= d.bu) await this.clear();
      return false;
    },
    async recordFail() {
      const d = await this.get();
      d.a  = (d.a || 0) + 1;
      d.fp = await Crypto.fpHash();
      if (d.a >= _C.MAX_FAILS) d.bu = Date.now() + _C.BLOCK_MS;
      await this.set(d);
      return d;
    },
    async clear() {
      await this.set({ a: 0, bu: 0, fp: '', v: _C.V });
    },
    async left() {
      const d = await this.get();
      return Math.max(0, _C.MAX_FAILS - (d.a || 0));
    },
  };

  /* ================================================
     SESSION MANAGER  (1-hour token)
     ================================================ */
  const Sess = {
    async create(userName) {
      const fp    = await Crypto.fpHash();
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)),
        b => b.toString(16).padStart(2, '0')).join('');
      const now   = Date.now();
      const sess  = {
        u: userName, c: now, e: now + _C.SESSION_MS,
        fp, n: nonce,
        t: await Crypto.hash(`${userName}::${fp}::${nonce}::${now}`),
        v: _C.V,
      };
      const ttl = Math.ceil(_C.SESSION_MS / 1000);
      S.putLS(_K.S1, sess); S.putLS(_K.S2, sess);
      S.putCK(_K.CKS, sess, ttl);
      await S.putIDB(_K.SK, sess);
      // integrity
      S.putLS(_K.IG, { h: await Crypto.hash(JSON.stringify(sess) + _C.SALT) });
      _currentUser = userName;
      _authenticated = true;
      return sess;
    },

    async validate() {
      const all = [
        S.getLS(_K.S1), S.getLS(_K.S2),
        S.getCK(_K.CKS),
        await S.getIDB(_K.SK),
      ];
      const fp = await Crypto.fpHash();
      for (const s of all) {
        if (!s || !s.t || !s.e || !s.fp || s.v !== _C.V) continue;
        if (Date.now() > s.e) continue;
        if (s.fp !== fp) continue;
        const ig = S.getLS(_K.IG);
        if (ig && ig.h) {
          const ex = await Crypto.hash(JSON.stringify(s) + _C.SALT);
          if (ig.h !== ex) continue;
        }
        _currentUser = s.u || '';
        _authenticated = true;
        return s;
      }
      _authenticated = false;
      return null;
    },

    async destroy() {
      S.delLS(_K.S1); S.delLS(_K.S2); S.delLS(_K.IG);
      S.delCK(_K.CKS);
      await S.delIDB(_K.SK);
      _authenticated = false;
      _currentUser = '';
    },
  };

  /* ================================================
     LOGIN UI
     ================================================ */

  async function renderLogin(blocked = false, blockData = null) {
    _modifying = true;
    const overlay = _ensureOverlayEl();

    let inner = '';

    if (blocked && blockData) {
      const rem  = Math.max(0, blockData.bu - Date.now());
      const h    = Math.floor(rem / 3_600_000);
      const m    = Math.floor((rem % 3_600_000) / 60_000);
      const s    = Math.floor((rem % 60_000) / 1000);
      inner = `
        <div class="auth__blocked">
          <div class="auth__blocked-icon">🔒</div>
          <h2 class="auth__blocked-title">Access Temporarily Blocked</h2>
          <p class="auth__blocked-text">
            Too many incorrect attempts.<br>
            Try again in <strong id="block-countdown">${h}h ${m}m ${s}s</strong>.
          </p>
        </div>`;
    } else {
      inner = `
        <form class="auth__form" id="auth-form" autocomplete="off">
          <div class="auth__field">
            <label class="auth__label" for="auth-name">Your Name</label>
            <input class="auth__input" type="text" id="auth-name"
                   placeholder="Enter your name" required autocomplete="name">
          </div>
          <div class="auth__field">
            <label class="auth__label" for="auth-password">Admin Passkey</label>
            <input class="auth__input" type="password" id="auth-password"
                   placeholder="Enter passkey" required autocomplete="current-password">
          </div>
          <div class="auth__error" id="auth-error"></div>
          <button class="auth__submit" type="submit" id="auth-submit">
            <span class="auth__submit-text">Access Explorer</span>
            <span class="auth__submit-loader"></span>
          </button>
        </form>`;
    }

    overlay.innerHTML = `
      <div class="auth__backdrop"></div>
      <div class="auth__card" id="auth-card">
        <div class="auth__card-glow"></div>
        <div class="auth__header">
          <div class="auth__icon">
            <span class="auth__icon-inner">📍</span>
          </div>
          <h1 class="auth__title">Tour Explorer</h1>
          <p class="auth__subtitle">${blocked
            ? 'Access restricted'
            : 'Enter your credentials to continue'}</p>
        </div>
        ${inner}
      </div>`;

    overlay.className = 'auth-overlay auth-overlay--visible';
    overlay.removeAttribute('hidden');
    overlay.style.cssText =
      'display:flex!important;visibility:visible!important;' +
      'opacity:1!important;pointer-events:all!important;';

    if (!blocked) {
      document.getElementById('auth-form')
        .addEventListener('submit', _handleSubmit);
    } else {
      // live countdown
      _startBlockCountdown(blockData);
    }

    _startAntiTamper();
    _modifying = false;
  }

  /* Block countdown timer */
  let _blockCdTimer = null;
  function _startBlockCountdown(bd) {
    if (_blockCdTimer) clearInterval(_blockCdTimer);
    _blockCdTimer = setInterval(() => {
      const rem = Math.max(0, bd.bu - Date.now());
      if (rem <= 0) {
        clearInterval(_blockCdTimer);
        renderLogin();            // re-show login form
        return;
      }
      const h = Math.floor(rem / 3_600_000);
      const m = Math.floor((rem % 3_600_000) / 60_000);
      const s = Math.floor((rem % 60_000) / 1000);
      const el = document.getElementById('block-countdown');
      if (el) el.textContent = `${h}h ${m}m ${s}s`;
    }, 1000);
  }

  /* Handle form submit */
  async function _handleSubmit(e) {
    e.preventDefault();

    const nameEl  = document.getElementById('auth-name');
    const passEl  = document.getElementById('auth-password');
    const errEl   = document.getElementById('auth-error');
    const btnEl   = document.getElementById('auth-submit');
    const name    = nameEl.value.trim();
    const pass    = passEl.value;

    if (!name || !pass) return _showErr(errEl, 'Please fill in all fields.');

    btnEl.disabled = true;
    btnEl.classList.add('auth__submit--loading');
    await _delay(600);                     // deliberate latency

    // Re-check block (in case another tab triggered it)
    const blocked = await Block.check();
    if (blocked) {
      btnEl.disabled = false;
      btnEl.classList.remove('auth__submit--loading');
      return renderLogin(true, blocked);
    }

    const inputHash = await Crypto.mHash(pass);
    if (inputHash === _pwHash) {
      /* ✅ SUCCESS */
      await Block.clear();
      await Sess.create(name);
      if (window.__tracker) window.__tracker.logLogin(name, true);
      _hideOverlay();
      _bootApp();
    } else {
      /* ❌ FAILURE */
      const bd   = await Block.recordFail();
      const left = await Block.left();
      if (window.__tracker) window.__tracker.logLogin(name, false);

      if (bd.bu && Date.now() < bd.bu) {
        renderLogin(true, bd);
      } else {
        _showErr(errEl,
          `Incorrect passkey. ${left} attempt${left !== 1 ? 's' : ''} remaining.`);
        passEl.value = '';
        passEl.focus();
        const card = document.getElementById('auth-card');
        if (card) {
          card.classList.add('auth__card--shake');
          setTimeout(() => card.classList.remove('auth__card--shake'), 650);
        }
      }
      btnEl.disabled = false;
      btnEl.classList.remove('auth__submit--loading');
    }
  }

  function _showErr(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.classList.add('auth__error--visible');
    setTimeout(() => el.classList.remove('auth__error--visible'), 6000);
  }

  /* ================================================
     OVERLAY MANAGEMENT
     ================================================ */

  function _ensureOverlayEl() {
    let el = document.getElementById('auth-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'auth-overlay';
      document.body.prepend(el);
    }
    return el;
  }

  function _hideOverlay() {
    _modifying = true;
    const el = document.getElementById('auth-overlay');
    if (el) {
      el.classList.remove('auth-overlay--visible');
      el.classList.add('auth-overlay--hidden');
      el.style.cssText =
        'display:none!important;visibility:hidden!important;' +
        'opacity:0!important;pointer-events:none!important;';
    }
    _modifying = false;
  }

  /* ================================================
     ANTI-TAMPER
     — MutationObserver detects overlay removal / hiding
     — Periodic poll catches CSS overrides via <style>
     ================================================ */

  function _startAntiTamper() {
    // MutationObserver
    if (_observer) _observer.disconnect();
    _observer = new MutationObserver(() => {
      if (_modifying || _authenticated) return;
      _verifyOverlay();
    });
    _observer.observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'display'],
    });

    // Periodic style check (catches injected <style> overrides)
    if (_tamperTimer) clearInterval(_tamperTimer);
    _tamperTimer = setInterval(() => {
      if (_authenticated) return;
      _verifyOverlay();
    }, _C.TAMPER_MS);
  }

  function _verifyOverlay() {
    if (_authenticated) return;
    _modifying = true;

    let el = document.getElementById('auth-overlay');
    if (!el) {
      // Overlay removed — re-create
      el = document.createElement('div');
      el.id = 'auth-overlay';
      document.body.prepend(el);
      renderLogin();
      _modifying = false;
      return;
    }

    const cs = getComputedStyle(el);
    const invisible =
      cs.display === 'none' ||
      cs.visibility === 'hidden' ||
      parseFloat(cs.opacity) < 0.5 ||
      el.hasAttribute('hidden');

    if (invisible) {
      el.className = 'auth-overlay auth-overlay--visible';
      el.removeAttribute('hidden');
      el.style.cssText =
        'display:flex!important;visibility:visible!important;' +
        'opacity:1!important;pointer-events:all!important;';
    }

    _modifying = false;
  }

  /* ================================================
     SESSION MONITOR  (re-validates every 30 s)
     ================================================ */

  function _startSessionMonitor() {
    if (_sessionTimer) clearInterval(_sessionTimer);
    _sessionTimer = setInterval(async () => {
      if (!_authenticated) return;
      const valid = await Sess.validate();
      if (!valid) {
        _authenticated = false;
        await Sess.destroy();
        renderLogin();
      }
    }, _C.CHECK_MS);
  }

  /* ================================================
     APP BOOT
     ================================================ */

  function _bootApp() {
    if (!_appBooted && window.__tourApp) {
      window.__tourApp.start();
      _appBooted = true;
    }
    _startSessionMonitor();
  }

  /* ================================================
     MAIN BOOT SEQUENCE
     ================================================ */

  async function _boot() {
    // 1. Load password hash from data.json
    try {
      const resp = await fetch('data.json');
      const data = await resp.json();
      if (data.password) {
        _pwHash = await Crypto.mHash(data.password);
      }
      // Share data (minus password) for app.js
      delete data.password;
      window.__tourData = Object.freeze(data);
    } catch (err) {
      console.error('[Auth] Failed to load config:', err);
      return;
    }

    // 2. Check block
    const blocked = await Block.check();
    if (blocked) return renderLogin(true, blocked);

    // 3. Check session
    const sess = await Sess.validate();
    if (sess) {
      _hideOverlay();
      _bootApp();
      return;
    }

    // 4. No session — show login
    renderLogin();
  }

  /* Helper */
  function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* Expose current user (read-only) for tracker integration */
  Object.defineProperty(window, '__authUser', {
    get: () => _currentUser,
    configurable: false,
    enumerable: false,
  });

  /* Start */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }

})();
