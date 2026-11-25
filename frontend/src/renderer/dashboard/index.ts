import type { Anniversary, AnniversaryStatus, PetSpec, PetStats, Settings, InteractionSpec, Todo, TodoPriority, UpdateInfo } from '../../shared/contracts';
import { getPetProfile, PET_PROFILES } from '../../pet-profiles';
import './index.css';

let petSpec: PetSpec = PET_PROFILES[0]!.spec;

function applyPetIdentity(): void {
  document.title = `${petSpec.character.displayName}的小屋`;
  document.getElementById('pet-name')!.textContent = petSpec.character.displayName;
  document.getElementById('pet-personality')!.textContent = petSpec.character.personality.join('、');
  const theme = petSpec.experience.theme;
  document.documentElement.style.setProperty('--primary', theme.primary);
  document.documentElement.style.setProperty('--accent', theme.accent);
  document.documentElement.style.setProperty('--background', theme.background);
  document.documentElement.style.setProperty('--surface', theme.surface);
  document.documentElement.style.setProperty('--text', theme.text);
  document.documentElement.style.setProperty('--muted', theme.muted);
  document.documentElement.style.setProperty('--radius', `${theme.cornerRadius}px`);
}

applyPetIdentity();

const closeBtn = document.getElementById('close-btn') as HTMLButtonElement;

// 窗口拖动：在非交互控件区域按下时拖动整个窗口（按钮/输入框/开关/选择器不触发）
function bindDrag(el: HTMLElement | null): void {
  if (!el) return;
  el.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button, input, select, a, textarea, .toggle, .size-selector, .gap-control')) return;
    void window.petAPI?.window.startWindowDrag('dashboard');
  });
}
bindDrag(document.querySelector('.card'));
const affectionEl = document.getElementById('affection') as HTMLDivElement;
const moodEl = document.getElementById('mood') as HTMLDivElement;
const todayInteractionsEl = document.getElementById('today-interactions') as HTMLDivElement;
const companionMinutesEl = document.getElementById('companion-minutes') as HTMLDivElement;
const interactionsList = document.getElementById('interactions-list') as HTMLDivElement;
const toggleAlwaysOnTop = document.getElementById('toggle-always-on-top') as HTMLDivElement;
const toggleClickThrough = document.getElementById('toggle-click-through') as HTMLDivElement;
const toggleAutostart = document.getElementById('toggle-autostart') as HTMLDivElement;
const sizeSelector = document.getElementById('size-selector') as HTMLDivElement;
const todoBoxGapInput = document.getElementById('todo-box-gap') as HTMLInputElement;
const todoBoxGapValue = document.getElementById('todo-box-gap-value') as HTMLSpanElement;

let currentSettings: Settings | null = null;

// 加载互动列表
async function loadInteractions(): Promise<void> {
  try {
    const interactions = await window.petAPI?.interactions.list();
    if (!interactions) return;

    interactionsList.replaceChildren();
    for (const interaction of interactions) {
      const btn = document.createElement('button');
      btn.className = 'interaction-btn';
      const emoji = document.createElement('span');
      emoji.textContent = interaction.emoji;
      const label = document.createElement('span');
      label.textContent = interaction.label;
      btn.append(emoji, label);
      btn.addEventListener('click', async () => {
        try {
          await window.petAPI?.interactions.trigger(interaction.id);
        } catch (error) {
          console.error('Failed to trigger interaction:', error);
        }
      });
      interactionsList.appendChild(btn);
    }
  } catch (error) {
    console.error('Failed to load interactions:', error);
  }
}

// 加载设置
async function loadSettings(): Promise<void> {
  try {
    const settings = await window.petAPI?.settings.get();
    if (!settings) return;
    currentSettings = settings;

    // 更新开关状态
    if (settings.alwaysOnTop) {
      toggleAlwaysOnTop.classList.add('active');
    } else {
      toggleAlwaysOnTop.classList.remove('active');
    }

    if (settings.clickThrough) {
      toggleClickThrough.classList.add('active');
    } else {
      toggleClickThrough.classList.remove('active');
    }

    // 开机自启状态（系统侧真值，独立于 settings.json）
    try {
      const autostart = await window.petAPI?.autostart.get();
      if (autostart) {
        toggleAutostart.classList.add('active');
      } else {
        toggleAutostart.classList.remove('active');
      }
    } catch (error) {
      console.error('Failed to read autostart state:', error);
    }

    // 箱子间距
    const gap = Number.isFinite(settings.todoBoxGap) ? settings.todoBoxGap : 2;
    todoBoxGapInput.value = String(gap);
    todoBoxGapValue.textContent = String(gap);

    // 更新大小选择
    const sizeBtns = sizeSelector.querySelectorAll('.size-btn');
    sizeBtns.forEach((btn) => {
      const scale = parseFloat((btn as HTMLElement).dataset.scale || '1');
      if (Math.abs(scale - settings.petScale) < 0.01) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

// 加载统计数据
async function loadStats(): Promise<void> {
  try {
    const stats = await window.petAPI?.interactions.stats();
    if (!stats) return;
    updateStats(stats);
  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

function updateStats(stats: PetStats): void {
  affectionEl.textContent = String(stats.affection);
  moodEl.textContent = String(stats.mood);
  todayInteractionsEl.textContent = String(stats.todayInteractions);
  const unit = document.createElement('small');
  unit.textContent = '分钟';
  companionMinutesEl.replaceChildren(String(stats.companionMinutes), unit);
}

// 关闭按钮
closeBtn.addEventListener('click', async () => {
  await window.petAPI?.window.hideDashboard();
});

// 置顶开关
toggleAlwaysOnTop.addEventListener('click', async () => {
  if (!currentSettings) return;
  const newVal = !currentSettings.alwaysOnTop;
  try {
    await window.petAPI?.settings.update({ alwaysOnTop: newVal });
    currentSettings.alwaysOnTop = newVal;
    if (newVal) {
      toggleAlwaysOnTop.classList.add('active');
    } else {
      toggleAlwaysOnTop.classList.remove('active');
    }
  } catch (error) {
    console.error('Failed to update setting:', error);
  }
});

// 鼠标穿透开关
toggleClickThrough.addEventListener('click', async () => {
  if (!currentSettings) return;
  const newVal = !currentSettings.clickThrough;
  try {
    await window.petAPI?.settings.update({ clickThrough: newVal });
    currentSettings.clickThrough = newVal;
    if (newVal) {
      toggleClickThrough.classList.add('active');
    } else {
      toggleClickThrough.classList.remove('active');
    }
  } catch (error) {
    console.error('Failed to update setting:', error);
  }
});

// 开机自启开关
toggleAutostart.addEventListener('click', async () => {
  const enabled = !toggleAutostart.classList.contains('active');
  try {
    const actual = await window.petAPI?.autostart.set(enabled);
    if (actual) {
      toggleAutostart.classList.add('active');
    } else {
      toggleAutostart.classList.remove('active');
    }
  } catch (error) {
    console.error('Failed to update autostart:', error);
  }
});

// 箱子间距：拖动时先更新数值，松手后落盘并移动箱子
todoBoxGapInput.addEventListener('input', () => {
  todoBoxGapValue.textContent = todoBoxGapInput.value;
});
todoBoxGapInput.addEventListener('change', async () => {
  if (!currentSettings) return;
  const gap = Number(todoBoxGapInput.value);
  try {
    await window.petAPI?.settings.update({ todoBoxGap: gap });
    currentSettings.todoBoxGap = gap;
  } catch (error) {
    console.error('Failed to update todo box gap:', error);
  }
});

// 大小选择
sizeSelector.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  if (!target.classList.contains('size-btn')) return;
  if (!currentSettings) return;

  const scale = parseFloat(target.dataset.scale || '1');
  try {
    await window.petAPI?.settings.update({ petScale: scale });
    currentSettings.petScale = scale;

    const sizeBtns = sizeSelector.querySelectorAll('.size-btn');
    sizeBtns.forEach((btn) => btn.classList.remove('active'));
    target.classList.add('active');
  } catch (error) {
    console.error('Failed to update pet scale:', error);
  }
});

// 监听统计数据更新
window.petAPI?.events.onStats((stats: PetStats) => {
  updateStats(stats);
});

async function loadUpdateInfo(): Promise<void> {
  const versionEl = document.getElementById('update-version');
  const statusEl = document.getElementById('update-status');
  const btn = document.getElementById('update-btn') as HTMLButtonElement | null;
  if (!versionEl || !statusEl || !btn) return;
  const version = versionEl;
  const status = statusEl;

  function applyState(info: UpdateInfo | null | undefined): void {
    if (!info) {
      version.textContent = '未知版本（检查失败）';
      return;
    }
    if (info.hasUpdate) {
      version.textContent = `v${info.currentVersion}（发现新版本 v${info.latestVersion}）`;
    } else {
      version.textContent = `v${info.currentVersion}（已是最新版本）`;
    }
  }

  try {
    const info = await window.petAPI?.update.check();
    applyState(info);
  } catch (error) {
    console.error('Failed to check update:', error);
    applyState(null);
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.style.display = 'block';
    status.textContent = '正在检查…';
    try {
      const result = await window.petAPI?.update.check();
      if (!result) {
        status.textContent = '检查失败：无法访问更新服务，请稍后再试';
        applyState(null);
      } else if (result.hasUpdate) {
        const target = result.downloadUrl || result.releaseUrl;
        status.textContent = `发现新版本 v${result.latestVersion}，正在打开下载页…`;
        await window.petAPI?.update.open(target);
        applyState(result);
      } else {
        status.textContent = `已是最新版本（v${result.currentVersion}）`;
        applyState(result);
      }
    } catch (error) {
      console.error('Failed to check update:', error);
      status.textContent = '检查失败：无法访问更新服务，请稍后再试';
      applyState(null);
    } finally {
      btn.disabled = false;
    }
  });
}

// 纪念日日历
let calYear: number = new Date().getFullYear();
let calMonth: number = new Date().getMonth(); // 0-indexed
let anniversaryData: AnniversaryStatus | null = null;

function renderCalendar(): void {
  const titleEl = document.getElementById('cal-title');
  const daysEl = document.getElementById('cal-days');
  if (!titleEl || !daysEl) return;

  titleEl.textContent = `${calYear}年${calMonth + 1}月`;
  daysEl.replaceChildren();

  const today = new Date();
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(calYear, calMonth, 0).getDate();

  // 纪念日映射: "MM-DD" -> Anniversary
  const eventMap = new Map<string, Anniversary>();
  if (anniversaryData) {
    for (const item of anniversaryData.list) {
      eventMap.set(item.date, item);
    }
  }

  // 上个月补位
  for (let i = firstDay - 1; i >= 0; i--) {
    const day = daysInPrevMonth - i;
    const cell = document.createElement('div');
    cell.className = 'cal-day other-month';
    cell.textContent = String(day);
    daysEl.appendChild(cell);
  }

  // 本月
  for (let d = 1; d <= daysInMonth; d++) {
    const mm = String(calMonth + 1).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    const dateKey = `${mm}-${dd}`;
    const event = eventMap.get(dateKey);
    const isToday = d === today.getDate() && calMonth === today.getMonth() && calYear === today.getFullYear();

    const cell = document.createElement('div');
    cell.className = 'cal-day';
    if (isToday) cell.classList.add('today');
    if (event) cell.classList.add('has-event');
    cell.textContent = String(d);
    if (event) {
      const label = document.createElement('div');
      label.className = 'event-label';
      label.textContent = event.title;
      cell.appendChild(label);
      cell.addEventListener('click', () => showEventDetail(event));
    }
    daysEl.appendChild(cell);
  }

  // 下个月补位
  const totalCells = firstDay + daysInMonth;
  const trailing = (7 - (totalCells % 7)) % 7;
  for (let d = 1; d <= trailing; d++) {
    const cell = document.createElement('div');
    cell.className = 'cal-day other-month';
    cell.textContent = String(d);
    daysEl.appendChild(cell);
  }
}

function showEventDetail(anniversary: Anniversary): void {
  const detail = document.getElementById('cal-event-detail');
  const title = document.getElementById('ev-title');
  const desc = document.getElementById('ev-desc');
  const previewBtn = document.getElementById('ev-preview');
  const statusEl = document.getElementById('anniversary-status');
  if (!detail || !title || !desc || !previewBtn) return;

  title.textContent = `🎂 ${anniversary.title}`;
  desc.textContent = `${anniversary.date} · ${anniversary.description}`;
  detail.classList.add('show');

  const isActive = anniversaryData?.activeId === anniversary.id;
  previewBtn.textContent = isActive ? '恢复正常' : '预览效果';
  previewBtn.onclick = async () => {
    try {
      const next = isActive ? null : anniversary.date;
      const result = await window.petAPI?.anniversaries.simulate(next);
      if (result) {
        anniversaryData = result;
        renderCalendar();
        renderStatus(result);
      }
    } catch (error) {
      console.error('Failed to simulate anniversary:', error);
    }
  };
}

function renderStatus(status: AnniversaryStatus): void {
  const statusEl = document.getElementById('anniversary-status');
  const rowEl = document.getElementById('anniversary-status-row');
  if (!statusEl || !rowEl) return;
  if (status.activeId) {
    const active = status.list.find((item) => item.id === status.activeId);
    statusEl.textContent = status.simulated
      ? `当前模拟：${active?.title ?? ''}`
      : `今天命中：${active?.title ?? ''}`;
  } else {
    statusEl.textContent = status.simulated ? '模拟状态：无命中' : '今天无纪念日';
  }
  // 只在模拟状态时显示恢复按钮
  rowEl.style.display = status.simulated ? 'flex' : 'none';
}

async function loadAnniversaries(): Promise<void> {
  try {
    const status = await window.petAPI?.anniversaries.status();
    if (status) {
      anniversaryData = status;
      renderCalendar();
      renderStatus(status);
    }
  } catch (error) {
    console.error('Failed to load anniversaries:', error);
  }

  // 月份切换
  document.getElementById('cal-prev')?.addEventListener('click', () => {
    calMonth--;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    renderCalendar();
  });
  document.getElementById('cal-next')?.addEventListener('click', () => {
    calMonth++;
    if (calMonth > 11) { calMonth = 0; calYear++; }
    renderCalendar();
  });

  // 恢复正常
  document.getElementById('anniversary-reset')?.addEventListener('click', async () => {
    try {
      const result = await window.petAPI?.anniversaries.simulate(null);
      if (result) {
        anniversaryData = result;
        renderCalendar();
        renderStatus(result);
      }
    } catch (error) {
      console.error('Failed to reset anniversary:', error);
    }
  });

  window.petAPI?.events.onAnniversaryChanged((status) => {
    anniversaryData = status;
    renderCalendar();
    renderStatus(status);
  });
}

// Tab 切换
function setupTabs(): void {
  const btns = document.querySelectorAll('.tab-btn');
  const pages = document.querySelectorAll('.tab-page');
  btns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = (btn as HTMLElement).dataset.tab;
      btns.forEach((b) => b.classList.remove('active'));
      pages.forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`)?.classList.add('active');
    });
  });
}

// 版本更新日志
const CHANGELOG = [
  {
    version: '1.7.0',
    date: '2026-11-25',
    changes: [
      '🐭 修复 macOS 上窗口拖动不跟随：小屋 / 提醒窗改用与桌宠一致的原生跟随方案，松手即停',
      '📝 待办改版：进行中/过期/已完成/放弃四个 tab，全部显示所有日期条目',
      '📊 待办列表表格化：优先级 / 到期时间 / 创建时间三列，点表头排序',
      '🚫 新增「放弃」状态：必须填写放弃理由，完成/放弃后可重新打开',
      '📦 待办箱子透明化 + 素材留白补偿，视觉上紧贴桌宠；角标数字不再被窗口边缘裁切',
      '⏰ 过期提示改为相对时长（已过期 X 分钟 / 小时 / 天）',
    ],
  },
  {
    version: '1.6.1',
    date: '2026-11',
    changes: ['📦 动画帧改用 256 色量化 PNG，安装包体积约减半（画质肉眼无差）', '🗂 102 张 512×512 无损母版完整保留在仓库 assets-original/', '🐛 修复 pet-spec 版本号与 package 长期不一致；素材校验区分运行时帧与母版'],
  },
  {
    version: '1.6.0',
    date: '2026-11',
    changes: ['🔁 重复提醒支持每小时 / 每天 / 工作日 / 每周，到点自动推进下一次', '😴 提醒弹窗新增「稍后提醒」5 / 10 / 30 分钟，重复提醒不改原节奏', '⚡ 右键菜单新增快捷提醒：每小时喝水、起来活动、每天 22:30 休息', '📍 记住桌宠窗口位置，重启回到原处（多屏拔除时自动回退）', '🚀 设置区新增「开机自启」开关，读取系统真实状态', '🎂 节日 tab 更名「纪念日」；待办新增「清除已过期」'],
  },
  {
    version: '1.5.1',
    date: '2026-11',
    changes: ['🖱️ 小屋与添加闹钟窗口支持鼠标拖动', '🔔 闹钟本地接口闭环：查询全部/单条、更新、删除，AI 可定位并变更或取消提醒', '🐛 修复 agent-bridge 启动路由 panic；同步 pet-reminder 技能脚本与文档'],
  },
  {
    version: '1.5.0',
    date: '2026-11',
    changes: ['🧱 桌面框架由 Electron 迁移到 Tauri v2（Rust 主进程 + Vite 多页前端），安装包体积与运行内存下降', '🧩 三窗口、托盘/右键菜单、双宠切换、4 个互动动画、提醒调度、纪念日、agent-bridge、技能安装、历史数据迁移与系统通知等主链路在 Tauri 下复刻', '📦 素材处理 Node 脚本保留不迁；GitHub Actions 改造为 Tauri 双平台打包'],
  },
  {
    version: '1.4.1',
    date: '2026-11',
    changes: ['🎨 多帧素材边缘白边优化（哈哈待机/走动/跳跃/通知等帧 + 妮妮走动帧，手动修边版）', '🔧 拖拽体验优化：悬空图显示放大与待机视觉协调；松手即时回待机，不再残留 3 秒'],
  },
  {
    version: '1.4.0',
    date: '2026-11',
    changes: ['🐾 新增「拖拽悬空」状态：拖起桌宠切换为被提起的悬空姿态（哈哈/妮妮全身像、脚部自然蜷缩、不显示手），放下回到待机', '🔧 修复 bury 动画第 5 帧腿部缺口（哈哈运行时素材替换为补腿修复版）'],
  },
  {
    version: '1.3.1',
    date: '2026-11',
    changes: ['🔧 修复打包版面板「安装技能」失败：技能安装器与资源随包输出（extraResource），打包环境改用 resourcesPath 定位，不再指向 asar 内路径'],
  },
  {
    version: '1.3.0',
    date: '2026-11',
    changes: ['🤖 Claude Code 打通：Agent 任务实时上桌宠（需要输入/任务完成泡泡，多会话堆叠）', '📅 定任务/会议 → 后台提醒（本地接口，支持 leadMinutes 提前提醒）', '🧰 一键安装 Claude hooks 与 pet-reminder 技能，面板新增「🤖 Claude 技能」安装入口'],
  },
  {
    version: '1.2.0',
    date: '2026-10',
    changes: ['🎉 新增节日待机：妮妮生日（戴生日帽+蛋糕）', '🎂 节日系统：按日期自动切换特殊待机帧', '🔧 小屋面板改为 tab 布局（主页/节日/更新日志）'],
  },
  {
    version: '1.1.0',
    date: '2026-09',
    changes: ['🐱 新增第二只宠物妮妮，支持切换', '📦 支持自动更新检查', '🎨 优化动作帧和待机节奏'],
  },
  {
    version: '1.0.1',
    date: '2026-09',
    changes: ['📥 新增自动更新：托盘菜单与小屋面板支持「检查更新」，新版本直达下载页'],
  },
  {
    version: '1.0.0',
    date: '2026-09',
    changes: ['🐱 首发布：哈哈（布偶猫）桌宠', '🚶 走路、跳跃、匍匐、埋屎等动作', '💬 右键互动、提醒、小屋面板'],
  },
];

function renderChangelog(): void {
  const listEl = document.getElementById('changelog-list');
  if (!listEl) return;
  listEl.replaceChildren();
  for (const item of CHANGELOG) {
    const row = document.createElement('div');
    row.className = 'changelog-item';
    const verRow = document.createElement('div');
    verRow.className = 'ver-row';
    const ver = document.createElement('span');
    ver.className = 'ver';
    ver.textContent = `v${item.version}`;
    const date = document.createElement('span');
    date.className = 'date';
    date.textContent = item.date;
    verRow.append(ver, date);
    const changes = document.createElement('div');
    changes.className = 'changes';
    const ul = document.createElement('ul');
    for (const c of item.changes) {
      const li = document.createElement('li');
      li.textContent = c;
      ul.appendChild(li);
    }
    changes.appendChild(ul);
    row.append(verRow, changes);
    row.addEventListener('click', () => row.classList.toggle('expanded'));
    listEl.appendChild(row);
  }
}

// ---------- 待办 ----------
const TODO_COLORS: string[] = ['#E5484D', '#F76B15', '#F5D90A', '#30A46C', '#0091FF'];
type TodoView = 'active' | 'overdue' | 'done' | 'abandoned';
type TodoSortKey = 'priority' | 'dueAt' | 'createdAt';

let todoItems: Todo[] = [];
let todoMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let todoSelectedDate: string | null = null;
let todoView: TodoView = 'active';
/** 表格排序：key + 方向；点击表头切换 */
let todoSortKey: TodoSortKey = 'dueAt';
let todoSortDir: 'asc' | 'desc' = 'asc';
let todoEditingId: string | null = null;
let todoEditPriority: TodoPriority = 3;
/** 删除二次确认：高优先级（P1/P2）第一次点击只进入待确认态 */
let todoDeleteArmed = false;
let todoDeleteTimer: number | undefined;

function pad2(n: number): string {
  return `${n}`.padStart(2, '0');
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function todoColor(priority: number): string {
  return TODO_COLORS[Math.min(Math.max(priority, 1), 5) - 1] ?? '#F5D90A';
}

function formatTodoTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (dateKey(d) === dateKey(now)) return `今天 ${hm}`;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (dateKey(d) === dateKey(tomorrow)) return `明天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function todoBuckets(): { active: Todo[]; overdue: Todo[]; done: Todo[]; abandoned: Todo[] } {
  const now = Date.now();
  const active: Todo[] = [];
  const overdue: Todo[] = [];
  const done: Todo[] = [];
  const abandoned: Todo[] = [];
  for (const t of todoItems) {
    if (t.status === 'abandoned') abandoned.push(t);
    else if (t.status === 'closed') done.push(t);
    else if (new Date(t.dueAt).getTime() < now) overdue.push(t);
    else active.push(t);
  }
  active.sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
  overdue.sort((a, b) => new Date(b.dueAt).getTime() - new Date(a.dueAt).getTime());
  done.sort((a, b) => new Date(b.closedAt ?? b.updatedAt).getTime() - new Date(a.closedAt ?? a.updatedAt).getTime());
  abandoned.sort((a, b) => new Date(b.closedAt ?? b.updatedAt).getTime() - new Date(a.closedAt ?? a.updatedAt).getTime());
  return { active, overdue, done, abandoned };
}

/** 点击表头按 key 排序：同 key 翻转方向，新 key 默认升序 */
function setTodoSort(key: TodoSortKey): void {
  if (todoSortKey === key) {
    todoSortDir = todoSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    todoSortKey = key;
    todoSortDir = 'asc';
  }
  renderTodoList();
}

function sortTodoItems(items: Todo[]): Todo[] {
  const dir = todoSortDir === 'asc' ? 1 : -1;
  const cmp: Record<TodoSortKey, (a: Todo, b: Todo) => number> = {
    priority: (a, b) => a.priority - b.priority,
    dueAt: (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime(),
    createdAt: (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  };
  return [...items].sort((a, b) => cmp[todoSortKey]!(a, b) * dir);
}

function formatMinutes(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

/** 过期时长：分钟 → 小时 → 天（向上取整），例：已过期 3 小时 */
function formatOverdueDuration(dueAt: string): string {
  const diffMs = Date.now() - new Date(dueAt).getTime();
  const minutes = Math.max(1, Math.ceil(diffMs / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 1440) return `${Math.ceil(minutes / 60)} 小时`;
  return `${Math.ceil(minutes / 1440)} 天`;
}

function renderTodoCalendar(): void {
  const titleEl = document.getElementById('todo-cal-title');
  const daysEl = document.getElementById('todo-cal-days');
  if (!titleEl || !daysEl) return;
  const year = todoMonth.getFullYear();
  const month = todoMonth.getMonth();
  titleEl.textContent = `${year}年${month + 1}月`;
  daysEl.replaceChildren();

  const counts = new Map<string, Todo[]>();
  for (const t of todoItems) {
    if (t.status === 'closed') continue;
    const key = dateKey(new Date(t.dueAt));
    const list = counts.get(key) ?? [];
    list.push(t);
    counts.set(key, list);
  }

  const startOffset = new Date(year, month, 1).getDay(); // 周日开头
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const total = Math.ceil((startOffset + daysInMonth) / 7) * 7;
  const todayKey = dateKey(new Date());

  for (let i = 0; i < total; i += 1) {
    const dayNumber = i - startOffset + 1;
    const cell = document.createElement('div');
    cell.className = 'cal-day';
    if (dayNumber < 1 || dayNumber > daysInMonth) {
      cell.classList.add('other-month');
      cell.textContent = `${new Date(year, month, dayNumber).getDate()}`;
      daysEl.appendChild(cell);
      continue;
    }
    const date = new Date(year, month, dayNumber);
    const key = dateKey(date);
    cell.classList.add('todo-day');
    if (key === todayKey) cell.classList.add('today');
    if (key === todoSelectedDate) cell.classList.add('selected');
    cell.textContent = `${dayNumber}`;
    const list = counts.get(key);
    if (list && list.length) {
      cell.classList.add('has-event');
      const dots = document.createElement('div');
      dots.className = 'todo-dots';
      for (const t of [...list].sort((a, b) => a.priority - b.priority).slice(0, 3)) {
        const dot = document.createElement('span');
        dot.className = 'todo-dot';
        dot.style.background = todoColor(t.priority);
        dots.appendChild(dot);
      }
      cell.appendChild(dots);
    }
    cell.addEventListener('click', () => {
      todoSelectedDate = todoSelectedDate === key ? null : key;
      renderTodoCalendar();
      renderTodoList();
    });
    daysEl.appendChild(cell);
  }
}

function renderTodoList(): void {
  const listEl = document.getElementById('todo-list');
  const emptyEl = document.getElementById('todo-empty');
  if (!listEl || !emptyEl) return;
  const buckets = todoBuckets();
  const counts: Record<TodoView, number> = {
    active: buckets.active.length,
    overdue: buckets.overdue.length,
    done: buckets.done.length,
    abandoned: buckets.abandoned.length,
  };
  const countEls: Record<TodoView, string | null> = {
    active: 'todo-count-active',
    overdue: 'todo-count-overdue',
    done: 'todo-count-done',
    abandoned: 'todo-count-abandoned',
  };
  (Object.keys(counts) as TodoView[]).forEach((view) => {
    const el = document.getElementById(countEls[view]!);
    if (el) el.textContent = `${counts[view]}`;
  });

  // 所有 tab 均显示所有日期的条目；日历点选仅作高亮不筛选
  let items = buckets[todoView];

  // 表头（排序）
  const header = document.createElement('div');
  header.className = 'todo-table-head';
  const sortArrow = (key: TodoSortKey): string =>
    todoSortKey === key ? (todoSortDir === 'asc' ? ' ↑' : ' ↓') : '';
  const addSortCol = (label: string, key: TodoSortKey, cls: string): void => {
    const col = document.createElement('div');
    col.className = `todo-col ${cls}`;
    col.textContent = `${label}${sortArrow(key)}`;
    col.addEventListener('click', () => setTodoSort(key));
    header.appendChild(col);
  };
  addSortCol('优先级', 'priority', 'col-priority');
  const titleCol = document.createElement('div');
  titleCol.className = 'todo-col col-title';
  titleCol.textContent = '标题';
  header.appendChild(titleCol);
  addSortCol('到期时间', 'dueAt', 'col-due');
  addSortCol('创建时间', 'createdAt', 'col-created');
  const opCol = document.createElement('div');
  opCol.className = 'todo-col col-actions';
  opCol.textContent = '操作';
  header.appendChild(opCol);
  listEl.replaceChildren(header);

  emptyEl.style.display = items.length ? 'none' : 'block';
  emptyEl.textContent = '暂无待办';
  if (!items.length) return;

  for (const t of sortTodoItems(items)) {
    const row = document.createElement('div');
    row.className = `todo-item${t.status !== 'open' ? ' closed' : ''}`;

    const bar = document.createElement('div');
    bar.className = 'todo-bar';
    bar.style.background = todoColor(t.priority);

    const priorityCol = document.createElement('div');
    priorityCol.className = 'todo-col col-priority';
    const prioTag = document.createElement('span');
    prioTag.className = `todo-prio prio-${t.priority}`;
    prioTag.textContent = `P${t.priority}`;
    prioTag.title = '优先级';
    priorityCol.appendChild(prioTag);

    const body = document.createElement('div');
    body.className = 'todo-body col-title';
    const title = document.createElement('div');
    title.className = 'todo-title';
    title.textContent = t.title;
    body.appendChild(title);

    if (t.content) {
      const content = document.createElement('div');
      content.className = 'todo-content';
      content.textContent = t.content;
      body.appendChild(content);
    }

    const meta = document.createElement('div');
    meta.className = 'todo-meta';
    const overdue = t.status === 'open' && new Date(t.dueAt).getTime() < Date.now();
    const due = document.createElement('span');
    if (overdue) due.className = 'overdue';
    due.textContent = `${overdue ? `⚠ 已过期 ${formatOverdueDuration(t.dueAt)}` : `⏰ ${formatTodoTime(t.dueAt)}`}`;
    meta.appendChild(due);
    if (t.status === 'abandoned' && t.abandonReason) {
      const abandonTag = document.createElement('span');
      abandonTag.className = 'abandon-reason';
      abandonTag.textContent = `🚫 放弃：${t.abandonReason}`;
      meta.appendChild(abandonTag);
    }
    if (t.postponements && t.postponements.length) {
      const postponeTag = document.createElement('span');
      postponeTag.textContent = `↷ 延期 ${t.postponements.length} 次`;
      meta.appendChild(postponeTag);
    }
    body.appendChild(meta);

    if (t.postponements && t.postponements.length) {
      const history = document.createElement('div');
      history.className = 'todo-history';
      const last = t.postponements[t.postponements.length - 1]!;
      history.textContent = `最近一次：${formatTodoTime(last.from)} → ${formatTodoTime(last.to)}（${formatMinutes(last.minutes)}）`;
      body.appendChild(history);
    }

    body.addEventListener('click', () => openTodoEditor(t.id));

    const dueCol = document.createElement('div');
    dueCol.className = 'todo-col col-due';
    dueCol.textContent = formatTodoTime(t.dueAt);
    if (overdue) dueCol.classList.add('overdue');

    const createdCol = document.createElement('div');
    createdCol.className = 'todo-col col-created';
    createdCol.textContent = formatTodoTime(t.createdAt);
    createdCol.title = t.createdAt;

    const actions = document.createElement('div');
    actions.className = 'todo-actions col-actions';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'todo-action';
    toggleBtn.title = t.status === 'open' ? '标记完成' : '重新打开';
    toggleBtn.textContent = t.status === 'open' ? '✓' : '↩';
    toggleBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (t.status === 'open') await window.petAPI?.todos.close(t.id);
      else await window.petAPI?.todos.reopen(t.id);
      await loadTodos();
    });
    actions.appendChild(toggleBtn);

    if (t.status === 'open') {
      const postponeBtn = document.createElement('button');
      postponeBtn.className = 'todo-action';
      postponeBtn.title = '延期';
      postponeBtn.textContent = '↷';
      const menu = document.createElement('div');
      menu.className = 'todo-postpone-menu';
      menu.hidden = true;
      const options: Array<[string, number]> = [['+1 小时', 60], ['+1 天', 1440], ['+7 天', 10080]];
      for (const [label, minutes] of options) {
        const optionBtn = document.createElement('button');
        optionBtn.className = 'todo-postpone-btn';
        optionBtn.textContent = label;
        optionBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await window.petAPI?.todos.postpone(t.id, minutes);
          await loadTodos();
        });
        menu.appendChild(optionBtn);
      }
      postponeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
      });
      actions.append(postponeBtn, menu);
    }

    if (t.status === 'open') {
      const abandonBtn = document.createElement('button');
      abandonBtn.className = 'todo-action';
      abandonBtn.title = '放弃（需填写理由）';
      abandonBtn.textContent = '🚫';
      const abandonMenu = document.createElement('div');
      abandonMenu.className = 'todo-postpone-menu todo-abandon-menu';
      abandonMenu.hidden = true;
      const reasonInput = document.createElement('input');
      reasonInput.type = 'text';
      reasonInput.className = 'todo-abandon-input';
      reasonInput.placeholder = '放弃理由（必填）';
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'todo-postpone-btn';
      confirmBtn.textContent = '确认放弃';
      confirmBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const reason = reasonInput.value.trim();
        if (!reason) {
          reasonInput.focus();
          return;
        }
        abandonMenu.hidden = true;
        await window.petAPI?.todos.abandon(t.id, reason);
        await loadTodos();
      });
      abandonMenu.append(reasonInput, confirmBtn);
      abandonBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        abandonMenu.hidden = !abandonMenu.hidden;
        if (!abandonMenu.hidden) reasonInput.focus();
      });
      actions.append(abandonBtn, abandonMenu);
    }

    row.append(bar, priorityCol, body, dueCol, createdCol, actions);
    listEl.appendChild(row);
  }
}

function renderPriorityPicker(): void {
  const picker = document.getElementById('todo-editor-priority');
  if (!picker) return;
  picker.replaceChildren();
  for (let p = 1; p <= 5; p += 1) {
    const dot = document.createElement('button');
    dot.className = `todo-priority-dot${p === todoEditPriority ? ' active' : ''}`;
    dot.style.background = todoColor(p);
    dot.title = `P${p}`;
    dot.addEventListener('click', () => {
      todoEditPriority = p as TodoPriority;
      renderPriorityPicker();
    });
    picker.appendChild(dot);
  }
}

function openTodoEditor(id: string | null): void {
  const editor = document.getElementById('todo-editor') as HTMLDivElement | null;
  const titleEl = document.getElementById('todo-editor-title') as HTMLInputElement | null;
  const contentEl = document.getElementById('todo-editor-content') as HTMLTextAreaElement | null;
  const dateEl = document.getElementById('todo-editor-date') as HTMLInputElement | null;
  const timeEl = document.getElementById('todo-editor-time') as HTMLInputElement | null;
  const deleteBtn = document.getElementById('todo-editor-delete') as HTMLButtonElement | null;
  if (!editor || !titleEl || !contentEl || !dateEl || !timeEl) return;

  const item = id ? todoItems.find((t) => t.id === id) ?? null : null;
  todoEditingId = item?.id ?? null;
  // 每次打开编辑器都重置删除二次确认状态
  todoDeleteArmed = false;
  if (todoDeleteTimer !== undefined) window.clearTimeout(todoDeleteTimer);
  if (deleteBtn) deleteBtn.textContent = '删除';
  if (item) {
    const due = new Date(item.dueAt);
    titleEl.value = item.title;
    contentEl.value = item.content;
    dateEl.value = dateKey(due);
    timeEl.value = `${pad2(due.getHours())}:${pad2(due.getMinutes())}`;
    todoEditPriority = item.priority;
    if (deleteBtn) deleteBtn.hidden = false;
  } else {
    const base = todoSelectedDate ? new Date(`${todoSelectedDate}T00:00:00`) : new Date();
    const hour = todoSelectedDate ? 9 : Math.min(base.getHours() + 1, 23);
    titleEl.value = '';
    contentEl.value = '';
    dateEl.value = dateKey(base);
    timeEl.value = `${pad2(hour)}:00`;
    todoEditPriority = 3;
    if (deleteBtn) deleteBtn.hidden = true;
  }
  renderPriorityPicker();
  editor.hidden = false;
  titleEl.focus();
  window.setTimeout(() => editor.scrollIntoView({ block: 'end', behavior: 'smooth' }), 50);
}

function closeTodoEditor(): void {
  const editor = document.getElementById('todo-editor') as HTMLDivElement | null;
  if (editor) editor.hidden = true;
  todoEditingId = null;
}

async function saveTodo(): Promise<void> {
  const titleEl = document.getElementById('todo-editor-title') as HTMLInputElement | null;
  const contentEl = document.getElementById('todo-editor-content') as HTMLTextAreaElement | null;
  const dateEl = document.getElementById('todo-editor-date') as HTMLInputElement | null;
  const timeEl = document.getElementById('todo-editor-time') as HTMLInputElement | null;
  if (!titleEl || !contentEl || !dateEl || !timeEl) return;
  const title = titleEl.value.trim();
  if (!title) {
    titleEl.focus();
    return;
  }
  const due = new Date(`${dateEl.value}T${timeEl.value || '09:00'}:00`);
  if (Number.isNaN(due.getTime())) return;
  const payload = {
    title,
    content: contentEl.value.trim(),
    dueAt: due.toISOString(),
    priority: todoEditPriority,
  };
  if (todoEditingId) await window.petAPI?.todos.update(todoEditingId, payload);
  else await window.petAPI?.todos.create(payload);
  closeTodoEditor();
  await loadTodos();
}

function switchToTab(tab: string): void {
  const btn = document.querySelector<HTMLElement>(`.tab-btn[data-tab="${tab}"]`);
  btn?.click();
}

function bindTodoUI(): void {
  document.getElementById('todo-new-btn')?.addEventListener('click', () => openTodoEditor(null));
  document.getElementById('todo-editor-cancel')?.addEventListener('click', closeTodoEditor);
  document.getElementById('todo-editor-save')?.addEventListener('click', () => void saveTodo());
  const deleteBtnEl = document.getElementById('todo-editor-delete') as HTMLButtonElement | null;
  deleteBtnEl?.addEventListener('click', async () => {
    if (!todoEditingId) return;
    const target = todoItems.find((t) => t.id === todoEditingId);
    // P1/P2 是长期跟进的重点，删除要再点一次确认；点「完成」只关闭、不删记录
    if (target && target.priority <= 2 && !todoDeleteArmed) {
      todoDeleteArmed = true;
      deleteBtnEl.textContent = '再点一次删除';
      todoDeleteTimer = window.setTimeout(() => {
        todoDeleteArmed = false;
        deleteBtnEl.textContent = '删除';
      }, 3000);
      return;
    }
    if (todoDeleteTimer !== undefined) window.clearTimeout(todoDeleteTimer);
    todoDeleteArmed = false;
    await window.petAPI?.todos.remove(todoEditingId);
    closeTodoEditor();
    await loadTodos();
  });

  const navButtons: Array<[string, number]> = [['todo-cal-prev', -1], ['todo-cal-next', 1]];
  for (const [id, delta] of navButtons) {
    document.getElementById(id)?.addEventListener('click', () => {
      todoMonth = new Date(todoMonth.getFullYear(), todoMonth.getMonth() + delta, 1);
      renderTodoCalendar();
    });
  }
  document.getElementById('todo-cal-today')?.addEventListener('click', () => {
    const now = new Date();
    todoMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    todoSelectedDate = dateKey(now);
    renderTodoCalendar();
    renderTodoList();
  });

  const tabsEl = document.getElementById('todo-status-tabs');
  tabsEl?.querySelectorAll<HTMLElement>('.todo-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      todoView = (btn.dataset.status as TodoView) ?? 'active';
      tabsEl.querySelectorAll('.todo-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderTodoList();
    });
  });

  window.petAPI?.events.onTodosChanged((todos) => {
    todoItems = todos;
    renderTodoCalendar();
    renderTodoList();
  });
}

async function loadTodos(): Promise<void> {
  todoItems = (await window.petAPI?.todos.list()) ?? [];
  renderTodoCalendar();
  renderTodoList();
}

// Claude 技能（pet-reminder）
async function loadSkillStatus(): Promise<void> {
  const statusEl = document.getElementById('skill-status');
  const installBtn = document.getElementById('skill-install-btn') as HTMLButtonElement | null;
  if (!statusEl) return;
  try {
    const result = await window.petAPI?.skills.check();
    if (!result) {
      statusEl.textContent = '无法检查技能状态';
      return;
    }
    statusEl.textContent = result.message;
    if (installBtn) installBtn.textContent = result.upToDate ? '重新安装' : '安装 / 更新';
  } catch (error) {
    console.error('Failed to check skill status:', error);
    statusEl.textContent = '技能状态检查失败';
  }
}

function setupSkillPanel(): void {
  const keywordBtn = document.getElementById('skill-keyword-btn') as HTMLButtonElement | null;
  const copiedEl = document.getElementById('skill-copied') as HTMLDivElement | null;
  const installBtn = document.getElementById('skill-install-btn') as HTMLButtonElement | null;
  const installStatus = document.getElementById('skill-install-status') as HTMLDivElement | null;
  if (!keywordBtn || !installBtn || !installStatus || !copiedEl) return;

  const EXAMPLE = '小猫咪 帮我 加个会议，今天下午 3 点';

  keywordBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(EXAMPLE);
      copiedEl.style.display = 'block';
      window.setTimeout(() => {
        copiedEl.style.display = 'none';
      }, 3000);
    } catch (error) {
      console.error('Failed to copy keyword example:', error);
    }
  });

  installBtn.addEventListener('click', async () => {
    installBtn.disabled = true;
    installStatus.style.display = 'block';
    installStatus.textContent = '正在安装…';
    try {
      const result = await window.petAPI?.skills.install();
      if (!result) {
        installStatus.textContent = '安装失败：无法调用安装器';
        return;
      }
      installStatus.textContent = result.message;
      installStatus.style.color = result.ok ? 'var(--primary, #ff8a24)' : '#c0392b';
      await loadSkillStatus();
    } catch (error) {
      console.error('Failed to install skill:', error);
      installStatus.textContent = '安装失败：' + (error instanceof Error ? error.message : String(error));
    } finally {
      installBtn.disabled = false;
    }
  });
}

// 初始化
async function init(): Promise<void> {
  setupTabs();
  bindTodoUI();
  // 桌宠旁的箱子点击后打开小屋，直接落到待办页
  window.__TAURI__?.event.listen('todo-box-open', () => switchToTab('todo'));
  renderChangelog();
  await loadTodos();
  const settings = await window.petAPI?.settings.get();
  const profile = getPetProfile(settings?.currentPet ?? PET_PROFILES[0]!.id);
  if (profile) {
    petSpec = profile.spec;
    applyPetIdentity();
  }
  await loadInteractions();
  await loadSettings();
  await loadStats();
  await loadUpdateInfo();
  await loadAnniversaries();
  setupSkillPanel();
  await loadSkillStatus();
}

// 监听宠物切换
window.petAPI?.events.onPetChanged((petId) => {
  const profile = getPetProfile(petId);
  if (profile) {
    petSpec = profile.spec;
    applyPetIdentity();
  }
});

init();
