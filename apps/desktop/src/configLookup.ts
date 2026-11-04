const canonical = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();

/** The folder a config path lives in (Windows or POSIX separators). */
export function configDirectory(configPath: string): string {
  return configPath.slice(0, Math.max(configPath.lastIndexOf('\\'), configPath.lastIndexOf('/')));
}

/**
 * Folders to scan when opening one run config: the config's own folder first, because an
 * imported upstream config (for example %LOCALAPPDATA%\Strata\install\strata-*.json) lives
 * outside the runtime it was opened from; then that runtime, so configs inside it still resolve.
 */
export function configLookupDirectories(configPath: string, installDir?: string): string[] {
  const directories: string[] = [];
  for (const directory of [configDirectory(configPath), installDir ?? '']) {
    if (directory && !directories.some(item => canonical(item) === canonical(directory))) directories.push(directory);
  }
  return directories;
}
