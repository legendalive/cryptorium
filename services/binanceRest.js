/**
============================================================
CRYPTORIUM // SERVICES // BINANCE REST GATEWAY
Binance Futures USDT-M REST API Gateway
============================================================
*/
import { signPayload } from './binanceSigner.js';

export const DEFAULT_REST_URL = 'https://testnet.binancefuture.com';
export const PRODUCTION_REST_URL = 'https://fapi.binance.com';

let cachedDriftMs = 0;

export const SYMBOL_PRECISION = {
  'BTCUSDT': { qtyStep: 0.001, qtyDecimals: 3, priceTick: 0.10, priceDecimals: 2, minNotional: 50.00 },
  'ETHUSDT': { qtyStep: 0.001, qtyDecimals: 3, priceTick: 0.01, priceDecimals: 2, minNotional: 10.00 },
  'SOLUSDT': { qtyStep: 0.01, qtyDecimals: 2, priceTick: 0.01, priceDecimals: 2, minNotional: 10.00 },
  'BNBUSDT': { qtyStep: 0.01, qtyDecimals: 2, priceTick: 0.01, priceDecimals: 2, minNotional: 10.00 },
  'XRPUSDT': { qtyStep: 0.1, qtyDecimals: 1, priceTick: 0.0001, priceDecimals: 4, minNotional: 5.00 },
  'DEFAULT': { qtyStep: 0.001, qtyDecimals: 3, priceTick: 0.01, priceDecimals: 2, minNotional: 10.00 }
};

export function formatQuantity(symbol, qty) {
  const norm = (symbol || '').toUpperCase().trim();
  const rule = SYMBOL_PRECISION[norm] || SYMBOL_PRECISION.DEFAULT;
  const numQty = Number(qty);
  if (isNaN(numQty) || numQty <= 0) return '0';
  let stepped = Math.floor(numQty / rule.qtyStep) * rule.qtyStep;
  if (stepped === 0) { stepped = rule.qtyStep; }
  return stepped.toFixed(rule.qtyDecimals);
}

export function formatPrice(symbol, price) {
  const norm = (symbol || '').toUpperCase().trim();
  const rule = SYMBOL_PRECISION[norm] || SYMBOL_PRECISION.DEFAULT;
  const numPrice = Number(price);
  if (isNaN(numPrice) || numPrice <= 0) return '0.00';
  return numPrice.toFixed(rule.priceDecimals);
}

export async function fetchWithBackoff(url, options, maxRetries = 3) {
  const isPrivateRequest = options.headers && options.headers['X-MBX-APIKEY'];
  const CORS_PROXY = 'https://api.codetabs.com/v1/proxy?quest=';
  const finalUrl = isPrivateRequest ? CORS_PROXY + encodeURIComponent(url) : url;

  let attempt = 0;
  while (true) {
    let response;
    try {
      response = await fetch(finalUrl, options);
    } catch (netErr) {
      if (attempt < maxRetries) {
        attempt++;
        const backoffDelay = Math.min(30000, 1000 * Math.pow(2, attempt - 1));
        await new Promise(r => setTimeout(r, backoffDelay));
        continue;
      }
      throw netErr;
    }
    if (response.status === 429 || response.status === 418) {
      if (attempt < maxRetries) {
        attempt++;
        const retryAfterHeader = response.headers ? response.headers.get('Retry-After') : null;
        const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 0;
        const backoffDelay = (retryAfterSec > 0) ? Math.min(30000, retryAfterSec * 1000) : Math.min(30000, 1000 * Math.pow(2, attempt - 1));
        await new Promise(r => setTimeout(r, backoffDelay));
        continue;
      }
    }
    return response;
  }
}

export async function checkServerTime(baseUrl = DEFAULT_REST_URL) {
  const localBefore = Date.now();
  const endpoint = `${baseUrl}/fapi/v1/time`;
  try {
    const response = await fetchWithBackoff(endpoint, { method: 'GET', headers: { 'Accept': 'application/json' } });
    if (!response.ok) { throw new Error(`HTTP ${response.status}: ${response.statusText}`); }
    const data = await response.json();
    const localAfter = Date.now();
    const clientMidpoint = Math.round((localBefore + localAfter) / 2);
    const serverTime = Number(data.serverTime);
    cachedDriftMs = serverTime - clientMidpoint;
    return { serverTime, localTime: clientMidpoint, driftMs: cachedDriftMs };
  } catch (error) {
    return { serverTime: Date.now(), localTime: Date.now(), driftMs: cachedDriftMs, error: error.message };
  }
}

export function getSynchronizedTimestamp() { return Date.now() + cachedDriftMs; }

export async function fetchAccountMetrics(apiKey, apiSecret, baseUrl = DEFAULT_REST_URL) {
  if (!apiKey || !apiSecret) { throw new Error('Both apiKey and apiSecret are required to fetch account metrics'); }
  const timestamp = getSynchronizedTimestamp();
  const queryString = `timestamp=${timestamp}&recvWindow=5000`;
  const signature = await signPayload(queryString, apiSecret);
  const url = `${baseUrl}/fapi/v2/account?${queryString}&signature=${signature}`;
  const response = await fetchWithBackoff(url, { method: 'GET', headers: { 'X-MBX-APIKEY': apiKey, 'Accept': 'application/json' } });
  if (!response.ok) {
    let errorDetail = response.statusText;
    try { const errJson = await response.json(); errorDetail = errJson.msg || errJson.message || errorDetail; } catch (_) {}
    throw new Error(`Binance account error (${response.status}): ${errorDetail}`);
  }
  const data = await response.json();
  const walletBalance = parseFloat(data.totalWalletBalance || data.totalCrossWalletBalance || 0);
  const marginUsed = parseFloat(data.totalInitialMargin || data.totalPositionInitialMargin || 0);
  const freeMargin = parseFloat(data.availableBalance || data.maxWithdrawAmount || 0);
  const unrealizedProfit = parseFloat(data.totalUnrealizedProfit || 0);
  return { walletBalance, marginUsed, freeMargin, unrealizedProfit, raw: data };
}

export async function setLeverage(apiKey, apiSecret, symbol, leverage = 2, baseUrl = DEFAULT_REST_URL) {
  if (!apiKey || !apiSecret) { throw new Error('Both apiKey and apiSecret are required to set leverage'); }
  if (!symbol) { throw new Error('Contract symbol is required'); }
  const numericLeverage = Math.round(Number(leverage) || 1);
  const clampedLeverage = Math.max(1, Math.min(2, numericLeverage));
  const timestamp = getSynchronizedTimestamp();
  const normalizedSymbol = symbol.toUpperCase().trim();
  const payload = `symbol=${normalizedSymbol}&leverage=${clampedLeverage}&timestamp=${timestamp}&recvWindow=5000`;
  const signature = await signPayload(payload, apiSecret);
  const url = `${baseUrl}/fapi/v1/leverage?${payload}&signature=${signature}`;
  const response = await fetchWithBackoff(url, { method: 'POST', headers: { 'X-MBX-APIKEY': apiKey, 'Accept': 'application/json' } });
  if (!response.ok) {
    let errorDetail = response.statusText;
    try { const errJson = await response.json(); errorDetail = errJson.msg || errJson.message || errorDetail; } catch (_) {}
    throw new Error(`Binance leverage error (${response.status}): ${errorDetail}`);
  }
  const data = await response.json();
  return { symbol: data.symbol || normalizedSymbol, leverage: Number(data.leverage) || clampedLeverage, maxNotionalValue: data.maxNotionalValue || '0', raw: data };
}

export async function fetchOpenPositions(apiKey, apiSecret, baseUrl = DEFAULT_REST_URL) {
  if (!apiKey || !apiSecret) { throw new Error('Both apiKey and apiSecret are required to fetch open positions'); }
  const timestamp = getSynchronizedTimestamp();
  const queryString = `timestamp=${timestamp}&recvWindow=5000`;
  const signature = await signPayload(queryString, apiSecret);
  const url = `${baseUrl}/fapi/v2/positionRisk?${queryString}&signature=${signature}`;
  const response = await fetchWithBackoff(url, { method: 'GET', headers: { 'X-MBX-APIKEY': apiKey, 'Accept': 'application/json' } });
  if (!response.ok) {
    let errorDetail = response.statusText;
    try { const errJson = await response.json(); errorDetail = errJson.msg || errJson.message || errorDetail; } catch (_) {}
    throw new Error(`Binance positionRisk error (${response.status}): ${errorDetail}`);
  }
  const rawPositions = await response.json();
  if (!Array.isArray(rawPositions)) { return []; }
  const activePositions = rawPositions
    .filter(pos => { const amt = parseFloat(pos.positionAmt); return !isNaN(amt) && amt !== 0; })
    .map(pos => {
      const positionAmt = parseFloat(pos.positionAmt);
      return {
        symbol: pos.symbol, positionAmt, side: positionAmt > 0 ? 'LONG' : 'SHORT',
        entryPrice: parseFloat(pos.entryPrice || 0), markPrice: parseFloat(pos.markPrice || 0),
        unRealizedProfit: parseFloat(pos.unRealizedProfit || 0), leverage: parseInt(pos.leverage, 10) || 1,
        liquidationPrice: parseFloat(pos.liquidationPrice || 0), marginType: pos.marginType || 'cross', isolatedMargin: parseFloat(pos.isolatedMargin || 0)
      };
    });
  return activePositions;
}

export async function dispatchOrder(apiKey, apiSecret, orderParams, baseUrl = DEFAULT_REST_URL) {
  if (!apiKey || !apiSecret) { throw new Error('apiKey and apiSecret required to dispatch orders'); }
  const timestamp = getSynchronizedTimestamp();
  const normalizedSymbol = orderParams.symbol.toUpperCase().trim();
  const queryParts = [
    `symbol=${encodeURIComponent(normalizedSymbol)}`, `side=${encodeURIComponent(orderParams.side.toUpperCase())}`,
    `type=${encodeURIComponent(orderParams.type.toUpperCase())}`, `timestamp=${timestamp}`, `recvWindow=5000`
  ];
  if (orderParams.quantity !== undefined && orderParams.quantity !== null) {
    const formattedQty = formatQuantity(normalizedSymbol, orderParams.quantity);
    queryParts.push(`quantity=${encodeURIComponent(formattedQty)}`);
  }
  if (orderParams.stopPrice !== undefined && orderParams.stopPrice !== null) {
    const formattedStop = formatPrice(normalizedSymbol, orderParams.stopPrice);
    queryParts.push(`stopPrice=${encodeURIComponent(formattedStop)}`);
  }
  if (orderParams.reduceOnly) { queryParts.push('reduceOnly=true'); }
  if (orderParams.closePosition) { queryParts.push('closePosition=true'); }
  if (orderParams.positionSide) { queryParts.push(`positionSide=${encodeURIComponent(orderParams.positionSide.toUpperCase())}`); }
  const queryString = queryParts.join('&');
  const signature = await signPayload(queryString, apiSecret);
  const url = `${baseUrl}/fapi/v1/order?${queryString}&signature=${signature}`;
  const response = await fetchWithBackoff(url, { method: 'POST', headers: { 'X-MBX-APIKEY': apiKey, 'Accept': 'application/json' } });
  if (!response.ok) {
    let errorDetail = response.statusText;
    try { const errJson = await response.json(); errorDetail = errJson.msg || errJson.message || errorDetail; } catch (_) {}
    throw new Error(`Binance dispatchOrder error (${response.status}): ${errorDetail}`);
  }
  return await response.json();
}

export async function cancelAllOpenOrders(apiKey, apiSecret, symbol, baseUrl = DEFAULT_REST_URL) {
  if (!apiKey || !apiSecret) { throw new Error('apiKey and apiSecret required to cancel all open orders'); }
  const timestamp = getSynchronizedTimestamp();
  const normalizedSymbol = symbol.toUpperCase().trim();
  const queryString = `symbol=${encodeURIComponent(normalizedSymbol)}&timestamp=${timestamp}&recvWindow=5000`;
  const signature = await signPayload(queryString, apiSecret);
  const url = `${baseUrl}/fapi/v1/allOpenOrders?${queryString}&signature=${signature}`;
  const response = await fetchWithBackoff(url, { method: 'DELETE', headers: { 'X-MBX-APIKEY': apiKey, 'Accept': 'application/json' } });
  if (!response.ok) {
    let errorDetail = response.statusText;
    try { const errJson = await response.json(); errorDetail = errJson.msg || errJson.message || errorDetail; } catch (_) {}
    throw new Error(`Binance cancelAllOpenOrders error (${response.status}): ${errorDetail}`);
  }
  return await response.json();
}

export async function closePositionMarket(apiKey, apiSecret, symbol, positionSide, quantity, baseUrl = DEFAULT_REST_URL) {
  const closeSide = positionSide === 'LONG' ? 'SELL' : 'BUY';
  return await dispatchOrder(apiKey, apiSecret, { symbol, side: closeSide, type: 'MARKET', quantity, reduceOnly: true }, baseUrl);
}

if (typeof window !== 'undefined') {
  window.CryptoriumRest = {
    DEFAULT_REST_URL, PRODUCTION_REST_URL, SYMBOL_PRECISION, formatQuantity, formatPrice,
    fetchWithBackoff, checkServerTime, getSynchronizedTimestamp, fetchAccountMetrics,
    setLeverage, fetchOpenPositions, dispatchOrder, cancelAllOpenOrders, closePositionMarket
  };
}
