import type {
  AgentTaskEvent,
  AnniversaryStatus,
  InteractionResult,
  InteractionSpec,
  PetAPI,
  PetStats,
  PetSummary,
  Reminder,
  RuntimeFailureReport,
  RuntimeReadyReport,
  Settings,
  SkillCheckResult,
  SkillInstallResult,
  StateActivity,
  TypingStatus,
  UpdateInfo,
} from './shared/contracts';
import { PET_PROFILES, getPetProfile } from './pet-profiles';

const tauri = () => window.__TAURI__;

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = tauri();
  if (!t) return Promise.reject(new Error('Tauri runtime unavailable'));
  return t.core.invoke<T>(cmd, args);
}

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  let detach: (() => void) | undefined;
  const t = tauri();
  if (t) {
    void t.event.listen<T>(channel, (event) => listener(event.payload)).then((fn) => {
      detach = fn;
    });
  }
  return () => detach?.();
}

// 按当前宠物从对应 spec 取互动配置（对齐 Electron 主进程 interactions:list）
async function currentInteractions(): Promise<InteractionSpec[]> {
  let petId = PET_PROFILES[0]?.id ?? '';
  try {
    const settings = await invoke<Settings>('get_settings');
    if (settings?.currentPet) petId = settings.currentPet;
  } catch {
    // 读不到配置时回退到首个宠物
  }
  return (
    getPetProfile(petId)?.spec.experience.interactions
    ?? PET_PROFILES[0]?.spec.experience.interactions
    ?? []
  );
}

export const petAPI: PetAPI = {
  settings: {
    get: () => invoke<Settings>('get_settings'),
    update: (patch) => invoke<Settings>('update_settings', { patch }),
  },
  reminders: {
    list: () => invoke<Reminder[]>('reminders_list'),
    save: (input) => invoke<Reminder>('reminders_save', { input }),
    remove: (id) => invoke<boolean>('reminders_remove', { id }),
  },
  interactions: {
    list: () => currentInteractions(),
    trigger: async (id) => {
      const stats = await invoke<PetStats>('interactions_trigger', { id });
      const list = await currentInteractions();
      const interaction = (list.find((i) => i.id === id) ?? list[0])!;
      const feedback = interaction.feedback?.[Math.floor(Math.random() * interaction.feedback.length)] ?? '';
      return { interaction, feedback, stats };
    },
    stats: () => invoke<PetStats>('interactions_stats'),
  },
  files: {
    // Tauri 暂无等价 webUtils；文件口袋功能后续补
    getPathForFile: (file) => file.name,
    put: (paths) =>
      invoke<{ copied: string[]; failed: Array<{ source: string; reason: string }> }>('files_put', { paths }),
    openPocket: () => invoke<void>('files_open_pocket'),
  },
  window: {
    beginDrag: () => tauri()?.window.getCurrentWindow().startDragging() ?? Promise.resolve(),
    updateDrag: () => Promise.resolve(),
    endDrag: () => Promise.resolve(),
    showContextMenu: () => invoke<void>('show_pet_context_menu'),
    showReminder: () => invoke<void>('window_show_reminder'),
    showDashboard: () => invoke<void>('window_show_dashboard'),
    hideReminder: () => invoke<void>('window_hide_reminder'),
    hideDashboard: () => invoke<void>('window_hide_dashboard'),
    hidePet: () => invoke<void>('window_hide_pet'),
  },
  runtime: {
    ready: (report: RuntimeReadyReport) => invoke<void>('runtime_ready', { report }),
    fail: (report: RuntimeFailureReport) => invoke<void>('runtime_fail', { report }),
  },
  update: {
    check: () => invoke<UpdateInfo | null>('update_check'),
    open: (url) => invoke<void>('update_open', { url }),
  },
  skills: {
    check: () => invoke<SkillCheckResult>('skills_check'),
    install: () => invoke<SkillInstallResult>('skills_install'),
  },
  pets: {
    list: () => invoke<PetSummary[]>('pets_list'),
    activate: (petId) => invoke<boolean>('pets_activate', { petId }),
  },
  anniversaries: {
    status: () => invoke<AnniversaryStatus>('anniversaries_status'),
    simulate: (date) => invoke<AnniversaryStatus>('anniversaries_simulate', { date }),
  },
  events: {
    onStateActivity: (listener) => subscribe<StateActivity>('state-activity', listener),
    onReminder: (listener) => subscribe<Reminder>('reminder-due', listener),
    onReminderCompose: (listener) => subscribe<void>('reminder-compose', listener),
    onStats: (listener) => subscribe<PetStats>('pet-stats', listener),
    onTypingStatus: (listener) => subscribe<TypingStatus>('typing-status', listener),
    onPetChanged: (listener) => subscribe<string>('pet-changed', listener),
    onAnniversaryChanged: (listener) => subscribe<AnniversaryStatus>('anniversary-changed', listener),
    onAgentTask: (listener) => subscribe<AgentTaskEvent>('agent-task', listener),
  },
};

// 注入到 window，保持与 Electron preload 一致的访问方式
window.petAPI = petAPI;
