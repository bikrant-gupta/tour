#!/usr/bin/env node
/* ============================================
   encrypt.js — Tour Explorer Encryption Script
   
   Usage:
     node encrypt.js              # encrypt only
     node encrypt.js --deploy     # encrypt + git push
   
   Requires: Node.js built-ins only (no npm install)
   ============================================ */

'use strict';

const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

/* ---- Config ---- */
const CFG = {
  iterations : 250_000,
  saltSize   : 16,
  ivSize     : 12,
  keyLen     : 32,          // AES-256
  textFiles  : ['app.js', 'style.css', 'auth.js', 'tracker.js'],
  dataFile   : 'data.json',
  vault      : 'vault.json',
  imgDir     : 'images',
  imgExts    : new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']),
};

/* ================================================================
   CRYPTO HELPERS
   ================================================================ */
function deriveKey(passkey, salt) {
  return crypto.pbkdf2Sync(passkey, salt, CFG.iterations, CFG.keyLen, 'sha256');
}

function encryptBuf(key, plainBuf) {
  const iv     = crypto.randomBytes(CFG.ivSize);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc    = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag    = cipher.getAuthTag();           // 16 bytes
  return Buffer.concat([iv, enc, tag]);         // iv(12) + cipher + tag(16)
}

/* ================================================================
   PASSKEY PROMPT  (hidden input — shows * per character)
   ================================================================ */
function promptPasskey() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write('🔑 Enter encryption passkey: ');

    let passkey = '';
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', function handler(char) {
        switch (char) {
          case '\r': case '\n': case '\u0004':
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.removeListener('data', handler);
            rl.close();
            process.stdout.write('\n');
            resolve(passkey);
            break;
          case '\u0003':
            process.stdout.write('\n');
            process.exit(0);
            break;
          case '\u007F':        // backspace
            if (passkey.length > 0) {
              passkey = passkey.slice(0, -1);
              process.stdout.clearLine(0);
              process.stdout.cursorTo(0);
              process.stdout.write('🔑 Enter encryption passkey: ' + '•'.repeat(passkey.length));
            }
            break;
          default:
            passkey += char;
            process.stdout.write('•');
        }
      });
    } else {
      // Non-TTY fallback (piped input)
      rl.question('', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

/* ================================================================
   TEXT FILE ENCRYPTION  →  vault.json
   ================================================================ */
function encryptTextFiles(key, salt) {
  const vault = {
    _v    : 1,
    salt  : salt.toString('hex'),
    iter  : CFG.iterations,
    algo  : 'aes-256-gcm',
    files : {},
  };

  const allText = [...CFG.textFiles, CFG.dataFile];
  for (const filename of allText) {
    if (!fs.existsSync(filename)) {
      console.log(`  ⚠️  ${filename} not found, skipping`);
      continue;
    }
    const plain = fs.readFileSync(filename);
    vault.files[filename] = encryptBuf(key, plain).toString('hex');
    console.log(`  ✅  ${filename}`);
  }

  fs.writeFileSync(CFG.vault, JSON.stringify(vault));
  console.log(`\n  📦  Written: ${CFG.vault}  (${(fs.statSync(CFG.vault).size / 1024).toFixed(1)} KB)`);
}

/* ================================================================
   IMAGE ENCRYPTION  →  image.webp.enc
   ================================================================ */
function encryptImages(key) {
  if (!fs.existsSync(CFG.imgDir)) return;

  let count = 0;
  let savedBytes = 0;

  function walkDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walkDir(full); continue; }
      if (!CFG.imgExts.has(path.extname(entry.name).toLowerCase())) continue;
      if (entry.name.endsWith('.enc')) continue;

      const encPath = full + '.enc';
      const plain   = fs.readFileSync(full);
      const encBuf  = encryptBuf(key, plain);
      fs.writeFileSync(encPath, encBuf);

      savedBytes += plain.length - encBuf.length; // negligible overhead
      count++;
      console.log(`  🖼  ${path.relative('.', full)}  →  ${path.basename(encPath)}`);
    }
  }

  console.log('\n  Encrypting images…');
  walkDir(CFG.imgDir);
  console.log(`\n  📸  ${count} image(s) encrypted`);
}

/* ================================================================
   LOADER index.html  GENERATOR
   ================================================================ */
function generateLoader() {
  // Read the current index.html to extract the #app HTML
  // We keep the full app DOM but hide it behind the lock screen
  let appHtml = '';
  if (fs.existsSync('index.html')) {
    const src = fs.readFileSync('index.html', 'utf8');
    // Extract everything inside <div id="app"> … </div>
    const m = src.match(/<div\s+id="app"[^>]*>([\s\S]*?)<\/div>\s*\n\s*<!-- Leaflet/);
    if (m) {
      appHtml = m[1];
    } else {
      // Fallback: use full body content between app tags
      const m2 = src.match(/<div\s+id="app"[^>]*>([\s\S]*)<\/div>\s*\n\s*<\/body>/);
      appHtml = m2 ? m2[1] : '';
    }
  }

  const loader = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="Tour Explorer — Private travel journal">
  <meta name="theme-color" content="#0a0e17">
  <title>Tour Explorer</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📍</text></svg>">
  <style>
    /* ── Lock Screen ── */
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    :root{--accent:#f59e0b;--accent-glow:rgba(245,158,11,.25);--bg:#0a0e17;--bg2:#111827;--glass:rgba(15,23,42,.8);--border:rgba(148,163,184,.1);--text:#f1f5f9;--muted:#64748b;--radius:.75rem;--ease:cubic-bezier(.16,1,.3,1)}
    html,body{height:100%;font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
    #lock-screen{
      position:fixed;inset:0;z-index:99999;
      display:flex;align-items:center;justify-content:center;
      background:radial-gradient(ellipse at 30% 20%,rgba(245,158,11,.06) 0%,transparent 60%),
                 radial-gradient(ellipse at 70% 80%,rgba(99,102,241,.06) 0%,transparent 60%),
                 var(--bg);
    }
    .lock__card{
      width:100%;max-width:400px;margin:1rem;
      background:var(--glass);
      backdrop-filter:blur(24px) saturate(180%);
      -webkit-backdrop-filter:blur(24px) saturate(180%);
      border:1px solid var(--border);
      border-radius:1.5rem;
      padding:2.5rem 2rem;
      box-shadow:0 24px 64px rgba(0,0,0,.5),0 0 0 1px rgba(245,158,11,.06);
      position:relative;overflow:hidden;
    }
    .lock__glow{
      position:absolute;top:-60px;left:50%;transform:translateX(-50%);
      width:200px;height:200px;border-radius:50%;
      background:radial-gradient(circle,var(--accent-glow) 0%,transparent 70%);
      pointer-events:none;
    }
    .lock__icon{
      width:64px;height:64px;margin:0 auto 1.25rem;border-radius:1rem;
      background:linear-gradient(135deg,var(--accent),#f97316);
      display:flex;align-items:center;justify-content:center;
      font-size:1.75rem;box-shadow:0 8px 24px var(--accent-glow);
    }
    .lock__title{
      font-family:'Outfit',sans-serif;font-size:1.6rem;font-weight:800;
      text-align:center;letter-spacing:-.03em;margin-bottom:.25rem;
    }
    .lock__subtitle{
      text-align:center;color:var(--muted);font-size:.82rem;
      margin-bottom:2rem;letter-spacing:.02em;
    }
    .lock__state{
      text-align:center;font-size:.82rem;color:var(--muted);
      min-height:1.2em;margin-bottom:.75rem;
      transition:color .2s ease;
    }
    .lock__state--error{color:#f87171}
    .lock__state--progress{color:var(--accent)}
    .lock__input-wrap{
      position:relative;margin-bottom:1rem;
    }
    .lock__input{
      width:100%;padding:.75rem 3rem .75rem 1rem;
      background:rgba(148,163,184,.06);
      border:1px solid var(--border);border-radius:var(--radius);
      color:var(--text);font-family:'Inter',sans-serif;font-size:.95rem;
      outline:none;transition:border-color .2s,box-shadow .2s;
    }
    .lock__input:focus{
      border-color:var(--accent);
      box-shadow:0 0 0 3px var(--accent-glow);
    }
    .lock__toggle{
      position:absolute;right:.75rem;top:50%;transform:translateY(-50%);
      background:none;border:none;cursor:pointer;color:var(--muted);
      font-size:1rem;padding:.25rem;
      transition:color .2s;
    }
    .lock__toggle:hover{color:var(--text)}
    .lock__btn{
      width:100%;padding:.85rem;
      background:linear-gradient(135deg,var(--accent),#f97316);
      border:none;border-radius:var(--radius);
      color:#000;font-family:'Outfit',sans-serif;font-size:1rem;font-weight:700;
      cursor:pointer;letter-spacing:.02em;
      transition:opacity .2s,transform .15s,box-shadow .2s;
      box-shadow:0 4px 16px var(--accent-glow);
    }
    .lock__btn:hover:not(:disabled){opacity:.9;transform:translateY(-1px);box-shadow:0 8px 24px var(--accent-glow)}
    .lock__btn:active{transform:translateY(0)}
    .lock__btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
    .lock__dots{
      display:inline-flex;gap:4px;vertical-align:middle;
    }
    .lock__dot{
      width:6px;height:6px;border-radius:50%;background:currentColor;
      animation:lockBounce .8s ease-in-out infinite;
    }
    .lock__dot:nth-child(2){animation-delay:.15s}
    .lock__dot:nth-child(3){animation-delay:.3s}
    @keyframes lockBounce{0%,80%,100%{transform:scale(.8);opacity:.5}40%{transform:scale(1);opacity:1}}
    .lock__shake{animation:lockShake .5s ease}
    @keyframes lockShake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}
    .lock__attempts{font-size:.75rem;color:var(--muted);text-align:center;margin-top:.75rem}
    .lock__blocked-icon{font-size:3rem;text-align:center;margin-bottom:1rem}
    .lock__blocked-title{font-family:'Outfit',sans-serif;font-size:1.2rem;font-weight:700;text-align:center;color:#f87171;margin-bottom:.5rem}
    .lock__blocked-text{text-align:center;color:var(--muted);font-size:.85rem;line-height:1.6}
    .lock__blocked-countdown{color:var(--accent);font-weight:700;font-size:1rem}
    /* Hidden app */
    #app{display:none}
  </style>
</head>
<body>

<!-- ═══════════════ LOCK SCREEN ═══════════════ -->
<div id="lock-screen">
  <div class="lock__card" id="lock-card">
    <div class="lock__glow"></div>
    <div class="lock__icon">📍</div>
    <h1 class="lock__title">Tour Explorer</h1>
    <p class="lock__subtitle">Private travel journal</p>

    <div class="lock__state" id="lock-state"></div>

    <div id="lock-form-area">
      <div class="lock__input-wrap">
        <input class="lock__input" type="password" id="lock-pass"
               placeholder="Enter passkey" autocomplete="current-password" autofocus>
        <button class="lock__toggle" id="lock-show" type="button" aria-label="Show/hide passkey">👁</button>
      </div>
      <button class="lock__btn" id="lock-btn" type="button">Unlock</button>
      <div class="lock__attempts" id="lock-attempts"></div>
    </div>
  </div>
</div>

<!-- ═══════════════ APP (hidden until decrypted) ═══════════════ -->
<div id="app">${appHtml}</div>

<!-- CDN libs (not sensitive) -->
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
  integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<script src="https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js"></script>

<!-- ═══════════════ DECRYPTION ENGINE ═══════════════ -->
<script>
(function() {
  'use strict';

  /* ---- Constants ---- */
  const SALT_LEN = 16, IV_LEN = 12, TAG_LEN = 16;
  const MAX_FAILS = 5, BLOCK_MS = 6 * 3600 * 1000;
  const BLOCK_KEY = '_te_blk', FAIL_KEY = '_te_f';

  /* ---- Lockout helpers ---- */
  function getBlock() {
    try { return JSON.parse(localStorage.getItem(BLOCK_KEY) || 'null'); } catch { return null; }
  }
  function setBlock(obj) {
    try { localStorage.setItem(BLOCK_KEY, JSON.stringify(obj)); } catch {}
  }
  function getFails() {
    try { return parseInt(localStorage.getItem(FAIL_KEY) || '0', 10); } catch { return 0; }
  }
  function setFails(n) {
    try { localStorage.setItem(FAIL_KEY, String(n)); } catch {}
  }
  function clearBlock() {
    try { localStorage.removeItem(BLOCK_KEY); localStorage.removeItem(FAIL_KEY); } catch {}
  }
  function attemptsLeft() { return Math.max(0, MAX_FAILS - getFails()); }

  /* ---- UI helpers ---- */
  const passEl     = document.getElementById('lock-pass');
  const btnEl      = document.getElementById('lock-btn');
  const stateEl    = document.getElementById('lock-state');
  const attemptsEl = document.getElementById('lock-attempts');
  const formArea   = document.getElementById('lock-form-area');
  const cardEl     = document.getElementById('lock-card');

  function setState(msg, cls) {
    stateEl.textContent = msg;
    stateEl.className = 'lock__state' + (cls ? ' lock__state--' + cls : '');
  }
  function setLoading(loading, label) {
    btnEl.disabled = loading;
    btnEl.innerHTML = loading
      ? '<span class="lock__dots"><span class="lock__dot"></span><span class="lock__dot"></span><span class="lock__dot"></span></span>'
      : (label || 'Unlock');
  }
  function shake() {
    cardEl.classList.remove('lock__shake');
    void cardEl.offsetWidth; // reflow
    cardEl.classList.add('lock__shake');
  }
  function updateAttempts() {
    const left = attemptsLeft();
    attemptsEl.textContent = left < MAX_FAILS
      ? left + ' attempt' + (left !== 1 ? 's' : '') + ' remaining'
      : '';
  }

  /* ---- Blocked UI ---- */
  let _cdTimer;
  function showBlocked(until) {
    clearInterval(_cdTimer);
    formArea.innerHTML = \`
      <div class="lock__blocked-icon">🔒</div>
      <p class="lock__blocked-title">Access Temporarily Blocked</p>
      <p class="lock__blocked-text">
        Too many incorrect attempts.<br>
        Try again in <span class="lock__blocked-countdown" id="blk-cd"></span>.
      </p>\`;
    const cdEl = document.getElementById('blk-cd');
    function tick() {
      const rem = Math.max(0, until - Date.now());
      const h = Math.floor(rem / 3600000);
      const m = Math.floor((rem % 3600000) / 60000);
      const s = Math.floor((rem % 60000) / 1000);
      cdEl.textContent = h + 'h ' + m + 'm ' + s + 's';
      if (rem <= 0) { clearInterval(_cdTimer); clearBlock(); location.reload(); }
    }
    tick();
    _cdTimer = setInterval(tick, 1000);
  }

  /* ---- Key derivation (PBKDF2-SHA256) ---- */
  async function deriveKey(passkey, saltBuf) {
    const enc = new TextEncoder().encode(passkey);
    const raw = await crypto.subtle.importKey('raw', enc, 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBuf, iterations: ${CFG.iterations}, hash: 'SHA-256' },
      raw,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
  }

  /* ---- AES-GCM decrypt ---- */
  async function decryptBuf(key, encBuf) {
    const iv   = encBuf.slice(0, IV_LEN);
    const data = encBuf.slice(IV_LEN);   // ciphertext + 16-byte tag
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new Uint8Array(plain);
  }

  /* ---- Execute JS safely via Blob URL ---- */
  function loadScript(code) {
    return new Promise((resolve, reject) => {
      const blob = new Blob([code], { type: 'application/javascript' });
      const url  = URL.createObjectURL(blob);
      const el   = document.createElement('script');
      el.src = url;
      el.onload  = () => { URL.revokeObjectURL(url); resolve(); };
      el.onerror = reject;
      document.head.appendChild(el);
    });
  }

  /* ---- Hex helpers ---- */
  function hexToBuf(hex) {
    const buf = new Uint8Array(hex.length / 2);
    for (let i = 0; i < buf.length; i++)
      buf[i] = parseInt(hex.slice(i*2, i*2+2), 16);
    return buf.buffer;
  }

  /* ---- Main decrypt & boot ---- */
  async function tryUnlock(passkey) {
    setLoading(true);
    setState('Deriving key…', 'progress');

    let vault;
    try {
      const resp = await fetch('vault.json?_=' + Date.now());
      vault = await resp.json();
    } catch {
      setState('Failed to load vault. Reload and retry.', 'error');
      setLoading(false);
      return;
    }

    const saltBuf = hexToBuf(vault.salt);
    let key;
    try {
      key = await deriveKey(passkey, saltBuf);
    } catch {
      setState('Key derivation failed.', 'error');
      setLoading(false);
      return;
    }

    /* Test decryption with data.json first */
    let dataJson;
    setState('Verifying passkey…', 'progress');
    try {
      const encBuf = hexToBuf(vault.files['data.json']);
      const plain  = await decryptBuf(key, encBuf);
      dataJson = JSON.parse(new TextDecoder().decode(plain));
    } catch {
      /* Wrong key — AES-GCM auth tag failed */
      const fails = getFails() + 1;
      setFails(fails);
      if (fails >= MAX_FAILS) {
        const until = Date.now() + BLOCK_MS;
        setBlock({ until });
        showBlocked(until);
      } else {
        shake();
        passEl.value = '';
        setState('Incorrect passkey.', 'error');
        updateAttempts();
        setLoading(false, 'Unlock');
        passEl.focus();
      }
      return;
    }

    /* ✅ Correct key — decrypt and boot */
    setState('Decrypting…', 'progress');
    clearBlock();

    // Expose data and session key globally
    window.__tourData   = Object.freeze(dataJson);
    window.__sessionKey = key;            // for image decryption in app.js

    // Decrypt and inject CSS
    try {
      const cssBuf = hexToBuf(vault.files['style.css']);
      const cssPlain = await decryptBuf(key, cssBuf);
      const style  = document.createElement('style');
      style.textContent = new TextDecoder().decode(cssPlain);
      document.head.appendChild(style);
    } catch(e) { console.warn('[Loader] CSS decrypt failed', e); }

    setState('Loading app…', 'progress');

    // Show app container
    document.getElementById('app').style.display = '';

    // Execute scripts in order: tracker → app → auth
    const order = ['tracker.js', 'app.js', 'auth.js'];
    for (const fname of order) {
      if (!vault.files[fname]) continue;
      try {
        const buf   = hexToBuf(vault.files[fname]);
        const plain = await decryptBuf(key, buf);
        await loadScript(new TextDecoder().decode(plain));
      } catch(e) { console.error('[Loader] Script failed:', fname, e); }
    }

    // Hide lock screen
    setState('', '');
    document.getElementById('lock-screen').style.display = 'none';
  }

  /* ---- Init ---- */
  (function init() {
    // Check block
    const blk = getBlock();
    if (blk && blk.until && Date.now() < blk.until) {
      showBlocked(blk.until);
      return;
    }

    updateAttempts();

    // Unlock button
    btnEl.addEventListener('click', () => {
      const pass = passEl.value;
      if (!pass) { setState('Please enter a passkey.', 'error'); passEl.focus(); return; }
      tryUnlock(pass);
    });

    // Enter key
    passEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') btnEl.click();
    });

    // Show/hide toggle
    document.getElementById('lock-show').addEventListener('click', () => {
      passEl.type = passEl.type === 'password' ? 'text' : 'password';
    });

    passEl.focus();
  })();
})();
</script>
</body>
</html>`;

  fs.writeFileSync('index.html', loader);
  console.log('\n  📄  Written: index.html (loader)');
}

/* ================================================================
   .gitignore  UPDATE
   ================================================================ */
function updateGitignore() {
  const additions = [
    '',
    '# ── Plaintext source files (encrypted versions are pushed) ──',
    'app.js',
    'style.css',
    'auth.js',
    'tracker.js',
    'data.json',
    '# Original images (*.enc versions are pushed)',
    'images/**/*.jpg',
    'images/**/*.jpeg',
    'images/**/*.png',
    'images/**/*.webp',
    'images/**/*.gif',
    '# Keep encrypted files',
    '!images/**/*.enc',
    '!vault.json',
  ].join('\n');

  const marker = '# ── Plaintext source files';
  let current = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore', 'utf8') : '';
  if (!current.includes(marker)) {
    fs.writeFileSync('.gitignore', current + additions);
    console.log('\n  🔒  Updated .gitignore');
  }
}

/* ================================================================
   MAIN
   ================================================================ */
async function main() {
  const deploy = process.argv.includes('--deploy');

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Tour Explorer — Encryption Script       ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const passkey = await promptPasskey();
  if (!passkey || passkey.length < 6) {
    console.error('\n❌  Passkey too short (minimum 6 characters)');
    process.exit(1);
  }

  console.log('\n  Generating salt & deriving key…');
  const salt = crypto.randomBytes(CFG.saltSize);
  const key  = deriveKey(passkey, salt);

  console.log('\n  Encrypting text files…');
  encryptTextFiles(key, salt);

  encryptImages(key);
  generateLoader();
  updateGitignore();

  console.log('\n══════════════════════════════════════════');
  console.log('  ✅  Encryption complete!');
  console.log('  📦  vault.json  ← commit this');
  console.log('  🖼   images/**/*.enc  ← commit these');
  console.log('  📄  index.html  ← commit this (loader)');
  console.log('  🔒  Source files excluded via .gitignore');
  console.log('══════════════════════════════════════════\n');

  if (deploy) {
    console.log('  🚀  Deploying to GitHub…');
    try {
      execSync('git add vault.json index.html "images/**/*.enc" .gitignore', { stdio: 'inherit' });
      execSync('git add vault.json index.html .gitignore', { stdio: 'inherit' });
      execSync('git add -f $(find images -name "*.enc")', { stdio: 'inherit', shell: true });
      const msg = `chore: encrypt & deploy [${new Date().toISOString().slice(0,16)}]`;
      execSync(`git commit -m "${msg}"`, { stdio: 'inherit' });
      execSync('git push', { stdio: 'inherit' });
      console.log('\n  ✅  Deployed!\n');
    } catch (e) {
      console.error('\n  ❌  Git push failed:', e.message);
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
