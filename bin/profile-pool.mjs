#!/usr/bin/env node

export { runProfilePool } from '../lib/profile-pool/cli.mjs';
export {
  getWebmcpHome, profilePoolConfigPath, profilePoolStatePath, readProfilePoolConfig,
} from '../lib/profile-pool/legacy-v1-config.mjs';
