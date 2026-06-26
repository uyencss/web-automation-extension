function createEventFactory({ runId, workflowId, getTabId }) {
  let eventCounter = 0;

  return function makeEvent(type, payload = {}) {
    eventCounter += 1;

    return {
      version: 1,
      eventId: `${runId}:${eventCounter}`,
      runId,
      workflowId,
      tabId: getTabId ? getTabId() : undefined,
      timestamp: new Date().toISOString(),
      type,
      payload,
    };
  };
}

module.exports = {
  createEventFactory,
};
