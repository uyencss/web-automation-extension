const GATEWAY_URL = 'http://localhost:7865/api';

/**
 * Sends a command to the WebMCP Gateway Server via HTTP POST.
 * @param {string} method - JSON-RPC method name (e.g. 'evaluateJS', 'newTab')
 * @param {object} [params] - Optional parameters for the method
 * @returns {Promise<any>} Response result from the Chrome Extension
 */
async function sendCommand(method, params = {}) {
  try {
    const response = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ method, params }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Gateway returned HTTP ${response.status}`);
    }

    return data.result;
  } catch (error) {
    console.error(`  ✗ [Client Error] Failed to execute '${method}':`, error.message);
    throw error;
  }
}

module.exports = { sendCommand };
