// ============================================================
// Example Automation Workflows
//
// These examples show how an AI model would chain WebMCP tool
// calls to accomplish real-world browser automation tasks.
// ============================================================

// ─── Example 1: Google Search & Extract Results ─────────────
// Task: "Search Google for 'WebMCP specification' and give me the top 5 results"
const googleSearchWorkflow = [
  // Step 1: Navigate to Google (Codex built-in)
  { action: 'navigate', url: 'https://www.google.com' },

  // Step 2: Wait for search box
  { tool: 'wait_for_element', input: { selector: 'textarea[name="q"], input[name="q"]' } },

  // Step 3: Fill search query
  { tool: 'fill_form_field', input: { selector: 'textarea[name="q"], input[name="q"]', value: 'WebMCP specification' } },

  // Step 4: Submit the form
  { tool: 'submit_form', input: { form_selector: 'form[role="search"]' } },

  // Step 5: Wait for results
  { tool: 'wait_for_element', input: { selector: '#search', timeout_ms: 5000 } },

  // Step 6: Extract search results
  { tool: 'query_selector_all', input: { selector: '#search .g', max_results: 5, attributes: ['href'] } },
];

// ─── Example 2: Login to a Web App ──────────────────────────
// Task: "Log into my account on example.com"
const loginWorkflow = [
  // Step 1: Navigate to login page
  { action: 'navigate', url: 'https://example.com/login' },

  // Step 2: Wait for login form
  { tool: 'wait_for_element', input: { selector: 'form' } },

  // Step 3: Discover form fields
  { tool: 'query_selector_all', input: { selector: 'form input, form button', attributes: ['name', 'type', 'placeholder', 'id'] } },

  // Step 4: Fill email
  { tool: 'fill_form_field', input: { selector: 'input[name="email"], input[type="email"]', value: 'user@example.com' } },

  // Step 5: Fill password
  { tool: 'fill_form_field', input: { selector: 'input[name="password"], input[type="password"]', value: 'my-password' } },

  // Step 6: Click login button
  { tool: 'click_element', input: { selector: 'button[type="submit"], input[type="submit"]' } },

  // Step 7: Wait for redirect/dashboard
  { tool: 'wait_for_element', input: { selector: '.dashboard, .welcome, [data-page="home"]', timeout_ms: 10000 } },

  // Step 8: Confirm login success
  { tool: 'get_page_metadata', input: {} },
];

// ─── Example 3: E-commerce Product Scraping ─────────────────
// Task: "Go to an e-commerce site and extract all product names and prices"
const scrapingWorkflow = [
  // Step 1: Navigate
  { action: 'navigate', url: 'https://shop.example.com/products' },

  // Step 2: Wait for product grid
  { tool: 'wait_for_element', input: { selector: '.product-card, .product-item' } },

  // Step 3: Extract all products
  { tool: 'query_selector_all', input: {
    selector: '.product-card, .product-item',
    max_results: 50,
    attributes: ['data-product-id', 'data-price']
  }},

  // Step 4: If there's a table, extract it
  { tool: 'extract_table_data', input: { max_rows: 100 } },

  // Step 5: Check for pagination / load more
  { tool: 'query_selector_all', input: { selector: '.pagination a, button.load-more, [data-page]' } },

  // Step 6: If load-more exists, click it
  { tool: 'click_element', input: { selector: 'button.load-more, .pagination .next' } },

  // Step 7: Wait for new content
  { tool: 'wait_for_element', input: { selector: '.product-card:nth-child(21)', timeout_ms: 5000 } },

  // Step 8: Extract again
  { tool: 'query_selector_all', input: { selector: '.product-card', max_results: 100 } },
];

// ─── Example 4: Fill a Complex Multi-Step Form ──────────────
// Task: "Fill out a job application form"
const multiStepFormWorkflow = [
  // Step 1: Navigate
  { action: 'navigate', url: 'https://careers.example.com/apply' },

  // Step 2: Understand the form
  { tool: 'get_page_metadata', input: { include_headings: true } },
  { tool: 'query_selector_all', input: { selector: 'form input, form select, form textarea', attributes: ['name', 'type', 'placeholder', 'required', 'id'] } },

  // Step 3: Fill personal info
  { tool: 'submit_form', input: {
    form_selector: 'form',
    fields: {
      'first_name': 'John',
      'last_name': 'Doe',
      'email': 'john.doe@email.com',
      'phone': '+1-555-0123',
    }
  }},

  // Step 4: Handle a dropdown
  { tool: 'click_element', input: { selector: 'select[name="position"]' } },
  { tool: 'fill_form_field', input: { selector: 'select[name="position"]', value: 'senior-engineer' } },

  // Step 5: Upload resume (use execute_javascript for complex interaction)
  { tool: 'execute_javascript', input: {
    code: `
      const fileInput = document.querySelector('input[type="file"]');
      if (fileInput) {
        return { found: true, accept: fileInput.accept, name: fileInput.name };
      }
      return { found: false };
    `
  }},

  // Step 6: Click "Next" to go to step 2
  { tool: 'click_element', input: { selector: 'button.next, button:has-text("Next")' } },

  // Step 7: Wait for step 2 to load
  { tool: 'wait_for_element', input: { selector: '.step-2, [data-step="2"]', timeout_ms: 5000 } },
];

// ─── Example 5: Monitor a Page for Changes ──────────────────
// Task: "Check if a product is back in stock"
const monitoringWorkflow = [
  // Step 1: Navigate to product page
  { action: 'navigate', url: 'https://shop.example.com/product/widget-pro' },

  // Step 2: Wait for page load
  { tool: 'wait_for_element', input: { selector: '.product-detail' } },

  // Step 3: Check stock status
  { tool: 'query_selector_all', input: {
    selector: '.stock-status, .availability, [data-availability]',
    attributes: ['class', 'data-availability', 'data-in-stock']
  }},

  // Step 4: Read the price
  { tool: 'query_selector_all', input: {
    selector: '.price, .product-price, [data-price]',
    attributes: ['data-price', 'content']
  }},

  // Step 5: Get structured data from page (JSON-LD)
  { tool: 'execute_javascript', input: {
    code: `
      const ld = document.querySelector('script[type="application/ld+json"]');
      if (ld) return JSON.parse(ld.textContent);
      return null;
    `
  }},
];

// ─── Example 6: Extract Data from SPA (React/Vue/Angular) ──
// Task: "Extract all items from a React dashboard"
const spaExtractionWorkflow = [
  // Step 1: Navigate
  { action: 'navigate', url: 'https://app.example.com/dashboard' },

  // Step 2: Wait for React to hydrate
  { tool: 'wait_for_element', input: { selector: '[data-testid="dashboard"], #root > div', timeout_ms: 10000 } },

  // Step 3: Try to access React's internal state (escape hatch)
  { tool: 'execute_javascript', input: {
    code: `
      // Try __NEXT_DATA__ for Next.js apps
      if (window.__NEXT_DATA__) {
        return { framework: 'nextjs', props: window.__NEXT_DATA__.props?.pageProps };
      }
      // Try __NUXT__ for Nuxt apps
      if (window.__NUXT__) {
        return { framework: 'nuxt', data: window.__NUXT__.data };
      }
      // Fallback: read from DOM
      return { framework: 'unknown' };
    `
  }},

  // Step 4: If no internal state, extract from DOM
  { tool: 'query_selector_all', input: {
    selector: '[data-testid], [data-cy], .card, .list-item, tr',
    max_results: 100,
    attributes: ['data-testid', 'data-cy', 'data-id', 'role']
  }},
];

module.exports = {
  googleSearchWorkflow,
  loginWorkflow,
  scrapingWorkflow,
  multiStepFormWorkflow,
  monitoringWorkflow,
  spaExtractionWorkflow,
};
