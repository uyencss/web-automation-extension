/**
 * WebMCP JSON Workflow Runner
 * 
 * A lightweight engine (~300 LOC) that interprets declarative JSON workflows
 * and executes them via WebMCP's sendCommand() HTTP API.
 * 
 * Features:
 * - Variable interpolation ({{VAR}} syntax)
 * - Sequential step execution
 * - Retry policy (per-step and workflow-level defaults)
 * - Critical / non-critical step handling
 * - Delay & wait support
 * - AI vision step support (strategy: "ai-vision")
 * - Detailed execution logging
 */

const GATEWAY_URL = 'http://localhost:7865/api';

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Sends a command to the WebMCP Gateway Server.
 */
async function sendCommand(method, params = {}) {
  const response = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Gateway returned HTTP ${response.status}`);
  }
  return data.result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Deep-interpolate all {{VAR}} placeholders in any value.
 */
function interpolate(value, variables) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return key in variables ? variables[key] : `{{${key}}}`;
    });
  }
  if (Array.isArray(value)) {
    return value.map(item => interpolate(item, variables));
  }
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolate(v, variables);
    }
    return result;
  }
  return value;
}

/**
 * Creates a formatted log prefix with timestamp and step info.
 */
function logPrefix(stepId) {
  const ts = new Date().toISOString().slice(11, 23);
  return stepId ? `[${ts}] [${stepId}]` : `[${ts}]`;
}

// ── AI Vision Step Handler ───────────────────────────────────────

/**
 * Executes an AI vision step:
 * 1. Calls getInteractiveElements to see the page
 * 2. Matches elements by instruction text (fuzzy matching)
 * 3. Clicks on the best matching element via dispatchClick
 * 
 * This is the "Phase 2" AI-assisted step — currently uses simple
 * text matching. Can be upgraded to LLM-based reasoning later.
 */
async function executeAiVisionStep(step, variables, tabId) {
  const instruction = interpolate(step.instruction, variables);
  console.log(`${logPrefix(step.id)} 🤖 AI Vision: "${instruction}"`);

  // Get all interactive elements on the page
  const params = tabId ? { tabId } : {};
  const result = await sendCommand('getInteractiveElements', params);
  const elements = result?.elements || [];

  if (elements.length === 0) {
    throw new Error('AI Vision: No interactive elements found on page');
  }

  console.log(`${logPrefix(step.id)}    Found ${elements.length} interactive elements`);

  // Extract keywords from instruction for matching
  const instructionLower = instruction.toLowerCase();
  const keywords = instructionLower
    .replace(/['"]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the', 'and', 'find', 'click', 'button', 'that', 'for', 'with', 'this'].includes(w));

  // Score each element by keyword match
  let bestMatch = null;
  let bestScore = 0;

  for (const el of elements) {
    const textLower = (el.text || '').toLowerCase();
    const placeholderLower = (el.placeholder || '').toLowerCase();
    const ariaLower = (el.ariaLabel || '').toLowerCase();
    const hrefLower = (el.href || '').toLowerCase();
    const combined = `${textLower} ${placeholderLower} ${ariaLower} ${hrefLower}`;

    let score = 0;
    for (const keyword of keywords) {
      if (combined.includes(keyword)) {
        score += 1;
      }
    }

    // Bonus for role/tag matching instruction
    if (instructionLower.includes('button') && (el.tag === 'button' || el.role === 'button')) score += 2;
    if (instructionLower.includes('input') && el.tag === 'input') score += 2;
    if (instructionLower.includes('link') && el.tag === 'a') score += 2;
    if (instructionLower.includes('textbox') && (el.tag === 'textarea' || el.type === 'text' || el.role === 'textbox')) score += 2;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = el;
    }
  }

  if (!bestMatch || bestScore === 0) {
    // If AI vision can't find it, try fallback
    if (step.fallback) {
      console.log(`${logPrefix(step.id)}    ⚡ No AI match — using fallback command`);
      const fallbackParams = interpolate(step.fallback.params || {}, variables);
      if (tabId) fallbackParams.tabId = tabId;
      return await sendCommand(step.fallback.command, fallbackParams);
    }
    throw new Error(`AI Vision: Could not find element matching "${instruction}"`);
  }

  console.log(`${logPrefix(step.id)}    ✅ Best match (score=${bestScore}): <${bestMatch.tag}> "${bestMatch.text || bestMatch.placeholder || ''}" at (${bestMatch.bounds?.centerX}, ${bestMatch.bounds?.centerY})`);

  // Click the element using CDP dispatch for anti-bot bypass
  const clickParams = {
    x: bestMatch.bounds.centerX,
    y: bestMatch.bounds.centerY,
  };
  if (tabId) clickParams.tabId = tabId;
  return await sendCommand('dispatchClick', clickParams);
}

// ── Step Executor ────────────────────────────────────────────────

/**
 * Executes a single workflow step with retry logic.
 */
async function executeStep(step, variables, context) {
  const resolvedStep = interpolate(step, variables);
  const retryPolicy = resolvedStep.retryPolicy || context.defaultRetryPolicy || { maxAttempts: 1, backoffMs: 1000 };
  const maxAttempts = retryPolicy.maxAttempts || 1;
  const backoffMs = retryPolicy.backoffMs || 1000;

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`${logPrefix(resolvedStep.id)} 🔄 Retry attempt ${attempt}/${maxAttempts}`);
      }

      let result;

      // Handle different step types
      if (resolvedStep.strategy === 'ai-vision') {
        // AI vision step — uses getInteractiveElements + fuzzy matching
        result = await executeAiVisionStep(resolvedStep, variables, context.tabId);

      } else if (resolvedStep.command === 'wait' || resolvedStep.command === 'delay') {
        // Pure delay step
        const ms = resolvedStep.params?.ms || resolvedStep.params?.timeout || 1000;
        console.log(`${logPrefix(resolvedStep.id)} ⏳ Waiting ${ms}ms...`);
        await sleep(ms);
        result = { waited: ms };

      } else if (resolvedStep.command) {
        // Standard WebMCP command step
        const params = { ...(resolvedStep.params || {}) };
        if (context.tabId && !params.tabId) {
          params.tabId = context.tabId;
        }
        console.log(`${logPrefix(resolvedStep.id)} ▶ ${resolvedStep.command}(${JSON.stringify(params).substring(0, 120)}...)`);
        result = await sendCommand(resolvedStep.command, params);

      } else {
        throw new Error(`Step "${resolvedStep.id}" has no command or strategy defined`);
      }

      // Post-step wait
      if (resolvedStep.wait) {
        if (resolvedStep.wait.type === 'delay') {
          console.log(`${logPrefix(resolvedStep.id)} ⏳ Post-step delay: ${resolvedStep.wait.ms}ms`);
          await sleep(resolvedStep.wait.ms);
        }
      }

      // Capture result
      if (resolvedStep.captureAs && result !== undefined) {
        variables[resolvedStep.captureAs] = typeof result === 'object' ? JSON.stringify(result) : String(result);
        console.log(`${logPrefix(resolvedStep.id)} 📦 Captured result as $${resolvedStep.captureAs}`);
      }

      // Track tabId from newTab/navigate results
      if (resolvedStep.command === 'newTab' && result?.tabId) {
        context.tabId = result.tabId;
        console.log(`${logPrefix(resolvedStep.id)} 📌 Tracking tab ID: ${context.tabId}`);
      }

      console.log(`${logPrefix(resolvedStep.id)} ✅ Success`);
      return { status: 'success', stepId: resolvedStep.id, result };

    } catch (error) {
      lastError = error;
      console.log(`${logPrefix(resolvedStep.id)} ❌ Error: ${error.message}`);

      if (attempt < maxAttempts) {
        const waitMs = backoffMs * attempt;
        console.log(`${logPrefix(resolvedStep.id)} ⏳ Waiting ${waitMs}ms before retry...`);
        await sleep(waitMs);
      }
    }
  }

  // All retries exhausted
  return { status: 'failed', stepId: resolvedStep.id, error: lastError.message };
}

// ── Workflow Runner ──────────────────────────────────────────────

/**
 * Runs a complete JSON workflow.
 * 
 * @param {object} workflow - Parsed JSON workflow definition
 * @param {object} [runtimeVars] - Optional runtime variable overrides
 * @returns {object} Execution result with status, steps completed, and any errors
 */
async function runWorkflow(workflow, runtimeVars = {}) {
  console.log('\n' + '═'.repeat(70));
  console.log(`  Workflow: ${workflow.name || workflow.id}`);
  console.log(`  Version: ${workflow.version || '1.0'}`);
  console.log(`  Steps: ${workflow.steps?.length || 0}`);
  console.log('═'.repeat(70) + '\n');

  // Merge variables: workflow defaults → runtime overrides
  const variables = {
    ...(workflow.variables || {}),
    ...runtimeVars,
    // Built-in variables
    __TIMESTAMP__: Date.now().toString(),
    __DATE__: new Date().toISOString().slice(0, 10),
    __WORKFLOW_ID__: workflow.id || 'unknown',
  };

  const context = {
    defaultRetryPolicy: workflow.settings?.defaultRetryPolicy || { maxAttempts: 1, backoffMs: 1000 },
    defaultTimeout: workflow.settings?.defaultTimeout || 15000,
    tabId: null,
  };

  const results = [];
  let failed = false;

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const isCritical = step.critical !== false; // Default: true

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Step ${i + 1}/${workflow.steps.length}: ${step.id}${isCritical ? '' : ' (non-critical)'}`);
    console.log('─'.repeat(50));

    const result = await executeStep(step, variables, context);
    results.push(result);

    if (result.status === 'failed') {
      if (isCritical) {
        console.log(`\n🛑 Critical step "${step.id}" failed — aborting workflow`);
        failed = true;
        break;
      } else {
        console.log(`\n⚠️  Non-critical step "${step.id}" failed — continuing`);
      }
    }
  }

  // Summary
  const completed = results.filter(r => r.status === 'success').length;
  const failures = results.filter(r => r.status === 'failed').length;
  const status = failed ? 'aborted' : (failures > 0 ? 'completed_with_errors' : 'completed');

  console.log('\n' + '═'.repeat(70));
  console.log(`  Result: ${status.toUpperCase()}`);
  console.log(`  Steps: ${completed} completed, ${failures} failed, ${results.length} total`);
  console.log('═'.repeat(70) + '\n');

  return {
    workflowId: workflow.id,
    status,
    stepsCompleted: completed,
    stepsFailed: failures,
    stepsTotal: workflow.steps.length,
    results,
  };
}

module.exports = { runWorkflow, sendCommand, interpolate };
