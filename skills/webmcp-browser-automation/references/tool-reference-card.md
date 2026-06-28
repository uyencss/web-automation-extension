# WebMCP Browser Automation - Quick Reference

## Golden Rule

Page tools from `navigator.modelContext` are not top-level extension commands.
Always call them through:

```json
{
  "method": "webmcp.invokeTool",
  "params": {
    "tabId": 123,
    "toolName": "query_selector_all",
    "input": { "selector": "button" }
  }
}
```

Before invoking a page tool, discover the available descriptors:

```json
{ "method": "webmcp.listTools", "params": { "tabId": 123 } }
```

## HTTP Gateway Call Shape

```bash
curl -sS http://localhost:7865/api \
  -H 'Content-Type: application/json' \
  -d '{"method":"getActiveTab","params":{}}'
```

## Parse WebMCP Results

Gateway result:

```text
response.result.result.content[0].text
```

Parse that text as JSON when it looks like JSON. Check for:

```json
{ "error": true, "message": "..." }
```

## Background Extension Commands

```text
ping                    {}
getExtensionInfo        {}
getActiveTab            {}
listTabs                {}
newTab                  { url? }
navigate                { url, tabId? }
closeTab                { tabId? }

listFrames              { flat?, force?, tabId? }
waitForSelector         { selector, timeout?, frame?, tabId? }
getPageContent          { format?, maxLength?, offset?, frame?, tabId? }
click                   { selector, frame?, tabId? }
type                    { selector, text, frame?, tabId? }
evaluateJS              { code, frame?, tabId? }

executeCDP              { method, params?, tabId? }
screenshot              { fullPage?, tabId? }

webmcp.listTools        { frame?, tabId? }
webmcp.invokeTool       { toolName, input?, frame?, tabId? }

getAccessibilityTree    { interestingOnly?, depth?, tabId? }
getDOMSnapshot          { computedStyles?, tabId? }
getElementBounds        { selector, pierceShadow?, frame?, tabId? }
getInteractiveElements  { pierceShadow?, frame?, tabId? }

## ARIA Snapshot (preferred for interaction)
getAriaSnapshot         { maxDepth?, tabId? }
clickByRef              { ref, element?, tabId? }
typeByRef               { ref, text, submit?, tabId? }
hoverByRef              { ref, tabId? }
selectByRef             { ref, values, tabId? }

## Page Stability
waitForStable           { minStableMs?, maxWaitMs?, maxMutations?, tabId? }

## CDP Input
dispatchClick           { x, y, button?, clickCount?, frame?, tabId? }
moveMouse               { x, y, steps?, fromX?, fromY?, frame?, tabId? }
pressKey                { key, text?, modifiers?, tabId? }
typeText                { text, tabId? }
scroll                  { deltaX?, deltaY?, x?, y?, tabId? }
hover                   { selector, frame?, tabId? }
selectOption            { selector, value?, index?, text?, frame?, tabId? }

## Storage & Browser
getCookies              { tabId? }
setCookie               { name, value, domain?, path?, tabId? }
deleteCookies           { name, domain?, url?, tabId? }
getLocalStorage         { tabId? }
setLocalStorage         { key, value, tabId? }
listWindows             {}
createWindow            { url?, width?, height?, type? }
setViewport             { width, height, deviceScaleFactor?, mobile?, tabId? }
resetViewport           { tabId? }
```

## Page-Registered WebMCP Tools

Call these with `webmcp.invokeTool`.

```text
get_page_metadata        { include_headings?, include_links? }
query_selector_all       { selector, frame_selector?, frame_path?, frame_timeout_ms?, max_results?, attributes? }
click_element            { selector, frame_selector?, frame_path?, frame_timeout_ms?, scroll_into_view? }
fill_form_field          { selector, value, frame_selector?, frame_path?, frame_timeout_ms? }
extract_table_data       { selector?, frame_selector?, frame_path?, frame_timeout_ms?, max_rows? }
wait_for_element         { selector, frame_selector?, frame_path?, frame_timeout_ms?, timeout_ms? }
get_computed_styles      { selector, frame_selector?, frame_path?, frame_timeout_ms?, properties? }
scroll_page              { target?, delta_y?, container_selector?, behavior? }
submit_form              { form_selector?, fields?, submit_button_selector? }
execute_javascript       { code }
start_network_capture    { url_pattern }
wait_for_network_response { url_pattern, timeout_ms? }
stop_network_capture     {}
```

## Decision Tree

```text
Need a tab/page?
  -> newTab, navigate, getActiveTab, listTabs

Need to understand page structure? (PREFERRED)
  -> getAriaSnapshot (returns semantic tree with ref IDs)

Need to click/type on SPA or dynamic page? (PREFERRED)
  -> getAriaSnapshot -> clickByRef / typeByRef / selectByRef

Need to know what is clickable or typeable?
  -> getAriaSnapshot (preferred) or getInteractiveElements

Need robust real input (anti-bot)?
  -> dispatchClick, typeText, pressKey, scroll

Need to wait for page to settle?
  -> waitForStable (auto-applied after click/type/clickByRef/typeByRef)

Need DOM extraction?
  -> webmcp.invokeTool(query_selector_all)

Need metadata/headings/links?
  -> webmcp.invokeTool(get_page_metadata)

Need form fill (SPA)?
  -> getAriaSnapshot
  -> typeByRef for text fields
  -> selectByRef for dropdowns
  -> clickByRef on submit button

Need form fill (simple page)?
  -> webmcp.invokeTool(query_selector_all)
  -> webmcp.invokeTool(fill_form_field)
  -> webmcp.invokeTool(click_element or submit_form)

Need table data?
  -> webmcp.invokeTool(extract_table_data)

Need network response body?
  -> webmcp.invokeTool(start_network_capture)
  -> trigger action
  -> webmcp.invokeTool(wait_for_network_response)
  -> webmcp.invokeTool(stop_network_capture)

Need arbitrary page JS?
  -> evaluateJS, or webmcp.invokeTool(execute_javascript)
```

## Selector Notes

Use standard CSS selectors only.

```css
#login-btn
.product-card
[data-testid="submit"]
input[name="email"]
input[type="password"]
ul > li
h2 + p
.item:nth-child(3)
.item:first-child
```

Do not use Playwright-only selectors such as `button:has-text("Login")`.
To target text, query broadly and inspect returned `text`, or use
`execute_javascript`.

## Generated Reference

For the source-derived command and page-tool list, use
`references/generated-tools.md`. Regenerate it from runtime source with:

```bash
npm run tools:generate
```
