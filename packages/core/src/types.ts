export interface ServiceProfile {
  id: string;
  name: string;
  baseUrl: string;
  installDir: string;
  pythonPath: string;
  configPath: string;
  managed: boolean;
}

/** A read-only discovery result. Import revalidates the paths in the supervisor. */
export interface LocalCandidate {
  id: string;
  name: string;
  installDir: string;
  pythonPath: string;
  configPath: string;
  modelPath: string;
  modelBytes: number | null;
  detectedPort?: number;
  running?: boolean;
  reason?: string;
  runtimeVersion?: string;
  source?: string;
  availability?: 'ready' | 'repair';
  pid?: number;
}

export interface SupervisorStatus {
  running: boolean;
  pid?: number;
  protocolVersion: number;
  startedAt?: number;
  activeServices: number;
  dataDir?: string;
  version?: string;
  expectedVersion?: string;
  executableHash?: string;
  updatePending?: boolean;
  updateReason?: string | null;
  recovery?: { attempts: number; nextRetryAt: number; lastStartedAt: number; repairRequired: boolean; lastError?: string | null };
  health?: Record<string, BackgroundHealthSnapshot>;
  migration?: LocalInstallationMigration;
  preparationFailures?: { profileId: string; lastError: string; failedAt: number; retryable: boolean; phase: 'prepare' }[];
}

export interface BackgroundHealthSnapshot {
  profileId: string;
  phase: 'healthy' | 'checking' | 'degraded' | 'deferred' | 'unknown' | 'stopped';
  apiHealthy: boolean | null;
  loaded: boolean | null;
  observerState: 'idle' | 'busy' | 'unknown';
  activeRequests: number | null;
  pid: number | null;
  reason: string;
  checkedAt: number;
  lastHealthyAt: number | null;
  probeAttempted: boolean;
  consecutiveFailures: number;
  failures: { at: number; kind: string; httpStatus: number | null; reason: string }[];
}

export interface LocalInstallationMigration {
  schemaVersion: number;
  entries: { id?: string; name?: string; status: 'imported' | 'failed' | 'ignored'; profileId?: string; reason?: string; completedAt: number }[];
  imported: number;
  failed: number;
}

export interface SetupHandoff {
  taskId: string;
  status: 'pending' | 'registered' | 'needs-choice' | 'failed' | 'cancelled';
  profileId?: string;
  error?: string;
  choices?: { configPath: string; name: string }[];
}

export interface AppSettings {
  language: 'zh-CN' | 'en';
  theme: 'dark' | 'light' | 'system';
  closeToTray: boolean;
  pollInterval: number;
  autoCheckUpdates?: boolean;
}

export interface StartupStatus {
  enabled: boolean;
  supported: boolean;
  backgroundOnly: boolean;
  reason?: string;
}

export interface BackgroundPolicy {
  mode: 'lazy' | 'alwaysReady';
  autoRecover: boolean;
}

export interface Attachment {
  id: string;
  name: string;
  type: 'image' | 'text';
  mimeType: string;
  content: string;
}

export interface ChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  reasoning?: string;
  attachments?: Attachment[];
  tools?: ToolEvent[];
  createdAt: number;
  error?: string;
  usage?: JsonObject;
  elapsedMs?: number;
  firstTokenMs?: number;
  reasoningMs?: number;
  stopped?: boolean;
}

export interface ToolEvent {
  name: string; status: string; content?: string;
  id?: string; server?: string; tool?: string; arguments?: unknown; result?: string;
  round?: number; at?: number; ok?: boolean; skipped?: boolean; raw?: JsonObject;
}

export interface Conversation {
  id: string;
  title: string;
  profileId: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ProcessStatus {
  running: boolean;
  owned: boolean;
  pid?: number;
  startedAt?: number;
  exitCode?: number;
  external?: boolean;
  canTakeOver?: boolean;
  reason?: string;
  creationTime?: string;
}

export interface LogEntry { timestamp: number; level: string; message: string }

export interface TaskStatus {
  id: string;
  kind: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  message: string;
  startedAt: number;
  finishedAt?: number;
}

export interface EnvironmentInfo {
  os: string;
  arch: string;
  cpuName: string;
  totalMemory: number;
  availableMemory: number;
  gpus: string[];
  python: string | null;
  git: string | null;
  appVersion: string;
}

export interface SetupDiskVolume {
  directory: string;
  mountPoint: string | null;
  availableBytes: number | null;
  requiredAdditionalBytesEstimate: number;
}

export interface SetupDiskPreflight {
  status: 'ready' | 'insufficient' | 'unknown';
  dataDirectory: string;
  modelDirectory: string;
  modelDownloadBytesEstimate: number | null;
  reusableModelBytes: number;
  additionalBytesEstimate: number | null;
  estimate: true;
  volumes: SetupDiskVolume[];
  reason: string;
  source: string;
}

export interface StreamEvent { kind: 'data' | 'error' | 'done'; data?: string }
export type JsonObject = Record<string, unknown>;
