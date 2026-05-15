'use strict';

(function () {
  if (window.CashXNav) return;

  const scriptEl = document.currentScript;
  const configuredPrefix = scriptEl && scriptEl.dataset ? scriptEl.dataset.assetPrefix : '';
  const assetPrefix = configuredPrefix || inferAssetPrefix(scriptEl && scriptEl.getAttribute('src'));
  const state = {
    address: null,
    balanceText: '0',
    provider: null,
    signer: null,
  };
  const loadedScripts = new Map();

  const walletSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 18v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1h-9a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h9zm-9-2h10V8H12v8zm4-2.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>';

  function inferAssetPrefix(src) {
    if (!src) return '';
    const clean = src.split('?')[0].split('#')[0];
    const idx = clean.lastIndexOf('/');
    return idx >= 0 ? clean.slice(0, idx + 1) : '';
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function shortAddress(address) {
    return address ? address.slice(0, 6) + '...' + address.slice(-4) : '';
  }

  function explorerAddressUrl(address) {
    const base = window.CashX && window.CashX.config && window.CashX.config.chain
      ? window.CashX.config.chain.explorerBaseUrl
      : 'https://scan.pulsechain.com';
    return base.replace(/\/$/, '') + '/address/' + address;
  }

  function injectStyles() {
    if (byId('cashx-nav-css')) return;
    const style = document.createElement('style');
    style.id = 'cashx-nav-css';
    style.textContent = `
      .topnav.cashx-enhanced-nav {
        gap: 1rem;
        background: rgba(45,28,55,.82) !important;
        border-bottom-color: rgba(236,75,198,.5) !important;
        box-shadow: 0 10px 34px rgba(12,6,18,.26) !important;
      }
      .topnav.cashx-enhanced-nav .topnav-brand { flex-shrink: 0; }
      .topnav.cashx-enhanced-nav .topnav-center {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        z-index: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
      }
      .topnav.cashx-enhanced-nav .topnav-center > * { pointer-events: auto; }
      .topnav.cashx-enhanced-nav.cashx-wallet-connected .nav-links { display: none; }
      .topnav.cashx-enhanced-nav .topnav-right {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 1rem;
        margin-left: auto;
        position: relative;
        z-index: 2;
      }
      #connectBtn.cashx-connect-btn,
      .cashx-enhanced-nav .btn-connect.cashx-connect-btn,
      .cashx-enhanced-nav .connect-btn.cashx-connect-btn {
        font-family: 'Bebas Neue', 'Barlow Condensed', sans-serif;
        font-size: .9rem;
        letter-spacing: 2px;
        color: #fff;
        background: linear-gradient(135deg, #ec4bc6, #ff9f22);
        border: none;
        padding: .45rem 1.3rem;
        cursor: pointer;
        border-radius: 50px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: .4rem;
        transition: box-shadow .3s, transform .2s, opacity .2s;
        white-space: nowrap;
        min-height: 36px;
      }
      #connectBtn.cashx-connect-btn:hover,
      .cashx-enhanced-nav .btn-connect.cashx-connect-btn:hover,
      .cashx-enhanced-nav .connect-btn.cashx-connect-btn:hover {
        box-shadow: 0 0 26px rgba(236,75,198,.38), 0 0 14px rgba(255,159,34,.28);
        transform: translateY(-3px) scale(1.06);
      }
      #connectBtn.cashx-connect-btn:disabled { opacity: .7; cursor: wait; transform: none; }
      .wallet-hub {
        position: relative;
        display: none;
        align-items: center;
        padding: .42rem .5rem;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 999px;
        background: linear-gradient(180deg, rgba(87,51,104,.9), rgba(58,33,72,.86));
        box-shadow: inset 0 1px 0 rgba(255,255,255,.1), 0 12px 26px rgba(0,0,0,.22);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        transition: transform .9s cubic-bezier(.16,1,.3,1), box-shadow .9s ease, border-color .9s ease;
      }
      .wallet-hub.visible { display: inline-flex; }
      .wallet-hub.visible:hover {
        transform: translateY(-2px);
        border-color: rgba(255,255,255,.2);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.12), 0 16px 30px rgba(0,0,0,.24);
      }
      .wallet-account-hub { position: relative; display: none; align-items: center; }
      .wallet-account-hub.visible { display: inline-flex; }
      .wallet-balance-pill,
      .wallet-avatar-btn {
        cursor: pointer;
        font-family: 'Bebas Neue', 'Barlow Condensed', sans-serif;
        letter-spacing: 1.4px;
        white-space: nowrap;
      }
      .wallet-balance-pill {
        display: inline-flex;
        align-items: center;
        gap: .64rem;
        min-height: 46px;
        padding: .34rem .88rem .34rem .38rem;
        border-radius: 999px;
        color: #fff;
        background: rgba(255,255,255,.07);
        border: 1px solid rgba(255,255,255,.1);
      }
      .wallet-token-mark {
        width: 34px;
        height: 34px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        overflow: hidden;
        text-indent: -999px;
        background:
          radial-gradient(circle at center, rgba(255,255,255,.12), transparent 66%),
          url('${assetPrefix}favicon.ico') center / 76% no-repeat,
          rgba(255,255,255,.1);
        box-shadow: 0 0 0 1px rgba(255,255,255,.16), 0 0 14px rgba(255,153,68,.26);
      }
      .wallet-balance-main { display: flex; align-items: center; text-align: left; line-height: 1; }
      .wallet-balance-main span {
        color: #fff;
        font-family: 'Barlow Condensed', 'Bebas Neue', sans-serif;
        font-size: 1.1rem;
        font-weight: 900;
        letter-spacing: .8px;
        text-shadow: 0 1px 10px rgba(255,255,255,.24);
      }
      .wallet-chevron {
        width: 16px;
        height: 16px;
        position: relative;
        display: inline-block;
        color: transparent;
        transform: translateY(1px) rotate(0deg);
        transition: transform 1s cubic-bezier(.16,1,.3,1);
      }
      .wallet-chevron::before {
        content: '';
        position: absolute;
        left: 3px;
        top: 3px;
        width: 8px;
        height: 8px;
        border-right: 2px solid rgba(255,255,255,.82);
        border-bottom: 2px solid rgba(255,255,255,.82);
        border-radius: 1px;
        transform: rotate(45deg);
        transition: border-color 1s ease;
      }
      .wallet-hub.visible:hover .wallet-chevron,
      .wallet-hub.menu-open .wallet-chevron,
      .wallet-balance-pill:hover .wallet-chevron {
        transform: translateY(-1px) rotate(180deg);
      }
      .wallet-hub.visible:hover .wallet-chevron::before,
      .wallet-hub.menu-open .wallet-chevron::before,
      .wallet-balance-pill:hover .wallet-chevron::before {
        border-color: #ffd25a;
      }
      .wallet-avatar-btn {
        width: 46px;
        height: 46px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        color: #fff;
        background:
          radial-gradient(circle at center, rgba(255,255,255,.12), transparent 66%),
          url('${assetPrefix}favicon.ico') center / 72% no-repeat,
          rgba(255,255,255,.08);
        border: 2px solid rgba(200,85,247,.7);
        font-family: 'Orbitron', 'Space Mono', monospace;
        font-size: .7rem;
        text-indent: -999px;
        overflow: hidden;
        box-shadow: 0 0 0 3px rgba(255,31,154,.18), 0 0 18px rgba(200,85,247,.28);
      }
      .wallet-avatar-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 0 0 3px rgba(255,31,154,.26), 0 0 24px rgba(200,85,247,.42);
      }
      .wallet-account-menu,
      .wallet-balance-menu {
        position: absolute;
        top: calc(100% + 12px);
        right: 0;
        display: none;
        color: var(--text, #dce0f0);
        box-shadow: 0 24px 70px rgba(0,0,0,.62);
        z-index: 920;
      }
      .wallet-account-menu {
        width: 190px;
        padding: .48rem;
        border: 1px solid rgba(255,31,154,.36);
        border-radius: 18px;
        background: rgba(26,10,38,.98);
      }
      .wallet-account-menu.open { display: grid; animation: cashxNavDropIn .18s ease; }
      .wallet-account-item {
        min-height: 44px;
        padding: 0 .95rem;
        display: flex;
        align-items: center;
        border: 0;
        border-radius: 12px;
        color: #fff;
        background: transparent;
        cursor: pointer;
        font-family: 'Rajdhani', 'Barlow Condensed', sans-serif;
        font-size: 1.05rem;
        font-weight: 800;
        letter-spacing: .8px;
        text-align: left;
      }
      .wallet-account-item:hover { background: rgba(255,255,255,.07); }
      .wallet-account-item.danger { color: #ff6b7d; }
      .wallet-account-sep { height: 1px; margin: .25rem 0; background: rgba(255,31,154,.18); }
      .wallet-balance-menu {
        width: 278px;
        border: 1px solid rgba(200,85,247,.32);
        border-radius: 16px;
        padding: .75rem;
        background: rgba(14,7,24,.97);
      }
      .wallet-balance-menu.open { display: grid; gap: .7rem; animation: cashxNavDropIn .18s ease; }
      @keyframes cashxNavDropIn { from { opacity: 0; transform: translateY(-8px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
      .wallet-menu-head { display: flex; align-items: center; justify-content: space-between; gap: .7rem; padding-bottom: .65rem; border-bottom: 1px solid rgba(255,255,255,.08); }
      .wallet-menu-head b { font-family: 'Bebas Neue', 'Barlow Condensed', sans-serif; font-size: 1.15rem; letter-spacing: 1.5px; color: #fff; }
      .wallet-menu-address { color: rgba(220,224,240,.58); font-family: 'Space Mono', monospace; font-size: .68rem; }
      .wallet-menu-balance { padding: .85rem; border-radius: 12px; border: 1px solid rgba(245,166,35,.18); background: rgba(245,166,35,.06); }
      .wallet-menu-balance span { display: block; color: rgba(220,224,240,.62); font-family: 'Michroma', sans-serif; font-size: .48rem; letter-spacing: 1.6px; text-transform: uppercase; margin-bottom: .35rem; }
      .wallet-menu-balance strong { color: var(--amber, #f5a623); font-family: 'Orbitron', 'Space Mono', monospace; font-size: .95rem; }
      .wallet-menu-actions { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; }
      .wallet-menu-action { min-height: 36px; border: 1px solid rgba(255,255,255,.1); border-radius: 9px; color: rgba(220,224,240,.86); background: rgba(255,255,255,.05); cursor: pointer; font-family: 'Rajdhani', 'Barlow Condensed', sans-serif; font-weight: 700; letter-spacing: .8px; }
      .wallet-menu-action:hover { color: #fff; border-color: rgba(200,85,247,.38); background: rgba(200,85,247,.12); }
      .wallet-menu-action.danger:hover { color: var(--red, #ff4455); border-color: rgba(255,68,85,.34); background: rgba(255,68,85,.1); }
      @media (max-width: 820px) {
        .topnav.cashx-enhanced-nav { padding-left: 1rem; padding-right: 1rem; }
        .topnav.cashx-enhanced-nav .topnav-brand { font-size: 1.45rem; letter-spacing: 2px; }
        .topnav.cashx-enhanced-nav .topnav-center { position: static; transform: none; order: 3; width: 100%; margin-top: .5rem; }
        .topnav.cashx-enhanced-nav .topnav-right { gap: .5rem; }
        .wallet-hub { gap: .35rem; padding: .28rem; }
        .wallet-balance-pill { min-height: 40px; padding: .3rem .62rem .3rem .32rem; }
        .wallet-token-mark { width: 30px; height: 30px; }
        .wallet-balance-main span { font-size: .95rem; }
        .wallet-avatar-btn { width: 40px; height: 40px; }
        .wallet-balance-menu { right: -.5rem; width: min(280px, calc(100vw - 1.5rem)); }
      }
    `;
    document.head.appendChild(style);
  }

  function ensureTopnav() {
    const nav = document.querySelector('.topnav');
    if (!nav) return;
    nav.classList.add('cashx-enhanced-nav');

    let center = nav.querySelector('.topnav-center');
    if (!center) {
      center = document.createElement('div');
      center.className = 'topnav-center';
      const brand = nav.querySelector('.topnav-brand');
      if (brand && brand.nextSibling) nav.insertBefore(center, brand.nextSibling);
      else nav.appendChild(center);
    }

    if (!byId('walletHub')) {
      center.insertAdjacentHTML('beforeend', walletHubMarkup());
    }

    let right = nav.querySelector('.topnav-right');
    let connectBtn = byId('connectBtn') || nav.querySelector('.btn-connect, .connect-btn');
    if (!right) {
      right = document.createElement('div');
      right.className = 'topnav-right';
      nav.appendChild(right);
    }

    if (!connectBtn) {
      connectBtn = document.createElement('button');
      connectBtn.id = 'connectBtn';
      connectBtn.className = 'btn-connect cashx-connect-btn';
      connectBtn.type = 'button';
      connectBtn.innerHTML = walletSvg + ' Connect';
      right.appendChild(connectBtn);
    } else {
      if (!connectBtn.id) connectBtn.id = 'connectBtn';
      connectBtn.classList.add('cashx-connect-btn');
      if (!right.contains(connectBtn) && connectBtn.parentElement === nav) right.appendChild(connectBtn);
      if (!connectBtn.innerHTML.trim()) connectBtn.innerHTML = walletSvg + ' Connect';
    }

    if (!byId('walletAccountHub')) {
      const wrap = document.createElement('div');
      wrap.innerHTML = accountHubMarkup();
      const accountHub = wrap.firstElementChild;
      right.insertBefore(accountHub, connectBtn);
    }

    bindConnectButton(connectBtn);
  }

  function walletHubMarkup() {
    return `
      <div class="wallet-hub" id="walletHub">
        <button class="wallet-balance-pill" type="button" onclick="CashXNav.toggleBalanceMenu(event)" aria-label="Open wallet balance">
          <span class="wallet-token-mark" aria-hidden="true">CASHX</span>
          <span class="wallet-balance-main">
            <span id="topCashxBalance">0</span>
          </span>
          <span class="wallet-chevron" aria-hidden="true">⌄</span>
        </button>
        <div class="wallet-balance-menu" id="walletBalanceMenu">
          <div class="wallet-menu-head">
            <b>CASHX Wallet</b>
            <span class="wallet-menu-address" id="walletMenuAddress">--</span>
          </div>
          <div class="wallet-menu-balance">
            <span>Available Balance</span>
            <strong id="walletMenuBalance">0</strong>
          </div>
          <div class="wallet-menu-actions">
            <button class="wallet-menu-action" type="button" onclick="CashXNav.copyAddressFromMenu()">Copy</button>
            <button class="wallet-menu-action danger" type="button" onclick="CashXNav.disconnectWallet()">Disconnect</button>
          </div>
        </div>
      </div>`;
  }

  function accountHubMarkup() {
    return `
      <div class="wallet-account-hub" id="walletAccountHub">
        <button class="wallet-avatar-btn" id="walletAvatarBtn" type="button" onclick="CashXNav.toggleAccountMenu(event)" aria-label="Open account menu">CashX</button>
        <div class="wallet-account-menu" id="walletAccountMenu">
          <button class="wallet-account-item" type="button" onclick="CashXNav.openAccountFromMenu()">Account</button>
          <div class="wallet-account-sep"></div>
          <button class="wallet-account-item" type="button" onclick="CashXNav.copyAddressFromMenu()">Copy Address</button>
          <button class="wallet-account-item danger" type="button" onclick="CashXNav.disconnectWallet()">Disconnect</button>
        </div>
      </div>`;
  }

  function bindConnectButton(btn) {
    if (!btn || btn.__cashxNavBound) return;
    btn.__cashxNavBound = true;
    const hasExistingHandler = !!btn.getAttribute('onclick');
    if (!hasExistingHandler) {
      btn.addEventListener('click', event => {
        event.preventDefault();
        connectWallet();
      });
    }
    btn.addEventListener('click', () => {
      setTimeout(refreshFromWallet, 1200);
      setTimeout(refreshFromWallet, 3200);
    }, true);
  }

  async function connectWallet() {
    const btn = byId('connectBtn');
    setConnectButtonBusy(true);
    try {
      await ensureWalletTools();
      let result = null;
      if (window.showWalletModal) result = await window.showWalletModal();
      else result = await fallbackConnect();
      if (result && result.address) await applyConnectedWallet(result);
    } catch (err) {
      if (!err || err.message !== 'dismissed') {
        console.warn('CASHX wallet connection failed:', err);
      }
    } finally {
      if (!state.address && btn) setConnectButtonBusy(false);
    }
  }

  async function fallbackConnect() {
    if (!window.ethereum) throw new Error('No wallet detected.');
    await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (window.ethers) {
      const provider = new ethers.providers.Web3Provider(window.ethereum);
      const signer = provider.getSigner();
      const address = await signer.getAddress();
      try { localStorage.setItem('cashx:walletConnected', '1'); } catch (_) {}
      return { provider, signer, address };
    }
    const accounts = await window.ethereum.request({ method: 'eth_accounts' });
    const address = accounts && accounts[0];
    try { localStorage.setItem('cashx:walletConnected', '1'); } catch (_) {}
    return { address };
  }

  async function ensureWalletTools() {
    if (!window.ethers) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js');
    await loadLocalScript('contracts/abis/erc20.js', () => window.CASHX_ERC20_ABI || window.ERC20_ABI);
    await loadLocalScript('lib/config.js', () => window.CashX && window.CashX.config);
    await loadLocalScript('lib/contracts.js', () => window.CashX && window.CashX.contracts);
    await loadLocalScript('lib/wallet.js', () => window.CashX && window.CashX.wallet);
    await loadLocalScript('wallet-modal.js', () => window.showWalletModal);
  }

  async function loadLocalScript(path, ready) {
    if (ready && ready()) return;
    await loadScript(assetPrefix + path);
  }

  function loadScript(src) {
    if (loadedScripts.has(src)) return loadedScripts.get(src);
    const existing = Array.from(document.scripts).find(s => s.src && s.src.indexOf(src.replace(/^\.\//, '')) !== -1);
    if (existing) {
      const p = Promise.resolve();
      loadedScripts.set(src, p);
      return p;
    }
    const p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
    loadedScripts.set(src, p);
    return p;
  }

  async function refreshFromWallet() {
    try {
      let result = null;
      if (window.CashX && window.CashX.wallet && window.CashX.wallet.getConnectedAccount) {
        const address = await window.CashX.wallet.getConnectedAccount();
        if (address) result = { address };
      } else if (window.ethereum) {
        const accounts = await window.ethereum.request({ method: 'eth_accounts' });
        if (accounts && accounts[0]) result = { address: accounts[0] };
      }
      if (result && result.address) await applyConnectedWallet(result);
    } catch (_) {}
  }

  async function applyConnectedWallet(detail) {
    state.address = detail.address;
    state.provider = detail.provider || state.provider;
    state.signer = detail.signer || state.signer;

    const short = shortAddress(state.address);
    const connectBtn = byId('connectBtn');
    if (connectBtn) {
      connectBtn.style.display = 'none';
      connectBtn.disabled = false;
    }

    const addressDisplay = byId('addressDisplay');
    if (addressDisplay) {
      addressDisplay.textContent = '';
      addressDisplay.style.display = 'none';
    }

    const cashxBalance = byId('cashxBalance');
    if (cashxBalance) cashxBalance.style.display = 'none';

    const networkLabel = byId('networkLabel');
    if (networkLabel) networkLabel.style.display = 'none';

    const nav = document.querySelector('.topnav');
    if (nav) nav.classList.add('cashx-wallet-connected');

    const hub = byId('walletHub');
    if (hub) hub.classList.add('visible');

    const accountHub = byId('walletAccountHub');
    if (accountHub) accountHub.classList.add('visible');

    const menuAddress = byId('walletMenuAddress');
    if (menuAddress) menuAddress.textContent = short;

    const avatar = byId('walletAvatarBtn');
    if (avatar) avatar.title = 'Wallet ' + short;

    try { localStorage.setItem('cashx:walletConnected', '1'); } catch (_) {}
    await refreshCashxBalance();
  }

  async function refreshCashxBalance() {
    if (!state.address) return;
    try {
      if (!window.CashX || !window.CashX.wallet || !window.CashX.wallet.getCashXBalance) {
        await ensureWalletTools();
      }
      if (window.CashX && window.CashX.wallet && window.CashX.wallet.getCashXBalance) {
        const bal = await window.CashX.wallet.getCashXBalance(state.address);
        updateCashxWalletBalance(formatCashxBalance(bal));
      }
    } catch (_) {
      updateCashxWalletBalance(state.balanceText || '0');
    }
  }

  function formatCashxBalance(value) {
    if (!value || !window.ethers) return '0';
    const raw = ethers.utils.formatUnits(value, 18);
    const n = Number(raw);
    if (!Number.isFinite(n)) return raw;
    const maximumFractionDigits = n >= 100 ? 0 : 2;
    return n.toLocaleString(undefined, { maximumFractionDigits });
  }

  function updateCashxWalletBalance(text) {
    state.balanceText = text || '0';
    ['topCashxBalance', 'walletMenuBalance'].forEach(id => {
      const el = byId(id);
      if (el) el.textContent = state.balanceText;
    });
  }

  function setConnectButtonBusy(isBusy) {
    const btn = byId('connectBtn');
    if (!btn || btn.style.display === 'none') return;
    btn.disabled = !!isBusy;
    if (isBusy) btn.textContent = 'Connecting...';
    else if (!state.address) btn.innerHTML = walletSvg + ' Connect';
  }

  function closeBalanceMenu() {
    const menu = byId('walletBalanceMenu');
    if (menu) menu.classList.remove('open');
    document.removeEventListener('click', balanceOutsideClick);
  }

  function closeAccountMenu() {
    const menu = byId('walletAccountMenu');
    if (menu) menu.classList.remove('open');
    document.removeEventListener('click', accountOutsideClick);
  }

  function toggleBalanceMenu(event) {
    if (event) event.stopPropagation();
    closeAccountMenu();
    const menu = byId('walletBalanceMenu');
    if (!menu) return;
    const isOpen = menu.classList.toggle('open');
    if (isOpen) setTimeout(() => document.addEventListener('click', balanceOutsideClick), 10);
    else document.removeEventListener('click', balanceOutsideClick);
  }

  function toggleAccountMenu(event) {
    if (event) event.stopPropagation();
    closeBalanceMenu();
    const menu = byId('walletAccountMenu');
    if (!menu) return;
    const isOpen = menu.classList.toggle('open');
    if (isOpen) setTimeout(() => document.addEventListener('click', accountOutsideClick), 10);
    else document.removeEventListener('click', accountOutsideClick);
  }

  function balanceOutsideClick(event) {
    if (!event.target.closest('#walletHub')) closeBalanceMenu();
  }

  function accountOutsideClick(event) {
    if (!event.target.closest('#walletAccountHub')) closeAccountMenu();
  }

  function copyAddressFromMenu() {
    if (!state.address) return;
    navigator.clipboard && navigator.clipboard.writeText(state.address);
    closeBalanceMenu();
    closeAccountMenu();
  }

  function openAccountFromMenu() {
    if (!state.address) return;
    window.open(explorerAddressUrl(state.address), '_blank', 'noopener');
    closeAccountMenu();
  }

  function disconnectWallet() {
    try { localStorage.removeItem('cashx:walletConnected'); } catch (_) {}
    try { localStorage.removeItem('cashxWallet'); } catch (_) {}
    state.address = null;
    closeBalanceMenu();
    closeAccountMenu();
    const nav = document.querySelector('.topnav');
    if (nav) nav.classList.remove('cashx-wallet-connected');

    const hub = byId('walletHub');
    if (hub) hub.classList.remove('visible');
    const accountHub = byId('walletAccountHub');
    if (accountHub) accountHub.classList.remove('visible');
    const connectBtn = byId('connectBtn');
    if (connectBtn) {
      connectBtn.style.display = '';
      connectBtn.disabled = false;
      connectBtn.innerHTML = walletSvg + ' Connect';
    }
  }

  function bindWalletEvents() {
    window.addEventListener('cashx:wallet:connected', event => {
      if (event.detail && event.detail.address) applyConnectedWallet(event.detail);
    });
    window.addEventListener('cashx:wallet:accountsChanged', event => {
      if (event.detail && event.detail.address) applyConnectedWallet(event.detail);
      else disconnectWallet();
    });
    window.addEventListener('cashx:wallet:disconnected', disconnectWallet);
    window.addEventListener('cashx:wallet:chainChanged', () => setTimeout(refreshCashxBalance, 600));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        closeBalanceMenu();
        closeAccountMenu();
      }
    });
  }

  function boot() {
    injectStyles();
    ensureTopnav();
    bindWalletEvents();
    setTimeout(refreshFromWallet, 250);
    setTimeout(refreshFromWallet, 1800);
  }

  window.CashXNav = {
    connectWallet,
    toggleBalanceMenu,
    toggleAccountMenu,
    closeBalanceMenu,
    closeAccountMenu,
    copyAddressFromMenu,
    openAccountFromMenu,
    disconnectWallet,
    updateCashxWalletBalance,
    refreshCashxBalance,
    applyConnectedWallet,
  };

  if (!window.toggleBalanceMenu) window.toggleBalanceMenu = toggleBalanceMenu;
  if (!window.toggleAccountMenu) window.toggleAccountMenu = toggleAccountMenu;
  if (!window.openAccountFromMenu) window.openAccountFromMenu = openAccountFromMenu;
  if (!window.copyWalletAddress) window.copyWalletAddress = copyAddressFromMenu;
  if (!window.disconnectWallet) window.disconnectWallet = disconnectWallet;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}());










