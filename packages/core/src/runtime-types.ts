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
