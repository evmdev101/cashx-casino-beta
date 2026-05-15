'use strict';

(function (root) {
  const CashX = root.CashX = root.CashX || {};

  const STATES = {
    IDLE: 'idle',
    WALLET_REQUIRED: 'wallet_required',
    APPROVING: 'approving',
    READY: 'ready',
    PLAYING: 'playing',
    PENDING_TRANSACTION: 'pending_transaction',
    WON: 'won',
    LOST: 'lost',
    ERROR: 'error',
  };

  function createGameState(initialState) {
    let current = initialState || STATES.IDLE;
    const listeners = new Set();
    return {
      getState: () => current,
      setState(next, detail) {
        if (!Object.values(STATES).includes(next)) {
          throw new Error('Unknown game state: ' + next);
        }
        current = next;
        listeners.forEach(listener => listener(current, detail || {}));
        return current;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isTerminal: () => current === STATES.WON || current === STATES.LOST || current === STATES.ERROR,
    };
  }

  CashX.gameState = {
    STATES,
    createGameState,
  };
}(window));
