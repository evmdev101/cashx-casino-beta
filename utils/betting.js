'use strict';

(function (root) {
  const CashX = root.CashX = root.CashX || {};

  function decimals() {
    return (CashX.config && CashX.config.economics.decimals) || 18;
  }

  function parseBetAmount(value) {
    const text = String(value == null ? '' : value).trim().replace(/,/g, '');
    if (!text || Number(text) <= 0) throw new Error('Enter a valid bet amount.');
    if (root.ethers && root.ethers.utils) return root.ethers.utils.parseUnits(text, decimals());
    return Number(text);
  }

  function formatBetAmount(value, maxDigits = 4) {
    if (value == null) return '0';
    if (root.ethers && root.ethers.BigNumber && root.ethers.BigNumber.isBigNumber(value)) {
      const n = Number(root.ethers.utils.formatUnits(value, decimals()));
      return n.toLocaleString('en-US', { maximumFractionDigits: maxDigits });
    }
    return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: maxDigits });
  }

  function validateBetAmount(value, options = {}) {
    const amount = parseBetAmount(value);
    const asNumber = Number(String(value).replace(/,/g, ''));
    if (options.min != null && asNumber < Number(options.min)) {
      throw new Error('Minimum bet is ' + formatBetAmount(options.min) + ' CASHX.');
    }
    if (options.max != null && asNumber > Number(options.max)) {
      throw new Error('Maximum bet is ' + formatBetAmount(options.max) + ' CASHX.');
    }
    if (options.balance != null && asNumber > Number(options.balance)) {
      throw new Error('Not enough CASHX for this bet.');
    }
    return amount;
  }

  function applyBps(amount, bps) {
    if (root.ethers && root.ethers.BigNumber && root.ethers.BigNumber.isBigNumber(amount)) {
      return amount.mul(Number(bps)).div(10000);
    }
    return Number(amount || 0) * Number(bps || 0) / 10000;
  }

  function calculateBurnAmount(amount, burnBps) {
    return applyBps(amount, burnBps == null ? 300 : burnBps);
  }

  function calculateHouseFee(amount, feeBps) {
    return applyBps(amount, feeBps == null ? 300 : feeBps);
  }

  function calculateNetPayout(potAmount, feeBps) {
    const fee = calculateHouseFee(potAmount, feeBps);
    return root.ethers && root.ethers.BigNumber && root.ethers.BigNumber.isBigNumber(potAmount)
      ? potAmount.sub(fee)
      : Number(potAmount || 0) - fee;
  }

  function calculatePotentialPayout(betAmount, multiplierBps, feeBps) {
    const gross = root.ethers && root.ethers.BigNumber && root.ethers.BigNumber.isBigNumber(betAmount)
      ? betAmount.mul(Number(multiplierBps || 10000)).div(10000)
      : Number(betAmount || 0) * Number(multiplierBps || 10000) / 10000;
    return feeBps ? calculateNetPayout(gross, feeBps) : gross;
  }

  CashX.betting = {
    validateBetAmount,
    parseBetAmount,
    formatBetAmount,
    calculatePotentialPayout,
    calculateBurnAmount,
    calculateHouseFee,
    calculateNetPayout,
  };
}(window));
