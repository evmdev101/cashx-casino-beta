'use strict';

(function (root) {
  const CashX = root.CashX = root.CashX || {};

  function calculateBurnFromLoss(amount, burnBps) {
    const bps = burnBps == null
      ? (CashX.config && CashX.config.economics.diceBurnBps) || 300
      : burnBps;
    return CashX.betting.calculateBurnAmount(amount, bps);
  }

  function formatBurnEvent(event) {
    return {
      gameName: event.gameName || event.game || 'CashX Game',
      playerWallet: event.playerWallet || event.player || '',
      betAmount: event.betAmount || event.bet || '0',
      result: event.result || 'burn',
      payout: event.payout || '0',
      burnAmount: event.burnAmount || event.burned || '0',
      transactionHash: event.transactionHash || event.txHash || '',
      timestamp: event.timestamp || Date.now(),
    };
  }

  function buildBurnExplorerLink(txHash) {
    return CashX.contracts.buildExplorerTxLink(txHash);
  }

  function addBurnToFeed(feed, burnEvent) {
    const row = formatBurnEvent(burnEvent);
    if (Array.isArray(feed)) {
      feed.unshift(row);
      return row;
    }
    if (feed && feed.insertAdjacentHTML) {
      const tx = row.transactionHash
        ? '<a href="' + buildBurnExplorerLink(row.transactionHash) + '" target="_blank" rel="noopener">TX</a>'
        : '';
      feed.insertAdjacentHTML('afterbegin',
        '<tr><td>' + escapeHtml(row.gameName) + '</td><td>' +
        escapeHtml(row.playerWallet) + '</td><td>' +
        escapeHtml(String(row.burnAmount)) + '</td><td>' + tx + '</td></tr>');
    }
    return row;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
  }

  CashX.burn = {
    calculateBurnFromLoss,
    formatBurnEvent,
    addBurnToFeed,
    buildBurnExplorerLink,
  };
}(window));
