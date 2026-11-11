import type { Anniversary, AnniversaryStatus, PetSpec, PetStats, Settings, InteractionSpec, UpdateInfo } from '../../shared/contracts';
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
const affectionEl = document.getElementById('affection') as HTMLDivElement;
const moodEl = document.getElementById('mood') as HTMLDivElement;
const todayInteractionsEl = document.getElementById('today-interactions') as HTMLDivElement;
const companionMinutesEl = document.getElementById('companion-minutes') as HTMLDivElement;
const interactionsList = document.getElementById('interactions-list') as HTMLDivElement;
const toggleAlwaysOnTop = document.getElementById('toggle-always-on-top') as HTMLDivElement;
const toggleClickThrough = document.getElementById('toggle-click-through') as HTMLDivElement;
const sizeSelector = document.getElementById('size-selector') as HTMLDivElement;

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

// 待办列表
async function loadTodos(): Promise<void> {
  const listEl = document.getElementById('todo-list');
  const emptyEl = document.getElementById('todo-empty');
  if (!listEl || !emptyEl) return;
  const refresh = async (): Promise<void> => {
    const reminders = await window.petAPI?.reminders.list();
    listEl.replaceChildren();
    if (!reminders || reminders.length === 0) {
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';
    for (const r of reminders) {
      const row = document.createElement('div');
      row.className = 'changelog-item';
      const verRow = document.createElement('div');
      verRow.className = 'ver-row';
      const text = document.createElement('span');
      text.className = 'ver';
      text.textContent = r.text;
      const delBtn = document.createElement('button');
      delBtn.className = 'update-btn';
      delBtn.style.padding = '4px 10px';
      delBtn.style.fontSize = '12px';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await window.petAPI?.reminders.remove(r.id);
          await refresh();
        } catch (err) {
          console.error('Failed to remove reminder:', err);
        }
      });
      verRow.append(text, delBtn);
      const time = document.createElement('div');
      time.className = 'date';
      time.style.marginTop = '4px';
      const due = new Date(r.dueAt);
      const now = new Date();
      const overdue = due < now;
      const leadTxt = typeof r.leadMinutes === 'number' && r.leadMinutes > 0 ? ` · 提前 ${r.leadMinutes} 分钟` : '';
      time.textContent = `${overdue ? '⚠️ 已过期 · ' : '⏰ '}${due.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${leadTxt}`;
      row.append(verRow, time);
      listEl.appendChild(row);
    }
  };
  await refresh();
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
