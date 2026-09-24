/**
 * ============================================================
 * CRYPTORIUM // SERVICES // REAL-TIME WEBSOCKET STREAMING ENGINE
 * Binance Futures USDT-M WebSocket Stream Manager
 * Target Testnet: wss://stream.binancefuture.com/ws/
 * Target Prod:    wss://fstream.binance.com/ws/
 * ============================================================
 */

export const WS_ENDPOINTS = {
  TESTNET: 'wss://stream.binancefuture.com/ws',
  PRODUCTION: 'wss://fstream.binance.com/ws'
};

export const WS_STATUS = {
  CONNECTING: 'CONNECTING',
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  ERROR: 'ERROR'
};

/**
 * Manages real-time WebSocket connection to Binance Futures.
 * Streams real-time aggregate trades (<symbol>@aggTrade) and 1m klines (<symbol>@kline_1m),
 * with resilient auto-reconnect and exponential backoff.
 */
export class BinanceStreamManager {
  /**
   * @param {Object} options
   * @param {string} [options.endpoint=WS_ENDPOINTS.TESTNET] - WebSocket endpoint base URL
   * @param {string} [options.symbol='BTCUSDT'] - Initial contract symbol to stream
   * @param {Function} [options.onTrade] - Callback for aggregate trades: (trade) => void
   * @param {Function} [options.onKline] - Callback for 1-minute klines: (kline) => void
   * @param {Function} [options.onStatusChange] - Callback for connection state: (status, detail) => void
   * @param {boolean} [options.autoReconnect=true] - Whether to auto-reconnect on drop
   */
  constructor(options = {}) {
    this.endpoint = options.endpoint || WS_ENDPOINTS.TESTNET;
    this.symbol = (options.symbol || 'BTCUSDT').toUpperCase();
    this.onTrade = options.onTrade || (() => {});
    this.onKline = options.onKline || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this.autoReconnect = options.autoReconnect !== false;

    this.ws = null;
    this.status = WS_STATUS.CLOSED;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 15;
    this.reconnectTimer = null;
    this.isExplicitlyClosed = false;
    this.heartbeatTimer = null;
    this.lastMessageTime = 0;
  }

  /**
   * Set target endpoint (e.g. switch between Testnet and Production)
   * @param {string} endpointUrl
   */
  setEndpoint(endpointUrl) {
    if (this.endpoint !== endpointUrl) {
      this.endpoint = endpointUrl;
      if (this.ws && (this.status === WS_STATUS.OPEN || this.status === WS_STATUS.CONNECTING)) {
        this.reconnectImmediate();
      }
    }
  }

  /**
   * Connects to the Binance Futures WebSocket stream
   */
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isExplicitlyClosed = false;
    this.clearTimers();
    this.setStatus(WS_STATUS.CONNECTING, `Connecting to ${this.endpoint}...`);

    try {
      this.ws = new WebSocket(this.endpoint);

      this.ws.onopen = (event) => {
        this.reconnectAttempts = 0;
        this.lastMessageTime = Date.now();
        this.setStatus(WS_STATUS.OPEN, `Connected to ${this.endpoint}`);
        this.subscribeSymbol(this.symbol);
        this.startHeartbeat();
      };

      this.ws.onmessage = (event) => {
        this.lastMessageTime = Date.now();
        this.handleMessage(event.data);
      };

      this.ws.onerror = (event) => {
        this.setStatus(WS_STATUS.ERROR, 'WebSocket encountered an error or connection was interrupted');
      };

      this.ws.onclose = (event) => {
        this.clearTimers();
        const reason = event.reason ? ` (${event.reason})` : '';
        this.setStatus(WS_STATUS.CLOSED, `Connection closed [Code: ${event.code}]${reason}`);

        if (!this.isExplicitlyClosed && this.autoReconnect) {
          this.scheduleReconnect();
        }
      };
    } catch (err) {
      this.setStatus(WS_STATUS.ERROR, `Failed to initialize WebSocket: ${err.message}`);
      if (!this.isExplicitlyClosed && this.autoReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Closes the active WebSocket connection cleanly and inhibits auto-reconnect.
   */
  disconnect() {
    this.isExplicitlyClosed = true;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close(1000, 'Client closed connection');
      } catch (_) {}
      this.ws = null;
    }
    this.setStatus(WS_STATUS.CLOSED, 'WebSocket connection terminated by operator');
  }

  /**
   * Internal immediate reconnect without exponential delay
   */
  reconnectImmediate() {
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close(1000, 'Reconnecting');
      } catch (_) {}
      this.ws = null;
    }
    this.connect();
  }

  /**
   * Schedules reconnection using exponential backoff
   */
  scheduleReconnect() {
    if (this.isExplicitlyClosed) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setStatus(WS_STATUS.CLOSED, `Max reconnection attempts (${this.maxReconnectAttempts}) reached. Auto-reconnect stopped.`);
      return;
    }

    this.reconnectAttempts += 1;
    // Exponential backoff: 1s, 1.8s, 3.2s, 5.8s, 10s... capped at 30s
    const delay = Math.min(30000, Math.round(1000 * Math.pow(1.8, this.reconnectAttempts - 1)));

    this.setStatus(
      WS_STATUS.CONNECTING,
      `Connection lost. Reconnecting in ${(delay / 1000).toFixed(1)}s (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Subscribe to aggregate trades and 1m klines for a given contract symbol
   * @param {string} symbol - Contract symbol (e.g., 'BTCUSDT')
   */
  subscribeSymbol(symbol) {
    const prevSymbol = this.symbol;
    this.symbol = symbol.toUpperCase().trim();

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const symLower = this.symbol.toLowerCase();
    const prevLower = prevSymbol ? prevSymbol.toLowerCase() : null;

    // If changing symbol, unsubscribe from previous streams
    if (prevLower && prevLower !== symLower) {
      const unsubPayload = {
        method: 'UNSUBSCRIBE',
        params: [
          `${prevLower}@aggTrade`,
          `${prevLower}@kline_1m`
        ],
        id: Date.now()
      };
      this.sendSafe(unsubPayload);
    }

    // Subscribe to aggTrade and kline_1m
    const subPayload = {
      method: 'SUBSCRIBE',
      params: [
        `${symLower}@aggTrade`,
        `${symLower}@kline_1m`
      ],
      id: Date.now() + 1
    };

    this.sendSafe(subPayload);
  }

  /**
   * Sends JSON payload to active WebSocket
   * @param {Object} data
   */
  sendSafe(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(data));
      } catch (err) {
        // Socket write error
      }
    }
  }

  /**
   * Parses incoming WebSocket messages
   * @param {string} rawMessage
   */
  handleMessage(rawMessage) {
    try {
      const data = JSON.parse(rawMessage);

      // Ignore standard subscription responses
      if (data.result === null && data.id) {
        return;
      }

      // 1. Aggregate Trade stream (<symbol>@aggTrade)
      // Fields: e (event type), s (symbol), p (price), q (quantity), T (trade time), m (isBuyerMaker)
      if (data.e === 'aggTrade') {
        const trade = {
          symbol: data.s,
          price: parseFloat(data.p),
          quantity: parseFloat(data.q),
          tradeTime: data.T,
          isBuyerMaker: data.m,
          timestamp: Date.now()
        };
        this.onTrade(trade);
        return;
      }

      // 2. 1-Minute Kline stream (<symbol>@kline_1m)
      // Fields: e (event type), s (symbol), k (kline object)
      // k.t (start), k.T (close), k.o (open), k.c (close), k.h (high), k.l (low), k.v (volume), k.x (isClosed)
      if (data.e === 'kline' && data.k) {
        const k = data.k;
        const kline = {
          symbol: data.s,
          interval: k.i,
          startTime: k.t,
          closeTime: k.T,
          open: parseFloat(k.o),
          close: parseFloat(k.c),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          volume: parseFloat(k.v),
          tradesCount: k.n,
          isClosed: Boolean(k.x)
        };
        this.onKline(kline);
        return;
      }

      // Handle combined stream format if wrapped: { stream: "...", data: {...} }
      if (data.stream && data.data) {
        const inner = data.data;
        if (inner.e === 'aggTrade') {
          this.onTrade({
            symbol: inner.s,
            price: parseFloat(inner.p),
            quantity: parseFloat(inner.q),
            tradeTime: inner.T,
            isBuyerMaker: inner.m,
            timestamp: Date.now()
          });
        } else if (inner.e === 'kline' && inner.k) {
          const k = inner.k;
          this.onKline({
            symbol: inner.s,
            interval: k.i,
            startTime: k.t,
            closeTime: k.T,
            open: parseFloat(k.o),
            close: parseFloat(k.c),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            volume: parseFloat(k.v),
            tradesCount: k.n,
            isClosed: Boolean(k.x)
          });
        }
      }
    } catch (err) {
      // Non-critical JSON parse ignore
    }
  }

  /**
   * Internal status change emitter
   */
  setStatus(newStatus, detail = '') {
    this.status = newStatus;
    this.onStatusChange(newStatus, detail);
  }

  /**
   * Heartbeat to detect dead or frozen connections
   */
  startHeartbeat() {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.status === WS_STATUS.OPEN) {
        // If no message has arrived in 35 seconds, cycle connection
        const timeSinceLastMsg = Date.now() - this.lastMessageTime;
        if (timeSinceLastMsg > 35000 && !this.isExplicitlyClosed) {
          this.setStatus(WS_STATUS.ERROR, 'Stream heartbeat timeout (no ticks in 35s). Cycling connection...');
          this.reconnectImmediate();
        }
      }
    }, 15000);
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHeartbeat();
  }
}

// Global browser window fallback
if (typeof window !== 'undefined') {
  window.BinanceStreamManager = BinanceStreamManager;
  window.WS_ENDPOINTS = WS_ENDPOINTS;
  window.WS_STATUS = WS_STATUS;
}

export default BinanceStreamManager;
