async function sendRequest(method, params) {
  console.log(`>> SEND: ${method}`);
  const res = await fetch('http://localhost:7865/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

(async () => {
  try {
    console.log('1. Opening example.com...');
    const tabRes = await sendRequest('newTab', { url: 'https://example.com' });
    const tabId = tabRes.tabId;
    
    await new Promise(r => setTimeout(r, 2000));
    
    // --- 1. get_page_metadata ---
    console.log('\n--- 1. get_page_metadata ---');
    const meta = await sendRequest('evaluateJS', { tabId, code: `return await navigator.modelContext.invokeTool('get_page_metadata', { include_headings: true });` });
    console.log('Result:', JSON.stringify(meta.result).substring(0, 100) + '...');

    // --- 2. query_selector_all ---
    console.log('\n--- 2. query_selector_all ---');
    const query = await sendRequest('evaluateJS', { tabId, code: `return await navigator.modelContext.invokeTool('query_selector_all', { selector: 'h1' });` });
    console.log('Result:', JSON.stringify(query.result).substring(0, 100) + '...');

    // --- 3. get_computed_styles ---
    console.log('\n--- 3. get_computed_styles ---');
    const styles = await sendRequest('evaluateJS', { tabId, code: `return await navigator.modelContext.invokeTool('get_computed_styles', { selector: 'h1' });` });
    console.log('Result:', JSON.stringify(styles.result).substring(0, 100) + '...');

    // --- 4. wait_for_element ---
    console.log('\n--- 4. wait_for_element ---');
    const wait = await sendRequest('evaluateJS', { tabId, code: `return await navigator.modelContext.invokeTool('wait_for_element', { selector: 'p', timeout_ms: 1000 });` });
    console.log('Result:', JSON.stringify(wait.result).substring(0, 100) + '...');

    // --- 5. click_element ---
    console.log('\n--- 5. click_element ---');
    // Just clicking the H1
    const click = await sendRequest('evaluateJS', { tabId, code: `return await navigator.modelContext.invokeTool('click_element', { selector: 'h1' });` });
    console.log('Result:', JSON.stringify(click.result).substring(0, 100) + '...');

    // --- 6. scroll_page ---
    console.log('\n--- 6. scroll_page ---');
    const scroll = await sendRequest('evaluateJS', { tabId, code: `return await navigator.modelContext.invokeTool('scroll_page', { target: 'bottom' });` });
    console.log('Result:', JSON.stringify(scroll.result).substring(0, 100) + '...');

    // --- 7. execute_javascript ---
    console.log('\n--- 7. execute_javascript ---');
    const exec = await sendRequest('evaluateJS', { tabId, code: `return await navigator.modelContext.invokeTool('execute_javascript', { code: 'return 1 + 1;' });` });
    console.log('Result:', JSON.stringify(exec.result).substring(0, 100) + '...');

    // --- 8. start_network_capture ---
    console.log('\n--- 8. start_network_capture ---');
    const net = await sendRequest('evaluateJS', { tabId, code: `return await navigator.modelContext.invokeTool('start_network_capture', { url_pattern: '*' });` });
    console.log('Result:', JSON.stringify(net.result).substring(0, 100) + '...');

    // --- 9. stop_network_capture ---
    console.log('\n--- 9. stop_network_capture ---');
    const netStop = await sendRequest('evaluateJS', { tabId, code: `return await navigator.modelContext.invokeTool('stop_network_capture', {});` });
    console.log('Result:', JSON.stringify(netStop.result).substring(0, 100) + '...');

    console.log('\nTests completed successfully!');

  } catch (err) {
    console.error('Test failed:', err);
  }
})();
