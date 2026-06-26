---
name: webmcp-browser-automation
description: >
  Automate browser interactions using WebMCP tools registered via navigator.modelContext.
  Use this skill when automating web browsing tasks such as form filling, data extraction,
  page navigation, clicking buttons, waiting for dynamic content, and scraping structured
  data from web pages. Trigger on: 'automate browser', 'scrape page', 'fill form',
  'click button', 'extract data', 'web automation', 'browser task', 'navigate to',
  'wait for element', 'submit form', 'scroll page'.
---

# WebMCP Browser Automation Skill

## Overview

This skill teaches you how to automate browser tasks using the **WebMCP Tools Provider** extension. The extension registers tools on every web page via `navigator.modelContext`, which the Codex AI agent can discover and invoke.

## Architecture

```
You (AI) ──▶ Codex Host App ──▶ Codex Extension ──▶ CDP Runtime.evaluate ──▶ Page JS Context
                                                                                │
                                                                    navigator.modelContext
                                                                    .invokeTool(name, input)
                                                                                │
                                                                    WebMCP Tools Provider
                                                                    (your custom tools)
```

When you call a WebMCP tool, the flow is:
1. You emit a tool call with `name` and `input`
2. Codex evaluates `navigator.modelContext.invokeTool(name, input)` in the page
3. The tool executes and returns a result in MCP format: `{ content: [{ type: "text", text: "..." }] }`
4. You receive the JSON result

## Available Tools

### Page Understanding

| Tool | Purpose | Key Inputs |
|------|---------|------------|
| `get_page_metadata` | Extract title, meta tags, OG data, headings, links | `include_headings`, `include_links` |
| `query_selector_all` | Find elements by CSS selector with attributes + bounding boxes | `selector`, `max_results`, `attributes` |
| `get_computed_styles` | Read CSS styles and layout info for an element | `selector`, `properties` |
| `extract_table_data` | Extract HTML table data as structured JSON | `selector`, `max_rows` |

### Page Interaction

| Tool | Purpose | Key Inputs |
|------|---------|------------|
| `click_element` | Click an element by CSS selector | `selector`, `scroll_into_view` |
| `fill_form_field` | Set an input/textarea/select value (React/Vue compatible) | `selector`, `value` |
| `submit_form` | Fill multiple fields and submit a form | `form_selector`, `fields`, `submit_button_selector` |
| `scroll_page` | Scroll to position, element, or by delta | `target`, `delta_y`, `behavior` |

### Waiting & Timing

| Tool | Purpose | Key Inputs |
|------|---------|------------|
| `wait_for_element` | Wait for a CSS selector to appear in the DOM | `selector`, `timeout_ms` |

### Escape Hatch

| Tool | Purpose | Key Inputs |
|------|---------|------------|
| `execute_javascript` | Run arbitrary JS in the page context | `code` |

## Automation Patterns

### Pattern 1: Navigate + Wait + Extract

Use this when you need to visit a page and extract data after it loads.

```
Step 1: Navigate to URL (use Codex's built-in navigation)
Step 2: wait_for_element → selector: "main content selector"
Step 3: get_page_metadata → include_headings: true
Step 4: extract_table_data (if page has tables)
   OR   query_selector_all → selector: ".data-items"
```

### Pattern 2: Form Automation

Use this when you need to fill out and submit a form.

```
Step 1: Navigate to form page
Step 2: wait_for_element → selector: "form"
Step 3: get_page_metadata → understand the page structure
Step 4: query_selector_all → selector: "form input, form select, form textarea"
        (discover all form fields, their names, types, and current values)
Step 5: fill_form_field → for each field
Step 6: submit_form → submit_button_selector: "button[type=submit]"
Step 7: wait_for_element → wait for success/result page
```

### Pattern 3: Multi-Page Scraping

Use this when you need to extract data across multiple pages.

```
Step 1: Navigate to listing page
Step 2: wait_for_element → selector: ".item-list"
Step 3: query_selector_all → selector: ".item-link" (get all links)
Step 4: For each link:
   4a: Navigate to item page
   4b: wait_for_element → selector: ".item-detail"
   4c: get_page_metadata + query_selector_all to extract details
Step 5: Compile results
```

### Pattern 4: Interactive UI Automation

Use this for complex UI flows (dropdowns, modals, dynamic content).

```
Step 1: click_element → trigger dropdown/modal
Step 2: wait_for_element → wait for dropdown/modal to appear
Step 3: query_selector_all → find options within dropdown
Step 4: click_element → select desired option
Step 5: wait_for_element → wait for UI to update
Step 6: Verify state with get_page_metadata or query_selector_all
```

### Pattern 5: Scroll + Load More

Use this for infinite scroll or "load more" pages.

```
Step 1: query_selector_all → get current items count
Step 2: scroll_page → target: "bottom"
Step 3: wait_for_element → wait for new content or loading indicator to disappear
Step 4: query_selector_all → check if new items loaded
Step 5: Repeat 2-4 until desired count reached
```

## Best Practices

### 1. Always Understand the Page First

Before interacting, call `get_page_metadata` and `query_selector_all` to understand:
- What elements exist on the page
- What CSS selectors to use
- Whether the page has loaded fully

### 2. Use Specific Selectors

Prefer specific selectors over generic ones:
- ✅ `button[data-testid="submit"]`
- ✅ `#login-form input[name="email"]`
- ✅ `.product-card:first-child .add-to-cart`
- ❌ `button` (too broad)
- ❌ `div > div > div > span` (too brittle)

### 3. Always Wait After Navigation

After any action that triggers navigation or dynamic content:
```
click_element → wait_for_element (for the expected result)
submit_form → wait_for_element (for success message or next page)
scroll_page → wait_for_element (for newly loaded content)
```

### 4. Handle Errors Gracefully

All tools return error objects when something goes wrong:
```json
{ "error": true, "message": "No element found for selector: ..." }
```

When you get an error:
1. Try a different selector (use `query_selector_all` to discover available elements)
2. Check if content has loaded (use `wait_for_element`)
3. Try scrolling the element into view first

### 5. Use `execute_javascript` as Last Resort

The `execute_javascript` tool can run any JS in the page. Use it when:
- No other tool fits the task
- You need to access page-specific APIs (e.g., `window.__NEXT_DATA__`)
- You need complex DOM manipulation
- You need to read cookies, localStorage, or sessionStorage

Example:
```json
{
  "code": "return JSON.parse(document.querySelector('#__NEXT_DATA__').textContent)"
}
```

### 6. Respect Rate Limits

- Add `wait_for_element` between rapid interactions
- Don't spam `click_element` without waiting for results
- Use `timeout_ms` parameter to set appropriate wait times

## Tool Input/Output Reference

### get_page_metadata

**Input:**
```json
{
  "include_headings": true,
  "include_links": true
}
```

**Output:**
```json
{
  "title": "Page Title",
  "url": "https://example.com",
  "canonical": "https://example.com",
  "description": "Meta description",
  "og": { "title": "...", "description": "...", "image": "..." },
  "lang": "en",
  "headings": [{ "level": 1, "text": "Main Title" }],
  "links": [{ "text": "Link Text", "href": "https://..." }]
}
```

### query_selector_all

**Input:**
```json
{
  "selector": "button.primary",
  "max_results": 10,
  "attributes": ["id", "class", "data-testid", "aria-label"]
}
```

**Output:**
```json
{
  "count": 3,
  "elements": [{
    "index": 0,
    "tag": "button",
    "text": "Submit",
    "attributes": { "id": "submit-btn", "class": "primary" },
    "visible": true,
    "bounds": { "x": 100, "y": 200, "width": 120, "height": 40 }
  }]
}
```

### click_element

**Input:**
```json
{ "selector": "#submit-btn", "scroll_into_view": true }
```

**Output:**
```json
{ "success": true, "tag": "button", "text": "Submit" }
```

### fill_form_field

**Input:**
```json
{ "selector": "input[name='email']", "value": "user@example.com" }
```

**Output:**
```json
{ "success": true, "tag": "input", "fieldName": "email" }
```

### submit_form

**Input:**
```json
{
  "form_selector": "#login-form",
  "fields": {
    "email": "user@example.com",
    "password": "secretpass"
  },
  "submit_button_selector": "button[type=submit]"
}
```

**Output:**
```json
{ "success": true, "action": "https://example.com/login", "method": "POST" }
```

### wait_for_element

**Input:**
```json
{ "selector": ".success-message", "timeout_ms": 5000 }
```

**Output (found):**
```json
{ "found": true, "elapsed_ms": 1200, "tag": "div", "text": "Login successful!" }
```

**Output (timeout):**
```json
{ "error": true, "message": "Timeout (5000ms) waiting for: .success-message" }
```

### scroll_page

**Input:**
```json
{ "target": "bottom" }
```
or
```json
{ "delta_y": 500 }
```
or
```json
{ "target": "#section-3" }
```

**Output:**
```json
{ "success": true, "scrollY": 1200, "pageHeight": 5000, "viewportHeight": 800 }
```

### extract_table_data

**Input:**
```json
{ "selector": "table.data-table", "max_rows": 50 }
```

**Output:**
```json
{
  "rowCount": 25,
  "headers": ["Name", "Price", "Stock"],
  "data": [
    { "Name": "Widget A", "Price": "$9.99", "Stock": "In Stock" }
  ]
}
```

### execute_javascript

**Input:**
```json
{ "code": "return document.title + ' - ' + location.href" }
```

**Output:**
```json
{ "success": true, "result": "Page Title - https://example.com" }
```
