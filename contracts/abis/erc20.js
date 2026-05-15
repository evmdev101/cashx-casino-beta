'use strict';

(function (root) {
  const CashX = root.CashX = root.CashX || {};
  CashX.abis = CashX.abis || {};

  CashX.abis.ERC20 = [
    'function balanceOf(address account) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'event Approval(address indexed owner, address indexed spender, uint256 value)',
  ];
}(window));
