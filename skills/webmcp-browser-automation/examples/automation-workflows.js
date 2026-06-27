// ============================================================
// WebMCP Browser Automation Workflow Examples
//
// These examples use the real gateway/extension call shape:
//   { method: "extension.command", params: {...} }
//
// Page-registered tools from navigator.modelContext are invoked through:
//   { method: "webmcp.invokeTool", params: { toolName, input, tabId? } }
// ============================================================

const command = (method, params = {}) => ({ method, params });

const pageTool = (toolName, input = {}, tabId) => ({
  method: 'webmcp.invokeTool',
  params: {
    ...(tabId ? { tabId } : {}),
    toolName,
    input,
  },
});

const listPageTools = (tabId) => command('webmcp.listTools', tabId ? { tabId } : {});

// Helper for agent runtimes that receive the HTTP gateway response.
function parseWebMcpPayload(gatewayResponse) {
  const text = gatewayResponse?.result?.result?.content?.[0]?.text;
  if (typeof text !== 'string') return gatewayResponse;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Task: "Search Google for 'WebMCP specification' and give me the top 5 results"
const googleSearchWorkflow = [
  command('newTab', { url: 'https://www.google.com' }),
  listPageTools(),
  pageTool('wait_for_element', {
    selector: 'textarea[name="q"], input[name="q"]',
    timeout_ms: 10000,
  }),
  pageTool('fill_form_field', {
    selector: 'textarea[name="q"], input[name="q"]',
    value: 'WebMCP specification',
  }),
  command('pressKey', { key: 'Enter' }),
  pageTool('wait_for_element', { selector: '#search', timeout_ms: 10000 }),
  pageTool('query_selector_all', {
    selector: '#search a, #search h3',
    max_results: 20,
    attributes: ['href', 'aria-label', 'data-ved'],
  }),
];

// Task: "Log into my account on example.com"
const loginWorkflow = [
  command('newTab', { url: 'https://example.com/login' }),
  listPageTools(),
  pageTool('wait_for_element', { selector: 'form', timeout_ms: 10000 }),
  pageTool('query_selector_all', {
    selector: 'form input, form select, form textarea, form button',
    attributes: ['id', 'name', 'type', 'placeholder', 'autocomplete', 'aria-label'],
  }),
  pageTool('fill_form_field', {
    selector: 'input[name="email"], input[type="email"]',
    value: 'user@example.com',
  }),
  pageTool('fill_form_field', {
    selector: 'input[name="password"], input[type="password"]',
    value: 'my-password',
  }),
  pageTool('click_element', {
    selector: 'button[type="submit"], input[type="submit"]',
  }),
  pageTool('wait_for_element', {
    selector: '.dashboard, .welcome, [data-page="home"], main',
    timeout_ms: 10000,
  }),
  pageTool('get_page_metadata', { include_headings: true }),
];

// Task: "Extract all product names and prices"
const productScrapingWorkflow = [
  command('newTab', { url: 'https://shop.example.com/products' }),
  listPageTools(),
  pageTool('wait_for_element', {
    selector: '.product-card, .product-item, [data-product-id]',
    timeout_ms: 10000,
  }),
  pageTool('query_selector_all', {
    selector: '.product-card, .product-item, [data-product-id]',
    max_results: 100,
    attributes: ['data-product-id', 'data-price', 'href', 'aria-label'],
  }),
  pageTool('query_selector_all', {
    selector: '.pagination a, button.load-more, [data-page]',
    max_results: 20,
    attributes: ['href', 'data-page', 'aria-label'],
  }),
  pageTool('scroll_page', { target: 'bottom', behavior: 'instant' }),
  pageTool('query_selector_all', {
    selector: '.product-card, .product-item, [data-product-id]',
    max_results: 200,
    attributes: ['data-product-id', 'data-price', 'href', 'aria-label'],
  }),
];

// Task: "Fill out a multi-step application form"
const multiStepFormWorkflow = [
  command('newTab', { url: 'https://careers.example.com/apply' }),
  listPageTools(),
  pageTool('get_page_metadata', { include_headings: true }),
  pageTool('query_selector_all', {
    selector: 'form input, form select, form textarea, form button',
    attributes: ['id', 'name', 'type', 'placeholder', 'required', 'aria-label'],
  }),
  pageTool('fill_form_field', { selector: '[name="first_name"]', value: 'John' }),
  pageTool('fill_form_field', { selector: '[name="last_name"]', value: 'Doe' }),
  pageTool('fill_form_field', { selector: 'input[type="email"], [name="email"]', value: 'john.doe@email.com' }),
  pageTool('fill_form_field', { selector: 'select[name="position"]', value: 'senior-engineer' }),
  pageTool('query_selector_all', {
    selector: 'button, input[type="button"], input[type="submit"]',
    attributes: ['id', 'class', 'type', 'aria-label'],
  }),
  pageTool('execute_javascript', {
    code: `
      const buttons = [...document.querySelectorAll('button, input[type="button"], input[type="submit"]')];
      const next = buttons.find((el) => /next|continue/i.test(el.textContent || el.value || el.getAttribute('aria-label') || ''));
      if (!next) return { error: true, message: 'Next/Continue button not found' };
      next.click();
      return { success: true, text: next.textContent || next.value || next.getAttribute('aria-label') };
    `,
  }),
  pageTool('wait_for_element', {
    selector: '.step-2, [data-step="2"], form',
    timeout_ms: 10000,
  }),
];

// Task: "Check if a product is back in stock"
const stockMonitoringWorkflow = [
  command('newTab', { url: 'https://shop.example.com/product/widget-pro' }),
  listPageTools(),
  pageTool('wait_for_element', { selector: 'main, .product-detail, [data-product-id]' }),
  pageTool('query_selector_all', {
    selector: '.stock-status, .availability, [data-availability], [data-in-stock]',
    attributes: ['class', 'data-availability', 'data-in-stock', 'aria-label'],
  }),
  pageTool('query_selector_all', {
    selector: '.price, .product-price, [data-price], [itemprop="price"]',
    attributes: ['data-price', 'content', 'itemprop'],
  }),
  pageTool('execute_javascript', {
    code: `
      const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
      return scripts.map((script) => JSON.parse(script.textContent));
    `,
  }),
];

// Task: "Capture the API response after clicking a search/filter button"
const networkCaptureWorkflow = [
  command('newTab', { url: 'https://app.example.com/search' }),
  listPageTools(),
  pageTool('start_network_capture', { url_pattern: '/api/search' }),
  pageTool('click_element', { selector: 'button[type="submit"], button.search' }),
  pageTool('wait_for_network_response', {
    url_pattern: '/api/search',
    timeout_ms: 15000,
  }),
  pageTool('stop_network_capture'),
];

module.exports = {
  command,
  pageTool,
  listPageTools,
  parseWebMcpPayload,
  googleSearchWorkflow,
  loginWorkflow,
  productScrapingWorkflow,
  multiStepFormWorkflow,
  stockMonitoringWorkflow,
  networkCaptureWorkflow,
};
