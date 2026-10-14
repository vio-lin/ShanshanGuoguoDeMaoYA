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

// 纪念日测试区
async function loadAnniversaries(): Promise<void> {
  const listEl = document.getElementById('anniversary-list') as HTMLDivElement | null;
  const statusEl = document.getElementById('anniversary-status') as HTMLDivElement | null;
  if (!listEl || !statusEl) return;
  const listBox: HTMLDivElement = listEl;
  const statusBox: HTMLDivElement = statusEl;

  function render(status: AnniversaryStatus): void {
    listBox.replaceChildren();
    if (status.list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'setting-desc';
      empty.textContent = '（暂无纪念日，在 src/anniversaries/index.json 添加后重启应用）';
      listBox.appendChild(empty);
    } else {
      for (const item of status.list) {
        const row = document.createElement('div');
        row.className = 'setting-item';
        const isActive = item.id === status.activeId;
        row.style.opacity = isActive ? '1' : '0.75';

        const labelBox = document.createElement('div');
        const label = document.createElement('div');
        label.className = 'setting-label';
        label.textContent = `${item.date}  ${item.title}${isActive ? '  ✓' : ''}`;
        const desc = document.createElement('div');
        desc.className = 'setting-desc';
        desc.textContent = item.description;
        labelBox.append(label, desc);

        const btn = document.createElement('button');
        btn.className = 'update-btn';
        btn.style.padding = '6px 12px';
        btn.style.fontSize = '12px';
        btn.textContent = isActive ? '恢复正常' : '预览';
        btn.addEventListener('click', async () => {
          try {
            const next = isActive ? null : item.date;
            const result = await window.petAPI?.anniversaries.simulate(next);
            if (result) render(result);
          } catch (error) {
            console.error('Failed to simulate anniversary:', error);
          }
        });
        row.append(labelBox, btn);
        listBox.appendChild(row);
      }
    }

    if (status.activeId) {
      const active = status.list.find((item) => item.id === status.activeId);
      statusBox.textContent = status.simulated
        ? `当前为模拟状态：${active?.title ?? ''}（点"恢复正常"回到今天）`
        : `今天命中：${active?.title ?? ''}`;
    } else {
      statusBox.textContent = status.simulated ? '当前为模拟状态：无命中（恢复中）' : '今天无纪念日';
    }
  }

  try {
    const status = await window.petAPI?.anniversaries.status();
    if (status) render(status);
  } catch (error) {
    console.error('Failed to load anniversaries:', error);
  }

  window.petAPI?.events.onAnniversaryChanged((status) => render(status));
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

// 初始化
async function init(): Promise<void> {
  setupTabs();
  renderChangelog();
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
