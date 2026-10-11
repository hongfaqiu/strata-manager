export interface RuntimeUpdateInfo {
  checkedAt: number;
  supportedVersion: string;
  supportedRevision: string;
  latestVersion?: string;
  releaseName?: string;
  releaseUrl?: string;
  notes?: string;
  publishedAt?: string;
  assets: RuntimeReleaseAsset[];
  sourceRevision?: string;
  sourceArchiveUrl?: string;
  selectedAsset?: string;
  upstreamRevision?: string;
  upstreamMessage?: string;
  upstreamUrl?: string;
  updateAvailable: boolean;
  installable: boolean;
  error?: string;
}

export interface RuntimeReleaseAsset {
  name: string;
  url: string;
  size: number;
  sha256: string;
  variant: 'cuda13' | 'cuda12' | 'hip';
}

/** Optional engine ZIP source; integrity always comes from the official release asset. */
export interface RuntimeZipDownloadOptions {
  localArchivePath?: string;
  /** Complete HTTPS engine ZIP URL, rather than a mirror base URL. */
  downloadUrl?: string;
}

/** Saved download choices; a local ZIP or literal URL belongs to one release. */
export interface RuntimeDownloadPreferences {
  /** Built-in mirror identifier; its template follows the official release. */
  sourceId?: string;
  mode: 'official' | 'local' | 'mirror';
  assetName?: string;
  releaseVersion?: string;
  localArchivePath?: string;
  /** Complete HTTPS URL; {url}, {version}, and {asset} can track later releases. */
  mirrorUrl?: string;
}

export interface RuntimeZipDownloadCheckResult {
  source: 'official' | 'local' | 'mirror';
  assetName: string;
  checkedAt: number;
  checkedBytes: number;
  totalBytes: number;
  rangeSupported?: boolean | null;
  sha256Verified: boolean;
}
