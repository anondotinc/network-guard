// Device Guard app bundle: per-channel identity, the bundle's plists and its
// exact layout. Pure functions; scripts/build-device.mjs does the building.
// Keep in step with device/src/identity.rs.
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const channels = {
  development: {
    bundleId: 'inc.anon.network-guard.dev',
    appName: 'Anon Network Guard Dev',
    agentLabel: 'inc.anon.network-guard.dev.agent',
    hostName: 'inc.anon.network_helper.dev',
    extensionId: 'foghepoakbdbpbjknofnhbhpiehpmdac',
  },
  production: {
    bundleId: 'inc.anon.network-guard',
    appName: 'Anon Network Guard',
    agentLabel: 'inc.anon.network-guard.agent',
    hostName: 'inc.anon.network_helper',
    extensionId: 'gnkbgepgknkbhnnbaihklcfkjhbclajk',
  },
};

export function identity(channel) {
  const value = channels[channel];
  if (!value) throw new Error(`Unknown channel: ${channel}`);
  return { ...value, channel, bundleName: `${value.appName}.app`, agentPlist: `${value.agentLabel}.plist`,
    shimIdentifier: `${value.bundleId}.host`, origin: `chrome-extension://${value.extensionId}/` };
}

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function infoPlist(id, { version, build }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${escape(id.bundleId)}</string>
  <key>CFBundleName</key><string>${escape(id.appName)}</string>
  <key>CFBundleDisplayName</key><string>${escape(id.appName)}</string>
  <key>CFBundleExecutable</key><string>anon-guard</string>
  <key>CFBundleIconFile</key><string>AnonNetworkGuard.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${escape(version)}</string>
  <key>CFBundleVersion</key><string>${escape(build)}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
}

/// The LaunchAgent login item (SMAppService.agent). launchd starts the app when
/// it is turned on and after a crash; a clean Quit (exit 0) stays down.
export function agentPlist(id) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escape(id.agentLabel)}</string>
  <key>BundleProgram</key><string>Contents/MacOS/anon-guard</string>
  <key>ProgramArguments</key>
  <array><string>anon-guard</string><string>--launched-by=agent</string></array>
  <key>AssociatedBundleIdentifiers</key><array><string>${escape(id.bundleId)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
}

export function layout(id) {
  return {
    directories: new Set(['', 'Contents', 'Contents/MacOS', 'Contents/Resources', 'Contents/Library',
      'Contents/Library/LaunchAgents', 'Contents/_CodeSignature']),
    files: new Set(['Contents/Info.plist', 'Contents/MacOS/anon-guard', 'Contents/MacOS/anon-guard-host',
      'Contents/Resources/AnonNetworkGuard.icns', 'Contents/Resources/LICENSE', 'Contents/Resources/BrandAssets-LICENSE',
      `Contents/Library/LaunchAgents/${id.agentPlist}`, 'Contents/_CodeSignature/CodeResources']),
  };
}

/** Throws unless `bundle` is absent or holds only this layout's entries (no symlinks). */
export function assertBundleLayout(bundle, id) {
  const { directories, files } = layout(id);
  function visit(relative) {
    const entry = lstatSync(path.join(bundle, relative), { throwIfNoEntry: false });
    if (!entry) return;
    if (entry.isDirectory() && directories.has(relative)) {
      for (const name of readdirSync(path.join(bundle, relative))) visit(relative ? `${relative}/${name}` : name);
      return;
    }
    if (entry.isFile() && files.has(relative)) return;
    throw new Error(`Unrecognized entry in ${path.basename(bundle)}: ${relative || '.'}. Move it aside; nothing was removed.`);
  }
  visit('');
}
