'use strict';

(function (root) {
  const CashX = root.CashX = root.CashX || {};

  function normalizeGameHistoryEntry(entry) {
    return {
      gameName: entry.gameName || entry.game || 'CashX Game',
      playerWallet: entry.playerWallet || entry.player || entry.wallet || '',
      betAmount: entry.betAmount || entry.bet || '0',
      result: entry.result || '',
      payout: entry.payout || '0',
      burnAmount: entry.burnAmount || entry.burned || '0',
      transactionHash: entry.transactionHash || entry.txHash || '',
      timestamp: entry.timestamp || Date.now(),
    };
  }

  function buildTransactionLink(txHash) {
    if (!txHash) return '';
    return CashX.contracts && CashX.contracts.buildExplorerTxLink
      ? CashX.contracts.buildExplorerTxLink(txHash)
      : 'https://scan.pulsechain.com/tx/' + txHash;
  }

  function addHistoryEntry(feed, entry) {
    const row = normalizeGameHistoryEntry(entry);
    if (Array.isArray(feed)) {
      feed.unshift(row);
      return row;
    }
    return row;
  }

  CashX.history = {
    normalizeGameHistoryEntry,
    buildTransactionLink,
    addHistoryEntry,
  };
}(window));
