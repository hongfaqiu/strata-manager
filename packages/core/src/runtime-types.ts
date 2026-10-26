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
  /** DeepSeek-V4.1 engine packages from the signed feed (`dsv41` member). */
  dsv41Assets?: RuntimeReleaseAsset[];
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
  /**
   * `hip` is RX 9000 / R9700 (or the legacy all-in-one HIP ZIP); `hip-rdna3` is the Windows RX 7000 / Strix Halo
   * package. Linux splits it into `hip-rx7900` (RX 7000) and `hip-halo` (Strix Halo). Strata 0.2.2 adds RX 6000:
   * `hip-rx6000` on Linux and `hip-rdna2` on Windows (built, not tested by upstream on a real card).
   */
  variant: 'cuda13' | 'cuda12' | 'hip' | 'hip-rdna3' | 'hip-rx7900' | 'hip-halo' | 'hip-rx6000' | 'hip-rdna2';
  /** Strata 0.2+ component package: its engine version (legacy ZIPs share the release version). */
  engineVersion?: string;
  manifestSha256?: string;
  installedBytes?: number;
  archs?: string[];
  /** Lowest NVIDIA driver the CUDA package runs on, from the signed feed. */
  nvidiaMinDriver?: string;
  /** Bilingual `中文 / English` reason when the package was picked from the detected GPU. */
  matchReason?: string;
}

/** Optional engine ZIP source; integrity always comes from the official release asset. */
export interface RuntimeZipDownloadOptions {
  localArchivePath?: string;
  /** Complete HTTPS engine ZIP URL, rather than a mirror base URL. */
  downloadUrl?: string;
  /** Install this official release (up or down) instead of the latest; every source is verified against it. */
  targetVersion?: string;
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
