import { describe, expect, it } from 'vitest';
import { CLOSE_TO_TRAY_REVISION, migrateWindowCloseSettings } from '../src/window-close-settings';

describe('migrateWindowCloseSettings', () => {
  it('restores the tray default that v0.1.0 betas persisted as false', () => {
    // Exactly what beta.1/beta.2 wrote on first boot.
    const beta = { language: 'zh-CN', theme: 'system', closeToTray: false, pollInterval: 3000, autoCheckUpdates: true };
    expect(migrateWindowCloseSettings(beta)).toEqual({ ...beta, closeToTray: true, closeToTrayRevision: CLOSE_TO_TRAY_REVISION });
  });

  it('also repairs later saves that merged the stale false with skipExitConfirmation:false', () => {
    expect(migrateWindowCloseSettings({ closeToTray: false, skipExitConfirmation: false })).toMatchObject({ closeToTray: true, closeToTrayRevision: 1 });
  });

  it('keeps quit-on-close when the user also turned off the exit confirmation', () => {
    expect(migrateWindowCloseSettings({ closeToTray: false, skipExitConfirmation: true })).toEqual({ closeToTray: false, skipExitConfirmation: true, closeToTrayRevision: 1 });
  });

  it('runs only once: a false saved after the marker is a real choice', () => {
    const chosen = { closeToTray: false, skipExitConfirmation: false, closeToTrayRevision: 1 };
    expect(migrateWindowCloseSettings(chosen)).toBe(chosen);
  });

  it('marks settings that already minimize to the tray and leaves first runs to the defaults', () => {
    expect(migrateWindowCloseSettings({ closeToTray: true })).toEqual({ closeToTray: true, closeToTrayRevision: 1 });
    expect(migrateWindowCloseSettings(null)).toBeNull();
    expect(migrateWindowCloseSettings(undefined)).toBeNull();
  });
});
