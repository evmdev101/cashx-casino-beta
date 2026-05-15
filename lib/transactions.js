'use strict';

(function (root) {
  const CashX = root.CashX = root.CashX || {};

  function formatTransactionError(err) {
    const raw = String(
      err && (err.reason || err.errorName || err.data && err.data.message ||
      err.error && err.error.message || err.message) || ''
    );
    if (err && err.code === 4001) return 'Transaction rejected in wallet.';
    if (err && err.code === 'TRANSACTION_REPLACED' && err.cancelled) return 'Transaction was cancelled.';
    if (/insufficient funds|not enough funds/i.test(raw)) return 'This wallet needs a little PLS for gas.';
    if (/allowance|approval/i.test(raw)) return 'CASHX approval did not complete. Approve again and retry.';
    if (/transfer failed|ERC20|balance/i.test(raw)) return 'CASHX transfer failed. Check your CASHX balance.';
    if (/execution reverted/i.test(raw)) return raw.replace(/^.*execution reverted:?\s*/i, '') || 'Transaction reverted.';
    return raw || 'Transaction failed. Please try again.';
  }

  async function waitForConfirmation(tx, confirmations = 1) {
    try {
      return await tx.wait(confirmations);
    } catch (err) {
      if (err && err.code === 'TRANSACTION_REPLACED' && !err.cancelled && err.receipt) {
        return err.receipt;
      }
      throw err;
    }
  }

  async function sendTransactionSafe(send, options = {}) {
    try {
      showPendingState(options.pendingTarget, options.pendingText || 'Waiting for wallet confirmation...');
      const tx = typeof send === 'function' ? await send() : send;
      showPendingState(options.pendingTarget, options.confirmingText || 'Transaction submitted. Waiting for confirmation...');
      const receipt = await waitForConfirmation(tx, options.confirmations || 1);
      showSuccessState(options.successTarget || options.pendingTarget, options.successText || 'Transaction confirmed.');
      return { tx, receipt };
    } catch (err) {
      const message = formatTransactionError(err);
      showErrorState(options.errorTarget || options.pendingTarget, message);
      throw new Error(message);
    }
  }

  function resolveTarget(target) {
    if (!target) return null;
    return typeof target === 'string' ? document.querySelector(target) : target;
  }

  function setTarget(target, text, className) {
    const el = resolveTarget(target);
    if (!el) return;
    el.textContent = text;
    if (className) el.className = className;
  }

  function showPendingState(target, text) {
    setTarget(target, text || 'Pending...', 'pending');
  }

  function showSuccessState(target, text) {
    setTarget(target, text || 'Success.', 'success');
  }

  function showErrorState(target, text) {
    setTarget(target, text || 'Error.', 'error');
  }

  CashX.transactions = {
    sendTransactionSafe,
    waitForConfirmation,
    formatTransactionError,
    showPendingState,
    showSuccessState,
    showErrorState,
  };
}(window));
