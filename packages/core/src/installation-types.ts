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
  detectedRuntimes?: DetectedRuntime[];
}

/** A source/Python installation, independent of any model config being valid. */
export interface DetectedRuntime {
  installDir: string;
  pythonPath: string;
  /** Engine build (BUILD.json); not the Strata release users install. */
  runtimeVersion?: string;
  /** Strata release the folder was installed from (v0.2.2), when it records one. */
  releaseVersion?: string;
  sourceRevision?: string;
  readiness: 'ready' | 'repair';
  reason?: string;
  /** Unregistered runtimes have an empty configPath; use only for model setup. */
  profile: ServiceProfile;
}

/** Already-downloaded archives used instead of downloading during first-run setup. */
export interface LocalRuntimeArchives {
  /** Official Strata source ZIP. */
  strataArchivePath?: string;
  /** Official engine archive (Windows `.zip` or Mac Metal `.tar.gz`); identified by SHA256. */
  engineArchivePath?: string;
}
