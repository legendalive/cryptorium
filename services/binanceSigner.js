/**
 * ============================================================
 * CRYPTORIUM // SERVICES // BINANCE SIGNER
 * Browser Cryptography Module using native window.crypto.subtle
 * HMAC-SHA256 Payload Signature for Binance Futures REST API
 * ============================================================
 */

/**
 * Signs a query string or request payload using HMAC-SHA256 with the browser's
 * native SubtleCrypto API. Does not rely on any external npm packages (no CryptoJS).
 *
 * @param {string} queryString - The raw query string or request body to sign (e.g., "timestamp=1690000000000&recvWindow=5000")
 * @param {string} apiSecret - The user's Binance API secret key
 * @returns {Promise<string>} Hex-encoded lowercase signature string formatted for Binance REST endpoints
 */
export async function signPayload(queryString, apiSecret) {
  if (typeof queryString !== 'string') {
    throw new TypeError('queryString must be a string');
  }
  if (!apiSecret || typeof apiSecret !== 'string') {
    throw new Error('Valid apiSecret string is required to sign payload');
  }

  // Ensure window.crypto and subtle are available
  const subtle = window.crypto && (window.crypto.subtle || window.crypto.webkitSubtle);
  if (!subtle) {
    throw new Error('Native window.crypto.subtle is not supported in this browser environment');
  }

  const encoder = new TextEncoder();
  const keyBuffer = encoder.encode(apiSecret);
  const dataBuffer = encoder.encode(queryString);

  // Import raw secret key for HMAC SHA-256
  const cryptoKey = await subtle.importKey(
    'raw',
    keyBuffer,
    {
      name: 'HMAC',
      hash: { name: 'SHA-256' }
    },
    false, // not extractable
    ['sign']
  );

  // Sign data buffer
  const signatureBuffer = await subtle.sign(
    'HMAC',
    cryptoKey,
    dataBuffer
  );

  // Convert ArrayBuffer into lowercase hex string
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  const hexSignature = hashArray
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');

  return hexSignature;
}

// Global browser window fallback for non-module script environments
if (typeof window !== 'undefined') {
  window.CryptoriumSigner = { signPayload };
}
