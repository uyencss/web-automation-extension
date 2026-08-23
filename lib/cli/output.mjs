export function printUnhandledError(error) {
  console.error(JSON.stringify({ error: error?.message || String(error) }, null, 2));
}
