export interface PetSpec {
  schemaVersion: number;
  app: {
    name: string;
    appId: string;
    version: string;
    language: string;
  };
  targets: {
    windows: { enabled: boolean; arch: string };
    macos: { enabled: boolean; arch: string };
  };
  character: {
    inputType: string;
    coreAsset: string;
    displayName: string;
    archetype: string;
    personality: string[];
    preserveTraits: string[];
    style: string;
    mirrorSafe: boolean;
  };
  assetPipeline: {
    backgroundMode: string;
    segmentationBackend: string;
    subjectKind: string;
    generationBackground: string;
    backgroundTolerance: number;
    edgeFeather: number;
    safeMargin: number;
    targetOccupancy: number;
  };
  experience: {
    theme: {
      primary: string;
      accent: string;
      background: string;
      surface: string;
      text: string;
      muted: string;
      cornerRadius: number;
    };
    petSizing: {
      baseWindowPx: number;
      defaultScale: number;
    };
    interactions: InteractionSpec[];
  };
  motion: {
    breathing: { enabled: boolean; periodMs: number; scaleX: number; scaleY: number };
    squashStretch: { enabled: boolean; durationMs: number; intensity: number };
    idleIntervalMs: { min: number; max: number };
  };
  features: {
    transparentWindow: boolean;
    drag: boolean;
    tray: boolean;
    edgeSnap: boolean;
    reminders: boolean;
    interactions: boolean;
    relationship: boolean;
    filePocket: boolean;
    dashboard: boolean;
    typingReaction: boolean;
    autonomousMovement: boolean;
  };
  states: PetState[];
  storage: {
    userData: string;
    filePocket: string;
  };
  build: {
    windows: { arch: string; installer: string; portable: string };
    macos: { arch: string; diskImage: string; portable: string };
    timeoutMinutes: number;
    unsigned: boolean;
  };
}

export interface InteractionSpec {
  id: string;
  emoji: string;
  label: string;
  stateId: string;
  durationMs: number;
  affectionGain: number;
  feedback: string[];
}

export interface PetState {
  id: string;
  triggers: string[];
  frames: string[];
  frameDurationMs: number;
  loop: boolean;
  priority: number;
  interrupt: string;
  cooldownMs: number;
  direction: string;
  anchor: { x: number; y: number };
  mirrorSafe: boolean;
}

export interface PetStats {
  affection: number;
  mood: number;
  todayInteractions: number;
  companionMinutes: number;
  lastInteractionDate: string;
}

export interface PetSummary {
  id: string;
  displayName: string;
}

export interface Settings {
  edgeSnap: boolean;
  alwaysOnTop: boolean;
  typingReaction: boolean;
  clickThrough: boolean;
  petScale: number;
  currentPet: string;
}

export interface Reminder {
  id: string;
  text: string;
  dueAt: string;
  createdAt: string;
  /** 提前提醒分钟数（0 = 到点提醒；缺省视为 0） */
  leadMinutes?: number;
}

export interface StateActivity {
  kind: string;
  stateId?: string;
  durationMs?: number;
  feedback?: string;
}

export interface RuntimeReadyReport {
  status: string;
  stateId: string;
  frame: string;
  assetCount: number;
  expectedAssetCount: number;
  naturalWidth: number;
  naturalHeight: number;
  petVisible: boolean;
  ipcReady: boolean;
  renderers?: {
    pet: boolean;
    dashboard: boolean;
    reminder: boolean;
  };
}

export interface RuntimeFailureReport {
  message: string;
}

export interface InteractionResult {
  interaction: InteractionSpec;
  feedback: string;
  stats: PetStats;
}

export interface TypingStatus {
  enabled: boolean;
  reason: string;
}

export type AgentTaskKind = 'task-complete' | 'need-input';

export interface AgentTaskEvent {
  kind: AgentTaskKind;
  /** 展示文案，长度上限 500 */
  text: string;
  /** 事件来源，如 claude-code */
  source?: string;
  /** agent 会话 id（用于去重与追溯） */
  sessionId?: string;
  /** 事件时间（ISO 8601），缺省由主进程补 */
  ts?: string;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  downloadUrl: string | null;
  notes: string;
}

export interface SkillCheckResult {
  /** 是否已安装到 ~/.claude/skills/<name>/ */
  installed: boolean;
  /** 已安装且内容与工程内最新一致 */
  upToDate: boolean;
  /** 人类可读的状态说明 */
  message: string;
}

export interface SkillInstallResult {
  ok: boolean;
  state: 'installed' | 'updated' | 'unchanged' | 'error';
  message: string;
}

export interface Anniversary {
  id: string;
  /** 每年重复日期，格式 MM-DD */
  date: string;
  title: string;
  description: string;
  /** 待机帧序列（相对 src/anniversaries/assets/<id>/） */
  frames: string[];
  frameDurationMs: number;
}

export interface AnniversaryStatus {
  list: Anniversary[];
  /** 当前命中的纪念日 id（null = 今天无命中） */
  activeId: string | null;
  /** 是否为模拟状态（测试用） */
  simulated: boolean;
}

export interface PetAPI {
  settings: {
    get: () => Promise<Settings>;
    update: (patch: Partial<Settings>) => Promise<Settings>;
  };
  reminders: {
    list: () => Promise<Reminder[]>;
    save: (input: { text: string; dueAt: string; leadMinutes?: number }) => Promise<Reminder>;
    remove: (id: string) => Promise<boolean>;
  };
  interactions: {
    list: () => Promise<InteractionSpec[]>;
    trigger: (id: string) => Promise<InteractionResult>;
    stats: () => Promise<PetStats>;
  };
  files: {
    getPathForFile: (file: File) => string;
    put: (paths: string[]) => Promise<{ copied: string[]; failed: Array<{ source: string; reason: string }> }>;
    openPocket: () => Promise<void>;
  };
  window: {
    beginDrag: () => Promise<void>;
    updateDrag: () => Promise<void>;
    endDrag: () => Promise<void>;
    showContextMenu: () => Promise<void>;
    showReminder: () => Promise<void>;
    showDashboard: () => Promise<void>;
    hideReminder: () => Promise<void>;
    hideDashboard: () => Promise<void>;
    hidePet: () => Promise<void>;
  };
  runtime: {
    ready: (report: RuntimeReadyReport) => Promise<void>;
    fail: (report: RuntimeFailureReport) => Promise<void>;
  };
  update: {
    check: () => Promise<UpdateInfo | null>;
    open: (url: string) => Promise<void>;
  };
  skills: {
    /** 检查 pet-reminder 技能是否已安装且为最新 */
    check: () => Promise<SkillCheckResult>;
    /** 安装/更新 pet-reminder 技能到 ~/.claude/skills/（幂等） */
    install: () => Promise<SkillInstallResult>;
  };
  events: {
    onStateActivity: (listener: (activity: StateActivity) => void) => () => void;
    onReminder: (listener: (reminder: Reminder) => void) => () => void;
    onReminderCompose: (listener: () => void) => () => void;
    onStats: (listener: (stats: PetStats) => void) => () => void;
    onTypingStatus: (listener: (status: TypingStatus) => void) => () => void;
    onPetChanged: (listener: (petId: string) => void) => () => void;
    onAnniversaryChanged: (listener: (status: AnniversaryStatus) => void) => () => void;
    onAgentTask: (listener: (event: AgentTaskEvent) => void) => () => void;
  };
  pets: {
    list: () => Promise<PetSummary[]>;
    activate: (petId: string) => Promise<boolean>;
  };
  anniversaries: {
    status: () => Promise<AnniversaryStatus>;
    /** 模拟今天命中某纪念日；传 null 取消模拟 */
    simulate: (date: string | null) => Promise<AnniversaryStatus>;
  };
}

declare global {
  interface Window {
    petAPI?: PetAPI;
    __petE2E?: {
      snapshot: () => Promise<{
        tray: boolean;
        roles: Array<{ role: 'pet' | 'reminder' | 'dashboard'; visible: boolean; destroyed: boolean }>;
        quitting: boolean;
      }>;
      quit: () => Promise<void>;
    };
  }
}

export function assertStringArray(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) throw new TypeError('Expected string array');
  for (const item of value) {
    if (typeof item !== 'string') throw new TypeError('Expected string array');
  }
}

export function assertInteractionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 100) {
    throw new TypeError('Invalid interaction id');
  }
}

export function assertSettingsPatch(value: unknown): asserts value is Partial<Settings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid settings patch');
  }
  const obj = value as Record<string, unknown>;
  const booleanKeys = new Set(['edgeSnap', 'alwaysOnTop', 'typingReaction', 'clickThrough']);
  const allowedKeys = new Set([...booleanKeys, 'petScale', 'currentPet']);
  for (const [key, item] of Object.entries(obj)) {
    if (!allowedKeys.has(key)) throw new TypeError(`Unknown settings field: ${key}`);
    if (booleanKeys.has(key) && typeof item !== 'boolean') throw new TypeError(`Invalid settings field: ${key}`);
    if (key === 'petScale' && (typeof item !== 'number' || !Number.isFinite(item) || ![0.65, 0.8, 1, 1.2].includes(item))) {
      throw new TypeError('Invalid settings field: petScale');
    }
    if (key === 'currentPet' && (typeof item !== 'string' || item.length > 64)) {
      throw new TypeError('Invalid settings field: currentPet');
    }
  }
}

export function assertReminderInput(value: unknown): asserts value is { text: string; dueAt: string; leadMinutes?: number } {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Invalid reminder input');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.text !== 'string' || obj.text.length > 500) {
    throw new TypeError('Invalid reminder text');
  }
  if (typeof obj.dueAt !== 'string' || isNaN(Date.parse(obj.dueAt))) {
    throw new TypeError('Invalid reminder dueAt');
  }
  if (obj.leadMinutes !== undefined) {
    if (typeof obj.leadMinutes !== 'number' || !Number.isInteger(obj.leadMinutes) || obj.leadMinutes < 0 || obj.leadMinutes > 1440) {
      throw new TypeError('Invalid reminder leadMinutes');
    }
  }
}

export function assertAgentTaskEvent(value: unknown): asserts value is AgentTaskEvent {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Invalid agent task event');
  }
  const obj = value as Record<string, unknown>;
  if (obj.kind !== 'task-complete' && obj.kind !== 'need-input') {
    throw new TypeError('Invalid agent task kind');
  }
  if (typeof obj.text !== 'string' || obj.text.length === 0 || obj.text.length > 500) {
    throw new TypeError('Invalid agent task text');
  }
  if (obj.source !== undefined && (typeof obj.source !== 'string' || obj.source.length > 64)) {
    throw new TypeError('Invalid agent task source');
  }
  if (obj.sessionId !== undefined && (typeof obj.sessionId !== 'string' || obj.sessionId.length > 200)) {
    throw new TypeError('Invalid agent task sessionId');
  }
  if (obj.ts !== undefined && (typeof obj.ts !== 'string' || isNaN(Date.parse(obj.ts)))) {
    throw new TypeError('Invalid agent task ts');
  }
}

export function assertRuntimeReadyReport(value: unknown): asserts value is RuntimeReadyReport {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Invalid runtime ready report');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.stateId !== 'string') throw new TypeError('Invalid stateId');
  if (typeof obj.frame !== 'string') throw new TypeError('Invalid frame');
  if (typeof obj.assetCount !== 'number') throw new TypeError('Invalid assetCount');
  if (typeof obj.naturalWidth !== 'number') throw new TypeError('Invalid naturalWidth');
  if (typeof obj.naturalHeight !== 'number') throw new TypeError('Invalid naturalHeight');
}

export function assertRuntimeFailureReport(value: unknown): asserts value is RuntimeFailureReport {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Invalid runtime failure report');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.message !== 'string') throw new TypeError('Invalid message');
}
