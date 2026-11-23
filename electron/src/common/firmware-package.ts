export interface FirmwarePackageImage {
  path: string;
  offset: string;
  bytes: number;
  sha256: string;
}

/** Only reviewed, non-sensitive metadata crosses the Main/Renderer bridge. */
export interface FirmwarePackageSummary {
  id: string;
  projectId: string;
  name: string;
  version: string;
  archiveName: string;
  archiveSha256: string;
  chip: string;
  flashMode: string;
  flashFrequency: string;
  flashSize: string;
  images: FirmwarePackageImage[];
}

export interface FirmwarePackageResult {
  ok: boolean;
  package?: FirmwarePackageSummary;
  canceled?: boolean;
  error?: string;
}
