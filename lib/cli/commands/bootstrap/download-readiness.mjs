import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../../context.mjs';

function shippedDownloadPolicyReadiness() {
  const installationRoot = resolve(ROOT, '..', '..', 'installation');
  const checks = [
    {
      platform: 'macos',
      file: resolve(installationRoot, 'extension', 'macos', 'WebMCP-ForceInstall.mobileconfig'),
      validate: (text) => (
        text.includes('PromptForDownloadLocation')
        && text.includes('DownloadDirectory')
        && !/PromptForDownload(?!Location)/.test(text)
        && text.includes('/Users/Shared/WebMCP/Downloads')
      ),
    },
    {
      platform: 'linux',
      file: resolve(installationRoot, 'extension', 'ubuntu', 'install.sh'),
      validate: (text) => (
        text.includes('"PromptForDownloadLocation": false')
        && text.includes('"DownloadDirectory": "${DOWNLOAD_DIR}"')
        && text.includes('/var/lib/webmcp/downloads')
      ),
    },
    {
      platform: 'windows',
      file: resolve(installationRoot, 'extension', 'windows', 'install.ps1'),
      validate: (text) => (
        text.includes('PromptForDownloadLocation')
        && text.includes('DownloadDirectory')
        && text.includes('C:\\WebMCP\\Downloads')
      ),
    },
  ];
  const platforms = checks.map((check) => {
    if (!existsSync(check.file)) {
      return { platform: check.platform, ok: false, configured: false, error: 'installer artifact missing' };
    }
    const text = readFileSync(check.file, 'utf8');
    return { platform: check.platform, ok: check.validate(text), configured: true };
  });
  return {
    schema: 'webmcp-download-policy-artifacts-readiness/1',
    ok: platforms.every((entry) => entry.ok),
    policy: {
      promptForDownloadLocation: false,
      managedDownloadDirectory: true,
    },
    platforms,
  };
}

function platformDownloadPolicyExpectation() {
  const testDownloadDirectory = process.env.WEBMCP_TEST_DOWNLOAD_POLICY_DIRECTORY || null;
  if (process.platform === 'darwin') {
    return {
      platform: 'macos',
      directory: testDownloadDirectory || '/Users/Shared/WebMCP/Downloads',
      source: 'configuration-profile',
    };
  }
  if (process.platform === 'linux') {
    return {
      platform: 'linux',
      directory: testDownloadDirectory || '/var/lib/webmcp/downloads',
      source: 'managed-policy-file',
      files: [
        '/etc/opt/chrome/policies/managed/webmcp_forcelist.json',
        '/etc/chromium/policies/managed/webmcp_forcelist.json',
        '/etc/chromium-browser/policies/managed/webmcp_forcelist.json',
      ],
    };
  }
  if (process.platform === 'win32') {
    return {
      platform: 'windows',
      directory: testDownloadDirectory || 'C:\\WebMCP\\Downloads',
      source: 'registry-policy',
    };
  }
  return { platform: process.platform, directory: null, source: 'unsupported-platform' };
}

function textHasManagedDownloadPolicy(text, expectedDirectory) {
  return Boolean(text
    && text.includes('PromptForDownloadLocation')
    && text.includes('DownloadDirectory')
    && text.includes(expectedDirectory)
    && !/PromptForDownload(?!Location)/.test(text));
}

function readMacManagedPreferencesPolicy(expectedDirectory) {
  const root = process.env.WEBMCP_TEST_MANAGED_PREFS_ROOT || '/Library/Managed Preferences';
  const candidates = [
    resolve(root, 'com.google.Chrome.plist'),
    resolve(root, process.env.USER || '', 'com.google.Chrome.plist'),
  ];
  for (const file of candidates) {
    if (!file || !existsSync(file)) continue;
    try {
      const text = readFileSync(file, 'utf8');
      if (textHasManagedDownloadPolicy(text, expectedDirectory)) {
        return { installed: true, managedDownloadDirectory: true, source: 'managed-preferences' };
      }
      if (text.includes('com.google.Chrome') || text.includes('ExtensionInstallForcelist')) {
        return { installed: true, managedDownloadDirectory: false, source: 'managed-preferences' };
      }
    } catch {
      // Keep looking; an unreadable managed-preferences file should not make
      // policy readiness pass.
    }
  }
  return { installed: false, managedDownloadDirectory: false, source: 'managed-preferences' };
}

function currentDownloadPolicyReadiness() {
  const expectation = platformDownloadPolicyExpectation();
  const base = {
    schema: 'webmcp-current-download-policy-readiness/1',
    platform: expectation.platform,
    ok: false,
    installed: false,
    promptForDownloadLocation: false,
    managedDownloadDirectory: false,
    downloadDirectoryReady: false,
    source: expectation.source,
  };

  if (process.env.WEBMCP_TEST_CHROME_POLICY_EFFECTIVE === '1') {
    return {
      ...base,
      ok: true,
      installed: true,
      promptForDownloadLocation: false,
      managedDownloadDirectory: true,
      downloadDirectoryReady: true,
      source: 'test-override',
    };
  }
  if (process.env.WEBMCP_TEST_CHROME_POLICY_EFFECTIVE === '0') {
    return { ...base, source: 'test-override' };
  }

  if (!expectation.directory) {
    return { ...base, error: 'current platform policy inspection is not implemented' };
  }

  if (process.platform === 'darwin') {
    const profileOutputPath = process.env.WEBMCP_TEST_PROFILES_SHOW_FILE || null;
    const result = profileOutputPath
      ? { status: 0, stdout: readFileSync(profileOutputPath, 'utf8'), stderr: '' }
      : spawnSync('profiles', ['show', '-type', 'configuration'], { encoding: 'utf8', timeout: 5000 });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const installed = result.status === 0 && output.includes('com.google.Chrome');
    const managedDownloadDirectory = textHasManagedDownloadPolicy(output, expectation.directory);
    const managedPrefs = managedDownloadDirectory
      ? { installed: false, managedDownloadDirectory: false, source: null }
      : readMacManagedPreferencesPolicy(expectation.directory);
    const effectiveInstalled = installed || managedPrefs.installed;
    const effectiveManagedDirectory = managedDownloadDirectory || managedPrefs.managedDownloadDirectory;
    return {
      ...base,
      ok: effectiveInstalled && effectiveManagedDirectory && existsSync(expectation.directory),
      installed: effectiveInstalled,
      promptForDownloadLocation: effectiveManagedDirectory ? false : null,
      managedDownloadDirectory: effectiveManagedDirectory,
      downloadDirectoryReady: existsSync(expectation.directory),
      source: managedDownloadDirectory
        ? (profileOutputPath ? 'test-profile-snapshot' : expectation.source)
        : managedPrefs.source,
      error: result.status === 0 ? null : 'unable to inspect macOS configuration profiles',
    };
  }

  if (process.platform === 'linux') {
    const matchingFiles = expectation.files.filter((file) => existsSync(file));
    const managedDownloadDirectory = matchingFiles.some((file) => {
      try {
        return textHasManagedDownloadPolicy(readFileSync(file, 'utf8'), expectation.directory);
      } catch {
        return false;
      }
    });
    return {
      ...base,
      ok: managedDownloadDirectory && existsSync(expectation.directory),
      installed: matchingFiles.length > 0,
      promptForDownloadLocation: managedDownloadDirectory ? false : null,
      managedDownloadDirectory,
      downloadDirectoryReady: existsSync(expectation.directory),
      source: expectation.source,
    };
  }

  if (process.platform === 'win32') {
    const script = [
      '$p = "HKLM:\\SOFTWARE\\Policies\\Google\\Chrome";',
      'try { $v = Get-ItemProperty -Path $p; [Console]::Out.Write(($v.PromptForDownloadLocation -eq 0).ToString() + "," + ($v.DownloadDirectory -eq "C:\\WebMCP\\Downloads").ToString()) } catch { exit 1 }',
    ].join(' ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 5000 });
    const [promptOk, dirOk] = String(result.stdout || '').trim().split(',');
    const managedDownloadDirectory = dirOk === 'True';
    const promptForDownloadLocation = promptOk === 'True' ? false : null;
    return {
      ...base,
      ok: promptForDownloadLocation === false && managedDownloadDirectory,
      installed: result.status === 0,
      promptForDownloadLocation,
      managedDownloadDirectory,
      downloadDirectoryReady: managedDownloadDirectory,
      source: expectation.source,
      error: result.status === 0 ? null : 'unable to inspect Windows Chrome policy registry',
    };
  }

  return base;
}

export function downloadPolicyReadiness() {
  const artifacts = shippedDownloadPolicyReadiness();
  const current = currentDownloadPolicyReadiness();
  return {
    schema: 'webmcp-download-policy-readiness/1',
    ok: artifacts.ok && current.ok,
    policy: {
      promptForDownloadLocation: false,
      managedDownloadDirectory: true,
    },
    artifacts,
    current,
    platforms: artifacts.platforms,
  };
}
