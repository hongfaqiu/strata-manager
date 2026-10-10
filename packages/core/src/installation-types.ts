import type { ServiceProfile } from './types';

/** A prepared source checkout and private venv; model files do not exist yet. */
export interface PreparedRuntime {
  installationId: string;
  sourceRevision: string;
  installDir: string;
  pythonPath: string;
  preparedAt: number;
  /** Only for run_setup. Discover/import the generated model config before starting. */
  profile: ServiceProfile;
}

export interface RuntimeInstallationStatus {
  taskId?: string;
  result?: PreparedRuntime;
}
