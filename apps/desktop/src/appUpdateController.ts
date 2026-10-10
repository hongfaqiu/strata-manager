import type { Update } from '@tauri-apps/plugin-updater';

export interface AppUpdateState {
  phase: 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'downloaded' | 'installing' | 'installed' | 'error';
  version?: string;
  notes?: string;
  received: number;
  total?: number;
  downloaded: boolean;
  error?: string;
  errorStage?: 'check' | 'download' | 'install';
}

type UpdateResource = Pick<Update, 'version' | 'body' | 'download' | 'install' | 'close'>;
interface Dependencies {
  check: () => Promise<UpdateResource | null>;
  prepare: () => Promise<unknown>;
  loadLastCheck: () => Promise<number>;
  saveLastCheck: (time: number) => Promise<unknown>;
  now: () => number;
  acquire?: () => boolean;
  release?: () => void;
}
interface HeldUpdate {
  update: UpdateResource;
  downloaded: boolean;
  received: number;
  total?: number;
  closed?: boolean;
  confirmed?: boolean;
}

export const CHECK_INTERVAL = 12 * 60 * 60 * 1000;
interface Options { desktop: boolean; enabled: boolean; ready: boolean; idle?: boolean }

// Keep one native operation in flight; close its resources only after it settles.
export class AppUpdateController {
  private dependencies: Dependencies;
  private held: HeldUpdate | null = null;
  private session = 0;
  private active = false;
  private options = { desktop: false, enabled: false, ready: false, idle: true };
  private automaticGeneration = 0;
  private listener?: (state: AppUpdateState) => void;
  private operation: Promise<void> | null = null;
  private operationSession = 0;
  private pendingAutomatic = false;
  private pendingAutomaticForce = false;
  private stage: 'check' | 'download' | 'install' = 'check';
  state: AppUpdateState = { phase: 'idle', received: 0, downloaded: false };

  constructor(dependencies: Dependencies) { this.dependencies = dependencies; }

  attach(listener: (state: AppUpdateState) => void) {
    this.session += 1;
    this.active = true;
    this.listener = listener;
    listener(this.state);
  }

  detach() {
    this.active = false;
    this.session += 1;
    this.listener = undefined;
    this.pendingAutomatic = false;
    this.pendingAutomaticForce = false;
    this.state = { phase: 'idle', received: 0, downloaded: false };
    if (!this.operation) void this.release();
  }

  configure(options: Options) {
    if (options.enabled !== this.options.enabled || options.desktop !== this.options.desktop || options.ready !== this.options.ready) {
      this.automaticGeneration += 1;
      this.pendingAutomatic = false;
      this.pendingAutomaticForce = false;
    }
    this.options = { ...options, idle: options.idle ?? true };
  }

  private usable(session: number) {
    return this.active && session === this.session && this.options.desktop && this.options.ready;
  }

  private automaticEnabled(session: number) { return this.usable(session) && this.options.enabled; }
  private automaticAllowed(session: number, generation: number) {
    return this.automaticEnabled(session) && generation === this.automaticGeneration;
  }

  private publish(phase: AppUpdateState['phase'], extra: Partial<AppUpdateState> = {}) {
    const held = this.held;
    this.state = {
      phase, received: held?.received ?? 0, downloaded: held?.downloaded ?? false,
      ...(held ? { version: held.update.version, notes: held.update.body, total: held.total } : {}),
      ...extra,
    };
    this.listener?.(this.state);
  }

  private async close(held: HeldUpdate) {
    if (held.closed) return;
    held.closed = true;
    // Unmount cleanup must not create an unhandled rejection.
    await held.update.close().catch(() => undefined);
  }

  private async release() {
    const held = this.held;
    this.held = null;
    if (held) await this.close(held);
  }

  private run(action: (session: number) => Promise<void>): Promise<void> {
    if (!this.usable(this.session)) return Promise.resolve();
    if (this.operation) return this.operation;
    const session = this.session;
    this.operationSession = session;
    const operation = Promise.resolve().then(() => action(session)).catch(error => {
      if (this.usable(session)) this.publish('error', {
        error: error instanceof Error ? error.message : String(error), errorStage: this.stage,
      });
    }).finally(async () => {
      if (!this.active || session !== this.session) await this.release();
      this.operation = null;
      if (this.pendingAutomatic && this.automaticEnabled(this.session)) {
        const force = this.pendingAutomaticForce;
        this.pendingAutomatic = false;
        this.pendingAutomaticForce = false;
        void this.automatic(force);
      }
    });
    this.operation = operation;
    return operation;
  }

  private async downloadHeld(session: number) {
    const held = this.held;
    if (!held || !held.confirmed || held.downloaded || !this.usable(session)) return;
    this.stage = 'download';
    held.received = 0;
    held.total = undefined;
    this.publish('downloading');
    await held.update.download(event => {
      if (!this.usable(session)) return;
      if (event.event === 'Started') held.total = event.data.contentLength;
      if (event.event === 'Progress') held.received += event.data.chunkLength;
      this.publish('downloading');
    }, { timeout: 600000 });
    // Finished is a progress event. Wait for successful native verification.
    held.downloaded = true;
    if (this.usable(session)) this.publish('downloaded');
  }

  private async checkUpdate(session: number) {
    if (!this.usable(session) || this.held?.downloaded || this.state.phase === 'installed') return;
    this.stage = 'check';
    this.publish('checking');
    const update = await this.dependencies.check();
    const next: HeldUpdate | null = update ? { update, downloaded: false, received: 0 } : null;
    if (!this.usable(session)) { if (next) await this.close(next); return; }
    await this.release();
    if (!this.usable(session)) { if (next) await this.close(next); return; }
    this.held = next;
    this.publish(next ? 'available' : 'current');
    await this.dependencies.saveLastCheck(this.dependencies.now());
  }

  check = () => this.run(session => this.checkUpdate(session));

  private async installHeld(session: number) {
    const held = this.held;
    if (!held?.confirmed || !held.downloaded || !this.usable(session) || !this.options.idle) return;
    this.stage = 'install';
    this.publish('installing');
    await this.dependencies.prepare();
    if (!this.usable(session)) return;
    if (!this.options.idle) { this.publish('downloaded'); return; }
    await held.update.install({ restartAfterInstall: true });
    if (this.usable(session)) this.publish('installed', { downloaded: false });
    await this.release();
  }

  /** Approval is bound to the displayed candidate, never a later check result. */
  confirm = (version: string) => this.run(async session => {
    const held = this.held;
    if (!held || held.update.version !== version || !this.options.idle) return;
    this.stage = held.downloaded ? 'install' : 'download';
    if (this.dependencies.acquire && !this.dependencies.acquire()) throw new Error('Another update is already running.');
    try {
      held.confirmed = true;
      await this.downloadHeld(session);
      if (this.held === held && this.usable(session)) await this.installHeld(session);
    } finally { this.dependencies.release?.(); }
  });

  automatic = (force = false): Promise<void> => {
    if (!this.automaticEnabled(this.session) || this.state.phase === 'installed') return Promise.resolve();
    if (this.operation) {
      if (this.operationSession !== this.session) {
        this.pendingAutomatic = true;
        this.pendingAutomaticForce ||= force;
      }
      return this.operation;
    }
    const generation = this.automaticGeneration;
    return this.run(async session => {
      if (!this.automaticAllowed(session, generation)) return;
      if (this.held?.downloaded) return;
      this.stage = 'check';
      if (force) { await this.checkUpdate(session); return; }
      const last = await this.dependencies.loadLastCheck();
      if (this.automaticAllowed(session, generation) && this.dependencies.now() - last >= CHECK_INTERVAL) await this.checkUpdate(session);
    });
  };
}
