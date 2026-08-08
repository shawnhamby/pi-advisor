export type WatchSource =
  | 'text'
  | 'thinking'
  | 'tool'
  | 'tool-result'
  | 'task'
  | 'lifecycle'
  | 'signal';

export type WatchEffect = 'remind' | 'semantic';
export type WatchInterruptMode = 'never' | 'prose-only' | 'tool-only' | 'always';

export type WatchRule = {
  id: string;
  description?: string;
  message: string;
  severity: 'nit' | 'concern' | 'blocker';
  effect: WatchEffect;
  activates?: boolean;
  settledCondition?: 'no-later-tool';
  conditions?: string[];
  astConditions?: string[];
  scope?: string[];
  globs?: string[];
  interruptMode?: WatchInterruptMode;
  repeat?: { mode: 'once' | 'after-gap'; gap?: number };
  provenance?: { owner: string; source?: string };
};

export type WatchContract = {
  schemaVersion: 1;
  rules: WatchRule[];
};

export type WatchInput = {
  source: WatchSource;
  content: string;
  streamKey?: string;
  toolName?: string;
  filePaths?: string[];
  language?: string;
  snapshot?: boolean;
};

export type WatchMatch = {
  ruleId: string;
  message: string;
  severity: WatchRule['severity'];
  effect: WatchEffect;
  activates: boolean;
  settledCondition?: WatchRule['settledCondition'];
  observedEvidenceCount?: number;
  interruptMode: WatchInterruptMode;
  source: WatchSource;
  signature: string;
  filePaths: string[];
  provenance?: WatchRule['provenance'];
};

export type WatchEngineState = {
  turn: number;
  delivered: Record<string, number>;
};

export type AstMatchRequest = {
  patterns: string[];
  content: string;
  language?: string;
  filePath?: string;
};

export type AstMatcher = (request: AstMatchRequest) => Promise<boolean>;

export type ToolSnapshot = {
  path: string;
  content: string;
  language?: string;
};
