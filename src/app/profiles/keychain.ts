import { KEYCHAIN_SERVICE } from '../secrets.js';
import { selectedProfile } from '../pack/paths.js';
import { readMeta } from './meta.js';
import { resolveHome } from './root.js';

export const keychainServiceOf = (home: string): string => readMeta(home)?.keychainService ?? KEYCHAIN_SERVICE;
export const profileKeychainService = (): string => keychainServiceOf(resolveHome({ profile: selectedProfile() }).home);
