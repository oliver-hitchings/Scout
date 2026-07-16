#!/usr/bin/env node
import { disableRemoteAccess } from '../ui/lib/remoteAccess.mjs';
import { loadDeviceSettings, saveDeviceSettings } from '../ui/lib/deviceSettings.mjs';
import { isMainModule } from '../ui/lib/mainModule.mjs';

export function removeScoutRemoteMapping(options = {}) {
  const settings = loadDeviceSettings(options);
  const result = disableRemoteAccess(settings, options);
  saveDeviceSettings(result.settings, options);
  return result;
}

if (isMainModule(import.meta.url)) {
  try {
    removeScoutRemoteMapping();
    process.exitCode = 0;
  } catch (error) {
    console.error(`Scout remote access was not removed: ${error.message}`);
    process.exitCode = 1;
  }
}
