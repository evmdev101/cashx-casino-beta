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
    approvalTarget: null,
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
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        height: 84px !important;
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        gap: 1rem;
        padding: 0 1.9rem !important;
        z-index: 600 !important;
        background: rgba(45,28,55,.82) !important;
        border-bottom: 1px solid rgba(236,75,198,.5) !important;
        box-shadow: 0 10px 34px rgba(12,6,18,.26) !important;
        backdrop-filter: blur(10px) !important;
        -webkit-backdrop-filter: blur(10px) !important;
      }
      .topnav.cashx-enhanced-nav .topnav-brand {
        flex-shrink: 0;
        font-family: 'Bebas Neue', 'Barlow Condensed', sans-serif !important;
        font-size: 2rem !important;
        line-height: 1 !important;
        letter-spacing: 3px !important;
        color: var(--gold, #f5a623) !important;
        text-decoration: none !important;
        display: flex !important;
        align-items: baseline !important;
        gap: .5rem !important;
      }
      .topnav.cashx-enhanced-nav .topnav-brand span:not(.topnav-beta) { color: #fff !important; }
      .topnav.cashx-enhanced-nav .topnav-beta {
        font-family: 'Michroma', sans-serif !important;
        font-size: .45rem !important;
        line-height: 1 !important;
        letter-spacing: 2px !important;
        color: var(--purple, #ec4bc6) !important;
        border: 1px solid rgba(236,75,198,.34) !important;
        padding: .12rem .3rem !important;
      }
      .topnav.cashx-enhanced-nav .nav-links { display: none !important; }
      .topnav.cashx-enhanced-nav .topnav-center {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        z-index: 2;
        display: flex;
        align-items: center !important;
        justify-content: center;
        pointer-events: none;
      }
      .topnav.cashx-enhanced-nav .topnav-center > * { pointer-events: auto; }
      .topnav.cashx-enhanced-nav.cashx-wallet-connected .nav-links { display: none !important; }
      .topnav.cashx-enhanced-nav.cashx-wallet-connected #connectBtn,
      .topnav.cashx-enhanced-nav.cashx-wallet-connected .btn-connect,
      .topnav.cashx-enhanced-nav.cashx-wallet-connected .connect-btn {
        display: none !important;
      }
      .topnav.cashx-enhanced-nav .topnav-right {
        display: flex;
        align-items: center !important;
        justify-content: flex-end;
        gap: 1rem;
        margin-left: auto;
        position: relative;
        z-index: 3;
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
        display: inline-flex !important;
        align-items: center !important;
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
        align-items: center !important;
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
      .cashier-btn {
        min-height: 46px;
        border: 0;
        border-radius: 999px;
        padding: .35rem 1.08rem;
        color: #130717;
        background: linear-gradient(135deg, #ff4d6d, #f5a623);
        cursor: pointer;
        font-family: 'Orbitron', 'Michroma', sans-serif;
        font-size: .72rem;
        font-weight: 900;
        letter-spacing: .6px;
        text-transform: uppercase;
        box-shadow: 0 10px 26px rgba(245,166,35,.24);
        transition: transform .2s ease, box-shadow .2s ease;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0;
      }
      .cashier-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 12px 32px rgba(245,166,35,.34), 0 0 18px rgba(255,77,109,.22);
      }
      .wallet-account-hub { position: relative; display: none; align-items: center; }
      .wallet-account-hub.visible { display: inline-flex; }
      .wallet-balance-pill,
      .wallet-avatar-btn {
        font-family: 'Bebas Neue', 'Barlow Condensed', sans-serif;
        letter-spacing: 1.4px;
        white-space: nowrap;
      }
      .wallet-balance-pill {
        display: inline-flex !important;
        align-items: center !important;
        gap: .64rem;
        min-height: 46px !important;
        padding: .34rem .88rem .34rem .38rem !important;
        border-radius: 999px;
        color: #fff;
        background: rgba(255,255,255,.07);
        border: 1px solid rgba(255,255,255,.1);
      }
      .wallet-balance-pill { cursor: default; }
      .wallet-token-mark {
        width: 34px !important;
        height: 34px !important;
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
      .wallet-balance-main { display: flex !important; align-items: center !important; text-align: left !important; line-height: 1 !important; }
      .wallet-balance-main span {
        color: #fff !important;
        font-family: 'Barlow Condensed', 'Bebas Neue', sans-serif !important;
        font-size: 1.1rem !important;
        font-weight: 900 !important;
        letter-spacing: .8px !important;
        text-shadow: 0 1px 10px rgba(255,255,255,.24);
      }
      .wallet-balance-main span:not([id]) { display: none !important; }
      .wallet-chevron { display: none; }
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
      .cashier-backdrop,
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
      .cashier-backdrop {
        position: fixed;
        inset: 0;
        display: none;
        background: rgba(8,3,13,.66);
        backdrop-filter: blur(7px);
        -webkit-backdrop-filter: blur(7px);
        z-index: 880;
      }
      .cashier-backdrop.open { display: block; }
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
        align-items: center !important;
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
        position: fixed;
        top: 50%;
        left: 50%;
        right: auto;
        width: min(430px, calc(100vw - 1.5rem));
        max-height: min(760px, calc(100vh - 2rem));
        overflow-y: auto;
        border: 1px solid rgba(200,85,247,.32);
        border-radius: 16px;
        padding: .75rem;
        background: rgba(14,7,24,.97);
        transform: translate(-50%, -50%);
        z-index: 900;
      }
      .wallet-balance-menu.open { display: grid; gap: .7rem; animation: cashxNavModalIn .18s ease; }
      @keyframes cashxNavDropIn { from { opacity: 0; transform: translateY(-8px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
      @keyframes cashxNavModalIn { from { opacity: 0; transform: translate(-50%, -48%) scale(.98); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
      .wallet-menu-head { display: flex; align-items: center; justify-content: space-between; gap: .7rem; padding-bottom: .65rem; border-bottom: 1px solid rgba(255,255,255,.08); }
      .wallet-menu-head b { font-family: 'Bebas Neue', 'Barlow Condensed', sans-serif; font-size: 1.15rem; letter-spacing: 1.5px; color: #fff; }
      .wallet-menu-address { color: rgba(220,224,240,.58); font-family: 'Space Mono', monospace; font-size: .68rem; }
      .cashier-close {
        width: 34px;
        height: 34px;
        border: 1px solid rgba(255,255,255,.08);
        border-radius: 50%;
        color: rgba(255,255,255,.78);
        background: rgba(255,255,255,.06);
        cursor: pointer;
        font-size: 1.2rem;
        line-height: 1;
      }
      .cashier-close:hover { color: #fff; border-color: rgba(255,77,109,.34); background: rgba(255,77,109,.12); }
      .wallet-menu-balance { padding: .85rem; border-radius: 12px; border: 1px solid rgba(245,166,35,.18); background: rgba(245,166,35,.06); }
      .wallet-menu-balance span { display: block; color: rgba(220,224,240,.62); font-family: 'Michroma', sans-serif; font-size: .48rem; letter-spacing: 1.6px; text-transform: uppercase; margin-bottom: .35rem; }
      .wallet-menu-balance strong { color: var(--amber, #f5a623); font-family: 'Orbitron', 'Space Mono', monospace; font-size: .95rem; }
      .wallet-approval-remaining {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: .35rem .75rem;
        padding: .78rem .85rem;
        border-radius: 12px;
        border: 1px solid rgba(137,255,189,.16);
        background: rgba(137,255,189,.045);
      }
      .wallet-approval-remaining span {
        color: rgba(220,224,240,.62);
        font-family: 'Michroma', sans-serif;
        font-size: .47rem;
        letter-spacing: 1.3px;
        text-transform: uppercase;
      }
      .wallet-approval-remaining strong {
        color: rgba(137,255,189,.95);
        font-family: 'Orbitron', 'Space Mono', monospace;
        font-size: .84rem;
        text-align: right;
      }
      .wallet-approval-remaining small {
        grid-column: 1 / -1;
        color: rgba(220,224,240,.62);
        font-size: .68rem;
        line-height: 1.3;
      }
      .wallet-revoke-btn {
        grid-column: 1 / -1;
        min-height: 32px;
        margin-top: .25rem;
        border: 1px solid rgba(255,68,85,.28);
        border-radius: 9px;
        color: rgba(255,117,133,.95);
        background: rgba(255,68,85,.08);
        cursor: pointer;
        font-family: 'Rajdhani', 'Barlow Condensed', sans-serif;
        font-weight: 800;
        letter-spacing: .8px;
      }
      .wallet-revoke-btn:hover { color: #fff; border-color: rgba(255,68,85,.45); background: rgba(255,68,85,.14); }
      .wallet-revoke-btn:disabled { opacity: .55; cursor: wait; }
      .wallet-menu-section { padding: .2rem 0 .1rem; }
      .wallet-menu-section-title {
        color: rgba(220,224,240,.62);
        font-family: 'Michroma', sans-serif;
        font-size: .48rem;
        letter-spacing: 1.6px;
        text-transform: uppercase;
        margin-bottom: .45rem;
      }
      .wallet-approval-intro {
        display: grid;
        gap: .45rem;
        padding: .72rem;
        margin-bottom: .58rem;
        border: 1px solid rgba(200,85,247,.22);
        border-radius: 12px;
        background: linear-gradient(135deg, rgba(200,85,247,.12), rgba(245,166,35,.06));
      }
      .wallet-approval-intro strong {
        color: #fff;
        font-family: 'Rajdhani', 'Barlow Condensed', sans-serif;
        font-size: .94rem;
        letter-spacing: .5px;
      }
      .wallet-approval-intro span {
        color: rgba(220,224,240,.7);
        font-size: .72rem;
        line-height: 1.35;
      }
      .wallet-approval-summary {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: .4rem .75rem;
        align-items: center;
        padding: .68rem .72rem;
        margin: .58rem 0;
        border: 1px solid rgba(245,166,35,.22);
        border-radius: 12px;
        background: rgba(245,166,35,.07);
      }
      .wallet-approval-summary span {
        color: rgba(220,224,240,.58);
        font-family: 'Michroma', sans-serif;
        font-size: .47rem;
        letter-spacing: 1.3px;
        text-transform: uppercase;
      }
      .wallet-approval-summary strong {
        color: #ffbf3a;
        font-family: 'Orbitron', 'Space Mono', monospace;
        font-size: .82rem;
        text-align: right;
      }
      .wallet-approval-summary p {
        grid-column: 1 / -1;
        margin: 0;
        color: rgba(220,224,240,.68);
        font-size: .7rem;
        line-height: 1.35;
      }
      .wallet-approval-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .45rem; }
      .wallet-approval-btn {
        min-height: 34px;
        border: 1px solid rgba(255,255,255,.1);
        border-radius: 9px;
        color: rgba(220,224,240,.86);
        background: rgba(255,255,255,.05);
        cursor: pointer;
        font-family: 'Rajdhani', 'Barlow Condensed', sans-serif;
        font-weight: 800;
        letter-spacing: .8px;
      }
      .wallet-approval-btn:hover { color: #fff; border-color: rgba(245,166,35,.42); background: rgba(245,166,35,.1); }
      .wallet-approval-btn.active {
        color: #0b0612;
        border-color: rgba(245,166,35,.82);
        background: linear-gradient(135deg, #f5a623, #ffbf3a);
      }
      .wallet-approval-custom {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: .45rem;
        margin-top: .5rem;
      }
      .wallet-approval-custom input {
        min-width: 0;
        border: 1px solid rgba(255,255,255,.1);
        border-radius: 9px;
        color: #fff;
        background: rgba(255,255,255,.05);
        padding: .5rem .6rem;
        font-family: 'Space Mono', monospace;
        font-size: .78rem;
        outline: none;
      }
      .wallet-approval-custom input:focus { border-color: rgba(245,166,35,.62); box-shadow: 0 0 0 2px rgba(245,166,35,.1); }
      .wallet-approval-custom button {
        min-height: 34px;
        border: 1px solid rgba(245,166,35,.4);
        border-radius: 9px;
        color: #0b0612;
        background: linear-gradient(135deg, #f5a623, #ffbf3a);
        cursor: pointer;
        font-family: 'Rajdhani', 'Barlow Condensed', sans-serif;
        font-weight: 900;
        letter-spacing: .8px;
        padding: 0 .72rem;
      }
      .wallet-approval-confirm {
        width: 100%;
        min-height: 40px;
        margin-top: .55rem;
        border: 1px solid rgba(245,166,35,.48);
        border-radius: 10px;
        color: #120713;
        background: linear-gradient(135deg, #f5a623, #ffbf3a);
        cursor: pointer;
        font-family: 'Rajdhani', 'Barlow Condensed', sans-serif;
        font-weight: 900;
        letter-spacing: .8px;
      }
      .wallet-approval-confirm:disabled { opacity: .55; cursor: wait; }
      .wallet-approval-safety {
        display: grid;
        gap: .32rem;
        margin: .6rem 0 .1rem;
        padding: .62rem .68rem;
        border: 1px solid rgba(255,255,255,.08);
        border-radius: 12px;
        background: rgba(255,255,255,.035);
      }
      .wallet-approval-safety span {
        color: rgba(220,224,240,.68);
        font-size: .69rem;
        line-height: 1.3;
      }
      .wallet-approval-safety b { color: #fff; font-weight: 800; }
      .wallet-menu-note { color: rgba(220,224,240,.54); font-size: .7rem; line-height: 1.35; margin-top: .45rem; }
      .wallet-menu-note.success { color: rgba(137,255,189,.88); }
      .wallet-menu-actions { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; }
      .wallet-menu-action { min-height: 36px; border: 1px solid rgba(255,255,255,.1); border-radius: 9px; color: rgba(220,224,240,.86); background: rgba(255,255,255,.05); cursor: pointer; font-family: 'Rajdhani', 'Barlow Condensed', sans-serif; font-weight: 700; letter-spacing: .8px; }
      .wallet-menu-action:hover { color: #fff; border-color: rgba(200,85,247,.38); background: rgba(200,85,247,.12); }
      .wallet-menu-action.danger:hover { color: var(--red, #ff4455); border-color: rgba(255,68,85,.34); background: rgba(255,68,85,.1); }
      @media (max-width: 820px) {
        .topnav.cashx-enhanced-nav {
          height: auto !important;
          min-height: 84px !important;
          flex-wrap: wrap !important;
          padding: .8rem 1rem !important;
        }
        .topnav.cashx-enhanced-nav .topnav-brand { font-size: 1.45rem; letter-spacing: 2px; }
        .topnav.cashx-enhanced-nav .topnav-center {
          position: static !important;
          left: auto !important;
          top: auto !important;
          transform: none !important;
          order: 3 !important;
          flex: 0 0 100% !important;
          width: 100% !important;
          margin-top: .5rem;
        }
        .topnav.cashx-enhanced-nav .topnav-right { gap: .5rem; }
        .wallet-hub { gap: .35rem; padding: .28rem; }
        .wallet-balance-pill { min-height: 40px; padding: .3rem .62rem .3rem .32rem; }
        .wallet-token-mark { width: 30px; height: 30px; }
        .wallet-balance-main span { font-size: .95rem; }
        .wallet-avatar-btn { width: 40px; height: 40px; }
        .cashier-btn { min-height: 40px; padding: .3rem .82rem .3rem .68rem; }
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
    bindApprovalButtons();
    normalizeExistingWalletPill();
    observeBalanceText();
    hideConnectedAddressButton();
  }

  function walletHubMarkup() {
    return `
      <div class="wallet-hub" id="walletHub">
        <div class="wallet-balance-pill" aria-label="CASHX balance">
          <span class="wallet-token-mark" aria-hidden="true">CASHX</span>
          <span class="wallet-balance-main">
            <span id="topCashxBalance">0</span>
          </span>
        </div>
        <button class="cashier-btn" id="cashierBtn" type="button" onclick="CashXNav.openCashier(event)">Cashier</button>
        <div class="cashier-backdrop" id="cashierBackdrop" onclick="CashXNav.closeBalanceMenu()"></div>
        <div class="wallet-balance-menu" id="walletBalanceMenu">
          <div class="wallet-menu-head">
            <div>
              <b>Cashier</b>
              <div class="wallet-menu-address" id="walletMenuAddress">--</div>
            </div>
            <button class="cashier-close" type="button" onclick="CashXNav.closeBalanceMenu()" aria-label="Close cashier">×</button>
          </div>
          <div class="wallet-menu-balance">
            <span>Available Balance</span>
            <strong id="walletMenuBalance">0</strong>
          </div>
          <div class="wallet-approval-remaining">
            <span>Approved Remaining</span>
            <strong id="walletApprovalRemaining">--</strong>
            <small id="walletApprovalTarget">Open a game to view its approved allowance.</small>
            <button class="wallet-revoke-btn" id="walletApprovalRevoke" type="button">Revoke Approval</button>
          </div>
          <div class="wallet-menu-section">
            <div class="wallet-menu-section-title">Game Approval</div>
            <div class="wallet-approval-intro">
              <strong>Choose how much games may use</strong>
              <span>This is a wallet allowance, not a deposit. Your CASHX stays in your wallet until you create or join a game.</span>
            </div>
            <div class="wallet-approval-grid">
              <button class="wallet-approval-btn active" type="button" data-approval="bet">This Bet</button>
              <button class="wallet-approval-btn" type="button" data-approval="10000">10K</button>
              <button class="wallet-approval-btn" type="button" data-approval="100000">100K</button>
              <button class="wallet-approval-btn" type="button" data-approval="1000000">1M</button>
            </div>
            <div class="wallet-approval-summary">
              <span>Selected limit</span>
              <strong id="walletApprovalSelected">This bet only</strong>
              <p id="walletApprovalDescription">You will only approve the amount needed for the next game you start or join.</p>
            </div>
            <div class="wallet-approval-custom">
              <input id="walletApprovalCustom" type="number" min="100" max="1000000" step="100" placeholder="Custom amount" />
              <button type="button" id="walletApprovalApply">Set</button>
            </div>
            <button class="wallet-approval-confirm" id="walletApprovalConfirm" type="button">Approve Selected Limit</button>
            <div class="wallet-approval-safety">
              <span><b>What you approve:</b> the maximum CASHX the game contract may spend for future game entries.</span>
              <span><b>What does not happen:</b> selecting a limit does not send CASHX or start a game.</span>
              <span><b>When funds move:</b> only after you confirm a create or join transaction in your wallet.</span>
            </div>
            <div class="wallet-menu-note" id="walletApprovalFeedback">Custom approval must be 100 to 1,000,000 CASHX.</div>
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

  function bindApprovalButtons() {
    const menu = byId('walletBalanceMenu');
    if (menu && !menu.__cashxApprovalDelegated) {
      menu.__cashxApprovalDelegated = true;
      menu.addEventListener('click', event => {
        const presetBtn = event.target.closest('.wallet-approval-btn');
        if (presetBtn && menu.contains(presetBtn)) {
          event.preventDefault();
          event.stopPropagation();
          selectApprovalPreset(presetBtn.dataset.approval, true);
          return;
        }
        const applyBtn = event.target.closest('#walletApprovalApply');
        if (applyBtn && menu.contains(applyBtn)) {
          event.preventDefault();
          event.stopPropagation();
          const customInput = byId('walletApprovalCustom');
          selectApprovalPreset(customInput ? customInput.value : 'bet', true);
          return;
        }
        const confirmBtn = event.target.closest('#walletApprovalConfirm');
        if (confirmBtn && menu.contains(confirmBtn)) {
          event.preventDefault();
          event.stopPropagation();
          approveSelectedLimit();
          return;
        }
        const revokeBtn = event.target.closest('#walletApprovalRevoke');
        if (revokeBtn && menu.contains(revokeBtn)) {
          event.preventDefault();
          event.stopPropagation();
          revokeApproval();
        }
      });
    }
    document.querySelectorAll('.wallet-approval-btn').forEach(btn => {
      if (btn.__cashxApprovalBound) return;
      btn.__cashxApprovalBound = true;
      btn.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        selectApprovalPreset(btn.dataset.approval, true);
      });
    });
    const customInput = byId('walletApprovalCustom');
    const applyBtn = byId('walletApprovalApply');
    if (applyBtn && !applyBtn.__cashxApprovalBound) {
      applyBtn.__cashxApprovalBound = true;
      applyBtn.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        selectApprovalPreset(customInput ? customInput.value : 'bet', true);
      });
    }
    const confirmBtn = byId('walletApprovalConfirm');
    if (confirmBtn && !confirmBtn.__cashxApprovalBound) {
      confirmBtn.__cashxApprovalBound = true;
      confirmBtn.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        approveSelectedLimit();
      });
    }
    const revokeBtn = byId('walletApprovalRevoke');
    if (revokeBtn && !revokeBtn.__cashxApprovalBound) {
      revokeBtn.__cashxApprovalBound = true;
      revokeBtn.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        revokeApproval();
      });
    }
    if (customInput && !customInput.__cashxApprovalBound) {
      customInput.__cashxApprovalBound = true;
      customInput.addEventListener('click', event => event.stopPropagation());
      customInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          selectApprovalPreset(customInput.value, true);
        }
      });
    }
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
    await refreshApprovalAllowance();
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

  function hideConnectedAddressButton() {
    const nav = document.querySelector('.topnav');
    if (!nav || !nav.classList.contains('cashx-wallet-connected')) return;
    const connectBtn = byId('connectBtn');
    if (!connectBtn) return;
    connectBtn.style.setProperty('display', 'none', 'important');
    connectBtn.setAttribute('aria-hidden', 'true');
    connectBtn.tabIndex = -1;
  }
  function cleanBalanceText(text) {
    return String(text || '0')
      .replace(/\s*CASHX\b/gi, '')
      .trim() || '0';
  }

  function normalizeExistingWalletPill() {
    document.querySelectorAll('.wallet-balance-main span:not([id])').forEach(el => {
      el.style.display = 'none';
    });
    document.querySelectorAll('#topCashxBalance, #walletMenuBalance').forEach(el => {
      const clean = cleanBalanceText(el.textContent);
      if (el.textContent !== clean) el.textContent = clean;
    });
  }

  function observeBalanceText() {
    ['topCashxBalance', 'walletMenuBalance'].forEach(id => {
      const el = byId(id);
      if (!el || el.__cashxBalanceObserver) return;
      el.__cashxBalanceObserver = true;
      new MutationObserver(() => {
        const clean = cleanBalanceText(el.textContent);
        if (el.textContent !== clean) el.textContent = clean;
      }).observe(el, { childList: true, characterData: true, subtree: true });
    });
  }

  function updateCashxWalletBalance(text) {
    state.balanceText = cleanBalanceText(text);
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
    const backdrop = byId('cashierBackdrop');
    if (backdrop) backdrop.classList.remove('open');
    document.removeEventListener('click', balanceOutsideClick);
  }

  function closeAccountMenu() {
    const menu = byId('walletAccountMenu');
    if (menu) menu.classList.remove('open');
    document.removeEventListener('click', accountOutsideClick);
  }

  function openCashier(event) {
    if (event) event.stopPropagation();
    closeAccountMenu();
    const menu = byId('walletBalanceMenu');
    if (!menu) return;
    bindApprovalButtons();
    const backdrop = byId('cashierBackdrop');
    if (backdrop && backdrop.parentElement !== document.body) document.body.appendChild(backdrop);
    if (menu.parentElement !== document.body) document.body.appendChild(menu);
    syncApprovalButtons();
    refreshApprovalAllowance();
    menu.classList.add('open');
    if (backdrop) backdrop.classList.add('open');
    setTimeout(() => document.addEventListener('click', balanceOutsideClick), 10);
  }

  function toggleBalanceMenu(event) {
    if (event) event.stopPropagation();
    const menu = byId('walletBalanceMenu');
    if (menu && menu.classList.contains('open')) closeBalanceMenu();
    else openCashier(event);
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
    if (!event.target.closest('#walletBalanceMenu') && !event.target.closest('#cashierBtn')) closeBalanceMenu();
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

  function getApprovalPreset() {
    try {
      return localStorage.getItem('cashx:approvalPreset') || 'bet';
    } catch (_) {
      return 'bet';
    }
  }

  function selectApprovalPreset(value, showFeedback) {
    const next = normalizeApprovalPreset(value);
    try { localStorage.setItem('cashx:approvalPreset', next); } catch (_) {}
    syncApprovalButtons(next, showFeedback);
    window.dispatchEvent(new CustomEvent('cashx:approvalPresetChanged', { detail: { value: next } }));
  }

  async function approveSelectedLimit() {
    const feedbackEl = byId('walletApprovalFeedback');
    const confirmBtn = byId('walletApprovalConfirm');
    try {
      await ensureWalletTools();
      if (!state.address) await connectWallet();
      if (!state.address) throw new Error('Connect your wallet first.');

      const target = getApprovalTarget();
      if (!target || !target.address) throw new Error('Open a game to approve that game contract.');

      const amountWei = getSelectedApprovalAmountWei();
      if (!amountWei) throw new Error('Choose an approval amount first.');

      if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Approving...';
      }
      if (feedbackEl) {
        feedbackEl.textContent = 'Confirm approval in your wallet for ' + target.label + '.';
        feedbackEl.classList.remove('success');
      }

      const signer = await getSigner();
      const cashx = new ethers.Contract(
        window.CashX.config.addresses.cashxToken,
        window.CashX.abis.ERC20,
        signer
      );
      const tx = await cashx.approve(target.address, amountWei);
      if (feedbackEl) feedbackEl.textContent = 'Waiting for approval confirmation...';
      await tx.wait();
      if (feedbackEl) {
        feedbackEl.textContent = 'Approved ' + formatCashxBalance(amountWei) + ' CASHX for ' + target.label + '.';
        feedbackEl.classList.add('success');
      }
      await refreshApprovalAllowance();
    } catch (err) {
      if (feedbackEl) {
        feedbackEl.textContent = readableApprovalError(err);
        feedbackEl.classList.remove('success');
      }
    } finally {
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Approve Selected Limit';
      }
    }
  }

  async function revokeApproval() {
    const feedbackEl = byId('walletApprovalFeedback');
    const revokeBtn = byId('walletApprovalRevoke');
    try {
      await ensureWalletTools();
      if (!state.address) await connectWallet();
      if (!state.address) throw new Error('Connect your wallet first.');

      const target = getApprovalTarget();
      if (!target || !target.address) throw new Error('Open a game to revoke that game contract.');

      if (revokeBtn) {
        revokeBtn.disabled = true;
        revokeBtn.textContent = 'Revoking...';
      }
      if (feedbackEl) {
        feedbackEl.textContent = 'Confirm revoke approval in your wallet for ' + target.label + '.';
        feedbackEl.classList.remove('success');
      }

      const signer = await getSigner();
      const cashx = new ethers.Contract(
        window.CashX.config.addresses.cashxToken,
        window.CashX.abis.ERC20,
        signer
      );
      const tx = await cashx.approve(target.address, 0);
      if (feedbackEl) feedbackEl.textContent = 'Waiting for revoke confirmation...';
      await tx.wait();
      if (feedbackEl) {
        feedbackEl.textContent = 'Approval revoked for ' + target.label + '.';
        feedbackEl.classList.add('success');
      }
      await refreshApprovalAllowance();
    } catch (err) {
      if (feedbackEl) {
        feedbackEl.textContent = readableApprovalError(err);
        feedbackEl.classList.remove('success');
      }
    } finally {
      if (revokeBtn) {
        revokeBtn.disabled = false;
        revokeBtn.textContent = 'Revoke Approval';
      }
    }
  }

  async function refreshApprovalAllowance() {
    const remainingEl = byId('walletApprovalRemaining');
    const targetEl = byId('walletApprovalTarget');
    const target = getApprovalTarget();
    state.approvalTarget = target;

    if (targetEl) {
      targetEl.textContent = target && target.address
        ? 'Allowance for ' + target.label + ' only. Winnings pay back to your wallet.'
        : 'Open a game to view that game allowance.';
    }
    if (!remainingEl) return;
    if (!target || !target.address || !state.address) {
      remainingEl.textContent = '--';
      return;
    }

    try {
      await ensureWalletTools();
      const provider = state.provider || (window.CashX && window.CashX.contracts && window.CashX.contracts.getProvider && window.CashX.contracts.getProvider());
      const cashx = new ethers.Contract(
        window.CashX.config.addresses.cashxToken,
        window.CashX.abis.ERC20,
        provider
      );
      const allowance = await cashx.allowance(state.address, target.address);
      remainingEl.textContent = formatCashxBalance(allowance) + ' CASHX';
    } catch (_) {
      remainingEl.textContent = 'Unavailable';
    }
  }

  async function getSigner() {
    if (state.signer) return state.signer;
    if (!window.ethereum) throw new Error('No wallet detected.');
    const provider = new ethers.providers.Web3Provider(window.ethereum);
    state.provider = provider;
    state.signer = provider.getSigner();
    state.address = await state.signer.getAddress();
    return state.signer;
  }

  function getApprovalTarget() {
    const cfg = window.CashX && window.CashX.config;
    const path = window.location.pathname.toLowerCase();
    if (!cfg || !cfg.contracts) return null;
    if (path.endsWith('/dice.html') || path.includes('/dice.html')) {
      return { label: 'CASHX Dice', address: cfg.contracts.diceGame };
    }
    if (path.includes('/mines-game/live.html')) {
      return { label: 'Live Mines', address: cfg.contracts.liveMinesGame };
    }
    if (path.endsWith('/connect4.html') || path.includes('/connect4.html')) {
      return { label: 'Connect Four', address: cfg.contracts.pvpWager };
    }
    return null;
  }

  function getSelectedApprovalAmountWei() {
    const selected = getApprovalPreset();
    if (selected === 'bet') {
      const betInput = byId('betAmount') || byId('betInput') || byId('wagerInput');
      const rawBet = String(betInput && betInput.value ? betInput.value : '0').trim().replace(/,/g, '');
      if (!/^\d+(\.\d+)?$/.test(rawBet) || Number(rawBet) <= 0) return null;
      return ethers.utils.parseUnits(rawBet, 18);
    }
    const normalized = normalizeApprovalPreset(selected);
    if (normalized === 'bet') return null;
    return ethers.utils.parseUnits(normalized, 18);
  }

  function readableApprovalError(err) {
    const raw = err && (err.reason || (err.data && err.data.message) || err.message);
    if (/user rejected|denied|cancel/i.test(raw || '')) return 'Approval cancelled in wallet.';
    return raw || 'Approval failed. Try again.';
  }

  function syncApprovalButtons(value, showFeedback) {
    const selected = value || getApprovalPreset();
    document.querySelectorAll('.wallet-approval-btn').forEach(btn => {
      btn.classList.toggle('active', String(btn.dataset.approval) === selected);
    });
    const customInput = byId('walletApprovalCustom');
    if (customInput) {
      customInput.value = ['bet', '10000', '100000', '1000000'].includes(selected) ? '' : selected;
    }
    const summary = getApprovalSummary(selected);
    const selectedEl = byId('walletApprovalSelected');
    const descriptionEl = byId('walletApprovalDescription');
    const feedbackEl = byId('walletApprovalFeedback');
    if (selectedEl) selectedEl.textContent = summary.label;
    if (descriptionEl) descriptionEl.textContent = summary.description;
    if (feedbackEl) {
      feedbackEl.textContent = showFeedback ? summary.feedback : 'Custom approval must be 100 to 1,000,000 CASHX.';
      feedbackEl.classList.toggle('success', !!showFeedback);
    }
  }

  function normalizeApprovalPreset(value) {
    const raw = String(value || 'bet').trim().replace(/,/g, '');
    if (raw === 'bet' || raw.toLowerCase() === 'this bet') return 'bet';
    if (!/^\d+(\.\d+)?$/.test(raw)) return 'bet';
    const amount = Math.max(100, Math.min(1000000, Math.floor(Number(raw))));
    if (!Number.isFinite(amount)) return 'bet';
    return String(amount);
  }

  function getApprovalSummary(value) {
    if (value === 'bet') {
      return {
        label: 'This bet only',
        description: 'You will only approve the amount needed for the next game you start or join.',
        feedback: 'Approval limit set to this bet only.',
      };
    }
    const amount = Number(value || 0);
    const formatted = amount.toLocaleString();
    return {
      label: formatted + ' CASHX',
      description: 'You can play multiple games until your approved allowance is used. Unused CASHX remains in your wallet.',
      feedback: 'Approval limit set to ' + formatted + ' CASHX.',
    };
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
    normalizeExistingWalletPill();
    observeBalanceText();
    hideConnectedAddressButton();
    syncApprovalButtons();
    setInterval(hideConnectedAddressButton, 700);
    setTimeout(refreshFromWallet, 250);
    setTimeout(refreshFromWallet, 1800);
  }

  window.CashXNav = {
    connectWallet,
    toggleBalanceMenu,
    openCashier,
    toggleAccountMenu,
    closeBalanceMenu,
    closeAccountMenu,
    copyAddressFromMenu,
    openAccountFromMenu,
    disconnectWallet,
    updateCashxWalletBalance,
    refreshCashxBalance,
    refreshApprovalAllowance,
    applyConnectedWallet,
    selectApprovalPreset,
    getApprovalPreset,
  };

  if (!window.toggleBalanceMenu) window.toggleBalanceMenu = toggleBalanceMenu;
  if (!window.toggleAccountMenu) window.toggleAccountMenu = toggleAccountMenu;
  if (!window.openAccountFromMenu) window.openAccountFromMenu = openAccountFromMenu;
  if (!window.copyWalletAddress) window.copyWalletAddress = copyAddressFromMenu;
  if (!window.disconnectWallet) window.disconnectWallet = disconnectWallet;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}());

















