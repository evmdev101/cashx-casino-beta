const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadBrowserScript(windowObj, relativePath) {
  const abs = path.join(__dirname, '..', relativePath);
  const code = fs.readFileSync(abs, 'utf8');

  const context = {
    window: windowObj,
    console,
    setTimeout,
    clearTimeout,
    fetch: undefined,
  };
  context.window = context.window || {};

  vm.runInNewContext(code, context, { filename: abs });
  return context.window;
}

test('utils/gameState creates and transitions state', () => {
  const windowObj = {};
  loadBrowserScript(windowObj, 'utils/gameState.js');

  assert.ok(windowObj.CashX);
  const { STATES, createGameState } = windowObj.CashX.gameState;

  const gs = createGameState(STATES.IDLE);
  assert.equal(gs.getState(), STATES.IDLE);
  assert.equal(gs.isTerminal(), false);

  let called = 0;
  const unsub = gs.subscribe((state, detail) => {
    called++;
    assert.equal(state, STATES.READY);
    assert.deepEqual(detail, { from: 'test' });
  });

  gs.setState(STATES.READY, { from: 'test' });
  unsub();
  assert.equal(called, 1);

  gs.setState(STATES.WON);
  assert.equal(gs.isTerminal(), true);
});

test('utils/betting validates and computes payouts (number path)', () => {
  const windowObj = { CashX: { config: { economics: { decimals: 18 } } } };
  loadBrowserScript(windowObj, 'utils/betting.js');

  const betting = windowObj.CashX.betting;
  assert.throws(() => betting.validateBetAmount('0'), /valid bet amount/i);
  assert.throws(() => betting.validateBetAmount('-1'), /valid bet amount/i);

  assert.equal(betting.validateBetAmount('1', { min: 0.5 }), 1);
  assert.throws(() => betting.validateBetAmount('0.4', { min: 0.5 }), /Minimum bet/i);

  assert.equal(betting.calculateBurnAmount(100, 300), 3);
  assert.equal(betting.calculateHouseFee(100, 300), 3);
  assert.equal(betting.calculateNetPayout(100, 300), 97);

  // gross 2.0x, then apply 3% fee
  assert.equal(betting.calculatePotentialPayout(100, 20000, 300), 194);
});

test('utils/burn formats and appends feed entries', () => {
  const windowObj = {
    CashX: {
      config: { economics: { diceBurnBps: 300 } },
      contracts: { buildExplorerTxLink: (tx) => `https://scan.example/tx/${tx}` },
    },
  };
  loadBrowserScript(windowObj, 'utils/betting.js');
  loadBrowserScript(windowObj, 'utils/burn.js');

  const burn = windowObj.CashX.burn;
  assert.equal(burn.calculateBurnFromLoss(100, 500), 5);

  const feed = [];
  const row = burn.addBurnToFeed(feed, {
    gameName: 'Dice',
    playerWallet: '0xabc',
    burnAmount: '123',
    transactionHash: '0xdead',
  });
  assert.equal(feed.length, 1);
  assert.equal(row.gameName, 'Dice');
  assert.equal(row.transactionHash, '0xdead');
});

