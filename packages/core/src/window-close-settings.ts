/**
 * Window-close preference migration.
 *
 * v0.1.0-beta.1/beta.2 shipped `closeToTray: false` as the frontend default and
 * persisted the whole merged settings object on first boot, so every install
 * that started on a beta stored `false` without the user choosing it. Later
 * versions merge `{...defaults, ...saved}`, so that stale default kept winning
 * over the newer `true` default and clicking the close button asked to quit.
 *
 * Revision 1 marks settings whose `closeToTray` value is known to be a real
 * choice. Saved settings without it get one correction: a stored `false` turns
 * back into `true`, unless the user also disabled the exit confirmation, which
 * only happens through an explicit "do not ask again" / settings toggle and so
 * shows they really want closing to quit.
 */
export const CLOSE_TO_TRAY_REVISION = 1;

type WindowCloseFields = { closeToTray?: unknown; skipExitConfirmation?: unknown; closeToTrayRevision?: unknown };

export function closeToTrayChoiceIsCurrent(saved: WindowCloseFields): boolean {
  return typeof saved.closeToTrayRevision === 'number' && saved.closeToTrayRevision >= CLOSE_TO_TRAY_REVISION;
}

export function migrateWindowCloseSettings<T extends WindowCloseFields>(saved: T): T & { closeToTrayRevision: number };
export function migrateWindowCloseSettings<T extends WindowCloseFields>(saved: T | null | undefined): (T & { closeToTrayRevision: number }) | null;
export function migrateWindowCloseSettings<T extends WindowCloseFields>(saved: T | null | undefined): (T & { closeToTrayRevision: number }) | null {
  if (!saved || typeof saved !== 'object') return null;
  if (closeToTrayChoiceIsCurrent(saved)) return saved as T & { closeToTrayRevision: number };
  const staleDefault = saved.closeToTray === false && saved.skipExitConfirmation !== true;
  return { ...saved, ...(staleDefault ? { closeToTray: true } : {}), closeToTrayRevision: CLOSE_TO_TRAY_REVISION };
}
