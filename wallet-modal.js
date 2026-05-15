'use strict';

const WM_CONFIG = window.CashX && window.CashX.config;
const WM_CHAIN_ID  = WM_CONFIG ? WM_CONFIG.chain.id : 369;
const WM_CHAIN_HEX = WM_CONFIG ? WM_CONFIG.chain.hexId : '0x171';
const WM_CHAIN_NAME = WM_CONFIG ? WM_CONFIG.chain.name : 'PulseChain';
const WM_RPC_URL = WM_CONFIG ? WM_CONFIG.chain.rpcUrl : 'https://rpc.pulsechain.com';
const WM_EXPLORER_URL = WM_CONFIG ? WM_CONFIG.chain.explorerBaseUrl : 'https://scan.pulsechain.com';

// Inject styles once
(function () {
  if (document.getElementById('wm-css')) return;
  const s = document.createElement('style');
  s.id = 'wm-css';
  s.textContent = `
    .wm-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,.78);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      z-index: 9999;
      display: flex; align-items: center; justify-content: center;
    }
    @keyframes wmIn {
      from { opacity: 0; transform: scale(.95) translateY(18px); }
      to   { opacity: 1; transform: scale(1)   translateY(0); }
    }
    .wm-box {
      background: rgba(13,10,22,.98);
      border: 1px solid rgba(200,85,247,.3);
      border-radius: 24px;
      padding: 2rem 2rem 1.8rem;
      width: min(400px, 92vw);
      box-shadow: 0 32px 90px rgba(0,0,0,.9);
      animation: wmIn .22s cubic-bezier(.25,.46,.45,.94);
    }
    .wm-head {
      display: flex; align-items: center;
      justify-content: space-between;
      margin-bottom: 1.6rem;
    }
    .wm-title {
      font-family: 'Bebas Neue', 'Barlow Condensed', sans-serif;
      font-size: 1.55rem;
      letter-spacing: 3px;
      color: #fff;
    }
    .wm-title em { font-style: normal; color: #c855f7; }
    .wm-x {
      width: 30px; height: 30px;
      border-radius: 50%;
      border: 1px solid rgba(255,255,255,.15);
      background: transparent;
      color: rgba(255,255,255,.45);
      font-size: .9rem;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background .15s, color .15s;
      line-height: 1;
    }
    .wm-x:hover { background: rgba(255,255,255,.1); color: #fff; }
    .wm-opts { display: flex; flex-direction: column; gap: .6rem; }
    .wm-btn {
      display: flex; align-items: center; gap: 1rem;
      padding: 1rem 1.2rem;
      background: rgba(255,255,255,.04);
      border: 1px solid rgba(255,255,255,.09);
      border-radius: 14px;
      cursor: pointer;
      transition: background .18s, border-color .18s, transform .15s;
      text-align: left; width: 100%;
    }
    .wm-btn:hover {
      background: rgba(200,85,247,.09);
      border-color: rgba(200,85,247,.4);
      transform: translateX(4px);
    }
    .wm-icon {
      width: 46px; height: 46px;
      border-radius: 12px;
      background: rgba(255,255,255,.07);
      display: flex; align-items: center; justify-content: center;
      font-size: 1.5rem;
      flex-shrink: 0;
    }
    .wm-info { flex: 1; }
    .wm-name {
      font-family: 'Bebas Neue', 'Barlow Condensed', sans-serif;
      font-size: 1rem; letter-spacing: 2px;
      color: #fff; margin-bottom: .18rem;
    }
    .wm-sub {
      font-size: .76rem;
      color: rgba(220,224,240,.4);
      font-family: 'Barlow', sans-serif;
      line-height: 1.35;
    }
    .wm-arrow { color: rgba(255,255,255,.2); font-size: 1.1rem; }
    .wm-msg {
      margin-top: .9rem; padding: .55rem 1rem;
      border-radius: 10px; font-size: .8rem;
      text-align: center; font-family: 'Barlow', sans-serif;
      display: none;
    }
    .wm-msg.info { display:block; color:#f5a623; background:rgba(245,166,35,.06); border:1px solid rgba(245,166,35,.2); }
    .wm-msg.err  { display:block; color:#ff4455; background:rgba(255,68,85,.06);  border:1px solid rgba(255,68,85,.2); }
    .wm-footer {
      margin-top: 1.2rem; text-align: center;
      font-size: .7rem; color: rgba(220,224,240,.2);
      font-family: 'Barlow', sans-serif; letter-spacing: .5px;
    }
  `;
  document.head.appendChild(s);
}());

// Main function
function showWalletModal() {
  return new Promise((resolve, reject) => {

    const overlay = document.createElement('div');
    overlay.className = 'wm-overlay';
    overlay.innerHTML = `
      <div class="wm-box">
        <div class="wm-head">
          <div class="wm-title">SELECT <em>WALLET</em></div>
          <button class="wm-x">✕</button>
        </div>
        <div class="wm-opts">
          <button class="wm-btn" id="wmBrowser">
            <div class="wm-icon">🦊</div>
            <div class="wm-info">
              <div class="wm-name">Browser Wallet</div>
              <div class="wm-sub">MetaMask, Internet Money, Rabby &amp; any extension wallet</div>
            </div>
            <div class="wm-arrow">›</div>
          </button>
        </div>
        <div class="wm-msg" id="wmMsg"></div>
        <div class="wm-footer">Connecting to PulseChain (Chain ID ${WM_CHAIN_ID})</div>
      </div>
    `;
    document.body.appendChild(overlay);

    const setMsg = (text, type) => {
      const el = document.getElementById('wmMsg');
      el.textContent = text;
      el.className = 'wm-msg ' + type;
    };

    const dismiss = () => {
      overlay.remove();
      reject(new Error('dismissed'));
    };

    overlay.querySelector('.wm-x').onclick = dismiss;
    overlay.addEventListener('click', e => { if (e.target === overlay) dismiss(); });

    // Browser Wallet
    document.getElementById('wmBrowser').onclick = async () => {
      if (!window.ethereum) {
        setMsg('No wallet detected. Please install MetaMask or Internet Money Wallet.', 'err');
        return;
      }
      setMsg('Connecting…', 'info');
      try {
        if (window.CashX && window.CashX.wallet && window.CashX.contracts) {
          const result = await window.CashX.wallet.connectWallet();
          overlay.remove();
          resolve(result);
          return;
        }
        await window.ethereum.request({ method: 'eth_requestAccounts' });
        let p = new ethers.providers.Web3Provider(window.ethereum);
        const net = await p.getNetwork();
        if (net.chainId !== WM_CHAIN_ID) {
          setMsg('Switching to PulseChain…', 'info');
          try {
            await window.ethereum.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId: WM_CHAIN_HEX }],
            });
          } catch (sw) {
            if (sw.code === 4902) {
              await window.ethereum.request({
                method: 'wallet_addEthereumChain',
                params: [{
                  chainId: WM_CHAIN_HEX, chainName: WM_CHAIN_NAME,
                  nativeCurrency: { name: 'Pulse', symbol: 'PLS', decimals: 18 },
                  rpcUrls: [WM_RPC_URL],
                  blockExplorerUrls: [WM_EXPLORER_URL],
                }],
              });
            } else throw sw;
          }
          p = new ethers.providers.Web3Provider(window.ethereum);
        }
        const signer  = p.getSigner();
        const address = await signer.getAddress();
        overlay.remove();
        resolve({ provider: p, signer, address });
      } catch (err) {
        setMsg(err.code === 4001
          ? 'Rejected — please approve in your wallet.'
          : 'Error: ' + (err.message || 'Unknown error'), 'err');
      }
    };

  });
}

window.showWalletModal = showWalletModal;
