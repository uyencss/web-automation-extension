const { RunnerError, classifyMessage, normalizeError, isRetryableCode } = require('./errors');

const DEFAULT_GATEWAY_URL = 'http://localhost:7865/api';

function getGatewayUrl(gatewayUrl) {
  return gatewayUrl || process.env.WEBMCP_GATEWAY_URL || DEFAULT_GATEWAY_URL;
}

function makeAbortError(message, code = 'ABORTED') {
  return new RunnerError(message, { code, retryable: code === 'TIMEOUT' });
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RunnerError('Gateway returned a non-JSON response', {
      code: 'GATEWAY_BAD_RESPONSE',
      status: response.status,
      details: { body: text.slice(0, 1000) },
      cause: error,
    });
  }
}

async function sendCommand(method, params = {}, options = {}) {
  const gatewayUrl = getGatewayUrl(options.gatewayUrl);
  const timeoutMs = options.timeoutMs;
  const controller = new AbortController();
  let timeoutTimer = null;

  const abortFromExternalSignal = () => {
    const reason = options.signal?.reason;
    controller.abort(reason || makeAbortError(`Command "${method}" aborted`));
  };

  if (options.signal?.aborted) {
    throw normalizeError(options.signal.reason || makeAbortError(`Command "${method}" aborted`), 'ABORTED');
  }

  if (options.signal) {
    options.signal.addEventListener('abort', abortFromExternalSignal, { once: true });
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      controller.abort(makeAbortError(`Command "${method}" timed out after ${timeoutMs}ms`, 'TIMEOUT'));
    }, timeoutMs);
  }

  try {
    const response = await fetch(gatewayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
      signal: controller.signal,
    });

    const data = await parseJsonResponse(response);

    if (!response.ok) {
      const message = data.error || `Gateway returned HTTP ${response.status}`;
      const code = classifyMessage(message);
      throw new RunnerError(message, {
        code,
        status: response.status,
        retryable: isRetryableCode(code),
      });
    }

    if (data.error) {
      const message = typeof data.error === 'string' ? data.error : data.error.message || 'Gateway command failed';
      const code = classifyMessage(message);
      throw new RunnerError(message, {
        code,
        retryable: isRetryableCode(code),
        details: typeof data.error === 'object' ? data.error : undefined,
      });
    }

    return data.result;
  } catch (error) {
    if (controller.signal.aborted) {
      throw normalizeError(controller.signal.reason || makeAbortError(`Command "${method}" aborted`));
    }

    if (error instanceof TypeError && String(error.message || '').includes('fetch')) {
      throw new RunnerError(`Unable to reach WebMCP gateway at ${gatewayUrl}: ${error.message}`, {
        code: 'GATEWAY_UNAVAILABLE',
        retryable: true,
        cause: error,
      });
    }

    throw normalizeError(error);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (options.signal) {
      options.signal.removeEventListener('abort', abortFromExternalSignal);
    }
  }
}

module.exports = {
  DEFAULT_GATEWAY_URL,
  getGatewayUrl,
  sendCommand,
};
