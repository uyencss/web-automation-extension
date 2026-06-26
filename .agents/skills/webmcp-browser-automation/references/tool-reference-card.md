# WebMCP Tools — Quick Reference Card

## Page Understanding
```
get_page_metadata   { include_headings: bool, include_links: bool }
query_selector_all  { selector: str, max_results: num, attributes: [str] }
get_computed_styles { selector: str, properties: [str] }
extract_table_data  { selector: str, max_rows: num }
```

## Page Interaction
```
click_element       { selector: str, scroll_into_view: bool }
fill_form_field     { selector: str, value: str }
submit_form         { form_selector: str, fields: {name: value}, submit_button_selector: str }
scroll_page         { target: "top"|"bottom"|selector, delta_y: num, behavior: "smooth"|"instant" }
```

## Waiting
```
wait_for_element    { selector: str, timeout_ms: num }
```

## Escape Hatch
```
execute_javascript  { code: str }  →  Use `return` to send values back
```

## Common Selector Patterns
```css
/* By ID */            #login-btn
/* By class */         .product-card
/* By attribute */     [data-testid="submit"]
/* By name */          input[name="email"]
/* By type */          input[type="password"]
/* By text content */  button:has-text("Login")    /* Not standard CSS, use JS */
/* Nth child */        .item:nth-child(3)
/* First/Last */       .item:first-child  /  .item:last-child
/* Descendant */       #form .field input
/* Direct child */     ul > li
/* Sibling */          h2 + p
/* Contains text */    Use query_selector_all + filter by text in results
```

## Decision Tree: Which Tool to Use?

```
Need to understand the page?
  ├── Page title, meta, structure → get_page_metadata
  ├── Find specific elements     → query_selector_all
  ├── Check element styles       → get_computed_styles
  └── Extract a data table       → extract_table_data

Need to interact with the page?
  ├── Click a button/link        → click_element
  ├── Fill one form field        → fill_form_field
  ├── Fill + submit entire form  → submit_form
  └── Scroll the page            → scroll_page

Need to wait for something?
  └── Element to appear          → wait_for_element

None of the above work?
  └── Run custom JavaScript      → execute_javascript
```
