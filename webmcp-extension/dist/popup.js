// WebMCP Extension Control Popup

let currentTab = null;
let currentProfile = null;

const elWsStatus = document.getElementById('wsStatus');
const elBtnReconnect = document.getElementById('btnReconnect');
const elTabLabel = document.getElementById('tabLabel');
const elBtnCopyJson = document.getElementById('btnCopyJson');
const elTitleInput = document.getElementById('titleInput');
const elRenameNotice = document.getElementById('renameNotice');
const elBtnResetTitle = document.getElementById('btnResetTitle');
const elBtnSaveTitle = document.getElementById('btnSaveTitle');
const elProfileEmailVal = document.getElementById('profileEmailVal');
const elProfileIdVal = document.getElementById('profileIdVal');
const elProfileNameInput = document.getElementById('profileNameInput');
const elBtnSaveProfile = document.getElementById('btnSaveProfile');
const elCdpStatusVal = document.getElementById('cdpStatusVal');
const elAttachedCountVal = document.getElementById('attachedCountVal');
const elBtnDetachTab = document.getElementById('btnDetachTab');
const elBtnDetachAll = document.getElementById('btnDetachAll');
const elAppVersion = document.getElementById('appVersion');
if (elAppVersion && chrome.runtime?.getManifest) {
  elAppVersion.textContent = 'v' + chrome.runtime.getManifest().version;
}

async function sendPopupMessage(method, params = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'WEBMCP_POPUP', method, params }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false, error: 'No response' });
      }
    });
  });
}

function updateWsBadge(wsState) {
  elWsStatus.className = 'status-badge';
  if (wsState === 'open') {
    elWsStatus.classList.add('status-open');
    elWsStatus.textContent = '🟢 Connected';
  } else if (wsState === 'connecting') {
    elWsStatus.classList.add('status-connecting');
    elWsStatus.textContent = '🟡 Connecting';
  } else {
    elWsStatus.classList.add('status-closed');
    elWsStatus.textContent = '🔴 Disconnected';
  }
}

async function refreshStatus(autoFocus = false) {
  const res = await sendPopupMessage('status');
  if (!res.ok) {
    updateWsBadge('closed');
    return;
  }

  updateWsBadge(res.wsState);

  currentProfile = res.profile || null;
  currentTab = res.tab || null;

  if (currentProfile) {
    elProfileEmailVal.textContent = currentProfile.email || 'local';
    elProfileIdVal.textContent = `id: ${currentProfile.id || 'unknown'}`;
    elProfileNameInput.value = currentProfile.name || '';
  }

  if (currentTab) {
    elTabLabel.textContent = `Tab #${currentTab.id}`;
    elTitleInput.value = currentTab.customTitle || currentTab.title || '';
    elCdpStatusVal.textContent = currentTab.cdpAttached ? 'Attached' : 'Idle';
    if (autoFocus) {
      elTitleInput.focus();
      elTitleInput.select();
    }
  } else {
    elTabLabel.textContent = 'No Active Tab';
    elTitleInput.value = '';
    elTitleInput.disabled = true;
    elBtnSaveTitle.disabled = true;
    elBtnResetTitle.disabled = true;
    elBtnCopyJson.disabled = true;
    elCdpStatusVal.textContent = 'None';
  }

  elAttachedCountVal.textContent = res.attachedCount !== undefined ? res.attachedCount : '0';
}

async function handleSaveTitle(titleToSave) {
  if (!currentTab?.id) return;
  elRenameNotice.style.display = 'none';

  const res = await sendPopupMessage('renameTab', {
    tabId: currentTab.id,
    title: titleToSave,
  });

  if (!res.ok) {
    elRenameNotice.style.display = 'block';
    elRenameNotice.textContent = `Lỗi: ${res.error || 'Không thể lưu tên tab'}`;
    return;
  }

  if (res.result?.applied === false) {
    elRenameNotice.style.display = 'block';
    elRenameNotice.textContent = 'Đã lưu! Hãy F5 (Reload) tab để áp dụng.';
  } else {
    window.close();
  }
}

// Event Listeners
elBtnReconnect.addEventListener('click', async () => {
  await sendPopupMessage('reconnect');
  setTimeout(() => refreshStatus(false), 300);
});

elBtnCopyJson.addEventListener('click', async () => {
  if (!currentTab) return;
  const payload = {
    profileId: currentProfile?.id || null,
    profileName: currentProfile?.name || null,
    tabId: currentTab.id,
    url: currentTab.url,
    title: currentTab.title,
    customTitle: currentTab.customTitle || null,
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    const orig = elBtnCopyJson.textContent;
    elBtnCopyJson.textContent = '✓ Copied!';
    setTimeout(() => {
      elBtnCopyJson.textContent = orig;
    }, 1500);
  } catch (err) {
    console.error('Clipboard error:', err);
  }
});

elBtnSaveTitle.addEventListener('click', () => {
  handleSaveTitle(elTitleInput.value);
});

elTitleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleSaveTitle(elTitleInput.value);
  }
});

elBtnResetTitle.addEventListener('click', () => {
  handleSaveTitle('');
});

elBtnSaveProfile.addEventListener('click', async () => {
  const name = elProfileNameInput.value;
  await sendPopupMessage('setProfileName', { name });
  await refreshStatus(false);
});

elBtnDetachTab.addEventListener('click', async () => {
  if (!currentTab?.id) return;
  await sendPopupMessage('detach', { tabId: currentTab.id });
  await refreshStatus(false);
});

elBtnDetachAll.addEventListener('click', async () => {
  await sendPopupMessage('detach', { all: true });
  await refreshStatus(false);
});

document.addEventListener('DOMContentLoaded', () => {
  refreshStatus(true);
});
