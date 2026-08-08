import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type {
  AstMatcher,
  ToolSnapshot,
  WatchContract,
  WatchEngineState,
  WatchInput,
  WatchMatch,
} from './watch/types.js';

export type AdvisorSeverity = 'nit' | 'concern' | 'blocker';

export type AdvisorModelBinding = {
  selector: string;
  provider: string;
  modelId: string;
  effort: string;
  family: string;
};

export type InstructionReference = {
  id: string;
  digest?: string;
};

export type PlanBinding = {
  path: string;
  digest: string;
};

export type ToolEvidence = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  validation?: boolean;
  isError: boolean;
  outputDigest: string;
  outputPreview: string;
  finishedAt: number;
};

export type AdvisorState = {
  version: 1;
  objective?: string;
  objectiveUpdatedAt?: number;
  plan?: PlanBinding;
  taskState?: unknown;
  taskReason?: string;
  instructions: InstructionReference[];
  touchedFiles: string[];
  validationAt?: number;
  blockers: string[];
  toolEvidence: ToolEvidence[];
  activeTools: Record<string, { name: string; startedAt: number }>;
  lastTrustedInput?: { text: string; source: 'interactive' | 'rpc'; at: number };
  trustedInputs: Array<{ text: string; source: 'interactive' | 'rpc'; at: number }>;
  lastAnalysisAt?: number;
  lastEmissionSignature?: string;
  lastEmissionAt?: number;
  completionPermit?: { digest: string; taskId: string; createdAt: number };
  continuationIssuedFor?: string;
  pendingContinuity?: boolean;
  watch?: WatchEngineState;
  pendingSemanticMatches?: WatchMatch[];
  completionRequested?: { taskId: string; at: number };
};

export type AdvisorDecision = {
  verdict: 'PASS' | 'GAP' | 'UNKNOWN';
  action: 'silent' | 'warn' | 'continue' | 'blocker' | 'answer';
  message?: string;
  reasoning: string;
  confidence: number;
  objectiveInputAt?: number;
};

export type AdvisorHostOptions = {
  resolveModel(ctx: ExtensionContext): Promise<AdvisorModelBinding | undefined>;
  resolveContext?(ctx: ExtensionContext, state: AdvisorState): Promise<string>;
  watchContract?: WatchContract;
  matchAst?: AstMatcher;
  resolveToolSnapshots?(
    ctx: ExtensionContext,
    event: {
      toolName: string;
      input: Record<string, unknown>;
      isError: boolean;
    }
  ): Promise<ToolSnapshot[]>;
};
