export type SkillStage = 0 | 1 | 2 | 3;

export interface SkillReference {
  id: string;
  sourcePath: string;
  triggers: string[];
}

export interface SkillEntry {
  id: string;
  title: string;
  description: string;
  category: "engine" | "discipline" | "genre" | "workflow";
  stage: SkillStage;
  rank: number;
  sourcePath?: string;
  localPath?: string;
  runtime: boolean;
  always: boolean;
  triggers: string[];
  minimumMajor?: number;
  adapterForPhaser3?: string;
  references: SkillReference[];
}

export interface SkillsCatalog {
  schemaVersion: number;
  source: {
    repository: string;
    commit: string;
    license: string;
    licensePath: string;
    noticePath: string;
  };
  tokenBudget: number;
  tokenEstimator: string;
  router: {
    sourcePath: string;
    metadataOnly: boolean;
    referencePaths: string[];
  };
  skills: SkillEntry[];
}

export interface ManifestFile {
  path: string;
  sha256: string;
}

export interface SkillsManifest {
  schemaVersion: number;
  repository: string;
  sourceCommit: string;
  license: string;
  files: ManifestFile[];
}

export interface LoadedSkill {
  id: string;
  title: string;
  category: SkillEntry["category"];
  text: string;
  sourcePath: string;
  sourceSha256: string;
  loadedSha256: string;
  tokenEstimate: number;
  adaptedForPhaser3: boolean;
}

export interface LoadedReference {
  id: string;
  skillId: string;
  text: string;
  sourcePath: string;
  sourceSha256: string;
  loadedSha256: string;
  tokenEstimate: number;
}

export interface SkillSelectionRecord {
  schemaVersion: 1;
  runId: string;
  taskFingerprint: string;
  previousTaskFingerprint?: string;
  rerouted: boolean;
  createdAt: string;
  engine: "phaser";
  engineVersion: string;
  provider: "meta";
  budget: number;
  estimatedTokens: number;
  policyTokens: number;
  skills: Array<{
    id: string;
    sourceSha256: string;
    loadedSha256: string;
    tokenEstimate: number;
    adaptedForPhaser3: boolean;
  }>;
  references: Array<{
    id: string;
    skillId: string;
    sourceSha256: string;
    loadedSha256: string;
    tokenEstimate: number;
  }>;
  deferredSkillIds: string[];
  deferredReferenceIds: string[];
}

export interface SkillSelection {
  runId: string;
  taskFingerprint: string;
  engine: "phaser";
  engineVersion: string;
  budget: number;
  estimatedTokens: number;
  policyTokens: number;
  skills: LoadedSkill[];
  references: LoadedReference[];
  deferredSkillIds: string[];
  deferredReferenceIds: string[];
  suggestedReferenceIds: Array<{ skillId: string; referenceId: string }>;
  record: SkillSelectionRecord;
  advisoryNotice: string;
}

export interface SkillSelectionInput {
  runId: string;
  task: string;
  engineVersion?: string;
  budget?: number;
}

export type SkillSelectionRecorder = (record: SkillSelectionRecord) => void | Promise<void>;

export interface SkillsVerificationResult {
  valid: boolean;
  errors: string[];
  fileCount: number;
}
