// WebMCP Tools Provider Control Popup — Linear Dark-Tech UI

let currentTab = null;
let currentProfile = null;
let defaultGatewayUrl = 'ws://localhost:7865';

// Header & Status Elements
const elAppVersion = document.getElementById('appVersion');
const elBtnReconnect = document.getElementById('btnReconnect');
const elWsStatus = document.getElementById('wsStatus');

// Navigation Tabs
const elTabBtnControl = document.getElementById('tabBtnControl');
const elTabBtnGateway = document.getElementById('tabBtnGateway');
const elViewControl = document.getElementById('viewControl');
const elViewGateway = document.getElementById('viewGateway');

// Control View Elements
const elTabLabel = document.getElementById('tabLabel');
const elBtnCopyJson = document.getElementById('btnCopyJson');
const elTitleInput = document.getElementById('titleInput');
const elOrigTitleVal = document.getElementById('origTitleVal');
const elRenameNotice = document.getElementById('renameNotice');
const elBtnPrefixProfile = document.getElementById('btnPrefixProfile');
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

// Gateway View Elements
const elGatewayUrlInput = document.getElementById('gatewayUrlInput');
const elSettingsNotice = document.getElementById('settingsNotice');
const elBtnResetSettings = document.getElementById('btnResetSettings');
const elBtnSaveSettings = document.getElementById('btnSaveSettings');

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

function extractPortOrHost(rawUrl, fallback) {
  try {
    const u = new URL(rawUrl);
    if (u.port) return ':' + u.port;
    return u.hostname || fallback;
  } catch {
    return fallback;
  }
}

function updateWsBadge(wsState, gatewayUrl) {
  if (!elWsStatus) return;
  elWsStatus.textContent = '';
  const port = extractPortOrHost(gatewayUrl, ':7865');

  const dot = document.createElement('span');
  dot.className = 'dot';
  const label = document.createElement('span');

  if (wsState === 'open') {
    dot.classList.add('dot-green');
    label.textContent = `Gateway ${port} · Connected`;
  } else if (wsState === 'connecting') {
    dot.classList.add('dot-yellow');
    label.textContent = `Gateway ${port} · Connecting`;
  } else {
    dot.classList.add('dot-red');
    label.textContent = `Gateway ${port} · Offline`;
  }

  elWsStatus.append(dot, label);
}

function flashButtonText(btn, tempText, durationMs = 1200) {
  if (!btn) return;
  const orig = btn.dataset.origText || btn.textContent;
  btn.dataset.origText = orig;
  btn.textContent = tempText;
  setTimeout(() => {
    btn.textContent = orig;
  }, durationMs);
}

async function refreshStatus(autoFocus = false) {
  const res = await sendPopupMessage('status');
  if (!res.ok) {
    updateWsBadge('closed', defaultGatewayUrl);
    return;
  }

  if (res.defaultGatewayUrl) defaultGatewayUrl = res.defaultGatewayUrl;
  updateWsBadge(res.wsState, res.gatewayUrl || defaultGatewayUrl);

  if (elGatewayUrlInput && !elGatewayUrlInput.matches(':focus')) {
    elGatewayUrlInput.value = res.gatewayUrl || defaultGatewayUrl;
  }

  currentProfile = res.profile || null;
  currentTab = res.tab || null;

  if (currentProfile) {
    elProfileEmailVal.textContent = currentProfile.email || 'local';
    elProfileIdVal.textContent = `id: ${currentProfile.id || 'unknown'}`;
    if (elProfileNameInput && !elProfileNameInput.matches(':focus')) {
      elProfileNameInput.value = currentProfile.name || '';
    }
  }

  if (currentTab) {
    elTabLabel.textContent = `Tab #${currentTab.id}`;
    elTitleInput.disabled = false;
    elBtnSaveTitle.disabled = false;
    elBtnResetTitle.disabled = false;
    elBtnCopyJson.disabled = false;
    if (autoFocus || !elTitleInput.matches(':focus')) {
      elTitleInput.value = currentTab.customTitle || currentTab.title || '';
    }
    elCdpStatusVal.textContent = currentTab.cdpAttached ? 'Attached' : 'Idle';

    if (currentTab.customTitle && currentTab.pageTitle && currentTab.customTitle !== currentTab.pageTitle) {
      elOrigTitleVal.style.display = 'block';
      elOrigTitleVal.textContent = 'Original: ' + currentTab.pageTitle;
    } else {
      elOrigTitleVal.style.display = 'none';
    }

    if (elBtnPrefixProfile) {
      elBtnPrefixProfile.disabled = !currentProfile?.name;
      elBtnPrefixProfile.textContent = currentProfile?.name ? `+ [${currentProfile.name}]` : '+ [Profile]';
    }

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
    if (elBtnPrefixProfile) elBtnPrefixProfile.disabled = true;
    elBtnCopyJson.disabled = true;
    if (elOrigTitleVal) elOrigTitleVal.style.display = 'none';
    elCdpStatusVal.textContent = 'None';
  }

  elAttachedCountVal.textContent = res.attachedCount !== undefined ? String(res.attachedCount) : '0';
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

// ────────────────────────────────────────────────────────────
// Navigation Tabs
// ────────────────────────────────────────────────────────────
function switchActiveTab(tabName) {
  const isControl = tabName === 'control';
  if (elTabBtnControl) {
    elTabBtnControl.classList.toggle('active', isControl);
    elTabBtnControl.setAttribute('aria-selected', isControl ? 'true' : 'false');
  }
  if (elTabBtnGateway) {
    elTabBtnGateway.classList.toggle('active', !isControl);
    elTabBtnGateway.setAttribute('aria-selected', !isControl ? 'true' : 'false');
  }
  if (elViewControl) elViewControl.style.display = isControl ? 'block' : 'none';
  if (elViewGateway) elViewGateway.style.display = !isControl ? 'block' : 'none';
}

if (elTabBtnControl) elTabBtnControl.addEventListener('click', () => switchActiveTab('control'));
if (elTabBtnGateway) elTabBtnGateway.addEventListener('click', () => switchActiveTab('gateway'));

// ────────────────────────────────────────────────────────────
// Control View Listeners
// ────────────────────────────────────────────────────────────
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
    pageTitle: currentTab.pageTitle || currentTab.title || null,
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    flashButtonText(elBtnCopyJson, 'Copied!');
  } catch (err) {
    console.error('Clipboard error:', err);
  }
});

if (elBtnPrefixProfile) {
  elBtnPrefixProfile.addEventListener('click', () => {
    if (!currentTab || !currentProfile?.name) return;
    const prefix = `[${currentProfile.name}] `;
    const base = (elTitleInput.value || currentTab.pageTitle || currentTab.title || '').trim();
    const nextTitle = base.startsWith(prefix) ? base : `${prefix}${base}`;
    elTitleInput.value = nextTitle;
    handleSaveTitle(nextTitle);
  });
}

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

// ────────────────────────────────────────────────────────────
// Gateway View Listeners
// ────────────────────────────────────────────────────────────
if (elBtnSaveSettings) {
  elBtnSaveSettings.addEventListener('click', async () => {
    elSettingsNotice.style.display = 'none';
    const gatewayUrl = elGatewayUrlInput.value.trim();

    const res = await sendPopupMessage('saveSettings', { gatewayUrl });
    elSettingsNotice.style.display = 'block';

    if (!res.ok) {
      elSettingsNotice.style.color = '#f43f5e';
      elSettingsNotice.textContent = `Lỗi: ${res.error || 'Không thể lưu cài đặt'}`;
      return;
    }

    elSettingsNotice.style.color = '#10b981';
    elSettingsNotice.textContent = 'Đã lưu và kết nối lại Gateway.';
    await refreshStatus(false);
    setTimeout(() => {
      if (elSettingsNotice.style.color === 'rgb(16, 185, 129)') {
        elSettingsNotice.style.display = 'none';
      }
    }, 2500);
  });
}

if (elBtnResetSettings) {
  elBtnResetSettings.addEventListener('click', async () => {
    elGatewayUrlInput.value = defaultGatewayUrl;
    elSettingsNotice.style.display = 'none';

    const res = await sendPopupMessage('saveSettings', {
      gatewayUrl: defaultGatewayUrl,
    });

    elSettingsNotice.style.display = 'block';
    if (!res.ok) {
      elSettingsNotice.style.color = '#f43f5e';
      elSettingsNotice.textContent = `Lỗi: ${res.error || 'Không thể đặt lại mặc định'}`;
      return;
    }

    elSettingsNotice.style.color = '#10b981';
    elSettingsNotice.textContent = 'Đã khôi phục Gateway mặc định.';
    await refreshStatus(false);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  refreshStatus(true);
});
