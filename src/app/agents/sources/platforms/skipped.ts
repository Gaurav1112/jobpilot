/**
 * Platforms the detector recognises but jobpilot never reads, with the reason (sources-x D8). The verifier answers a
 * guess on one of them with Proposed and this reason, and fetches nothing. A platform leaves this list only with a
 * polite way to read its whole job list.
 */
export const SKIPPED_PLATFORMS: Readonly<Record<string, string>> = {
  ukg: 'ukg: not read: robots.txt disallows */JobBoardView, the only full job list (LoadSearchResults); the board page embeds featured jobs only',
};
export const skippedWhy = (platform: string): string | null => (Object.hasOwn(SKIPPED_PLATFORMS, platform) ? (SKIPPED_PLATFORMS[platform] as string) : null);
