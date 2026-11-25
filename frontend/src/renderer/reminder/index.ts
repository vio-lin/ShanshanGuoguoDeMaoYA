import type { PetSpec, Reminder, RepeatRule, Todo } from '../../shared/contracts';
import { getPetProfile, PET_PROFILES } from '../../pet-profiles';
import './index.css';

let petSpec: PetSpec = PET_PROFILES[0]!.spec;

function applyTheme(): void {
  const theme = petSpec.experience.theme;
  document.documentElement.style.setProperty('--primary', theme.primary);
  document.documentElement.style.setProperty('--accent', theme.accent);
  document.documentElement.style.setProperty('--background', theme.background);
  document.documentElement.style.setProperty('--surface', theme.surface);
  document.documentElement.style.setProperty('--text', theme.text);
  document.documentElement.style.setProperty('--muted', theme.muted);
  document.documentElement.style.setProperty('--radius', `${theme.cornerRadius}px`);
}

async function init(): Promise<void> {
  const settings = await window.petAPI?.settings.get();
  const profile = getPetProfile(settings?.currentPet ?? PET_PROFILES[0]!.id);
  if (profile) {
    petSpec = profile.spec;
    applyTheme();
  }
}

const textInput = document.getElementById('reminder-text') as HTMLInputElement;
const timeInput = document.getElementById('reminder-time') as HTMLInputElement;
const repeatSelect = document.getElementById('reminder-repeat') as HTMLSelectElement;
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
const composePanel = document.getElementById('compose-panel') as HTMLElement;
const duePanel = document.getElementById('due-panel') as HTMLElement;
const cardTitle = document.getElementById('card-title') as HTMLElement;
const dueText = document.getElementById('due-text') as HTMLElement;
const dueTime = document.getElementById('due-time') as HTMLElement;
const dismissBtn = document.getElementById('dismiss-btn') as HTMLButtonElement;
const completeBtn = document.getElementById('complete-btn') as HTMLButtonElement;

/** 当前到点提醒 id（用于稍后提醒） */
let dueId: string | null = null;
/** 到点对象类型：旧提醒 or 待办 */
let dueKind: 'reminder' | 'todo' = 'reminder';

/** 编辑模式：新建提醒 */
function showCompose(): void {
  dueId = null;
  dueKind = 'reminder';
  composePanel.style.display = 'block';
  duePanel.style.display = 'none';
  cardTitle.textContent = '⏰ 添加提醒';
}

/** 到点模式：展示提醒内容与稍后提醒入口 */
function showDue(reminder: Reminder): void {
  dueId = reminder.id;
  dueKind = 'reminder';
  completeBtn.style.display = 'none';
  composePanel.style.display = 'none';
  duePanel.style.display = 'block';
  cardTitle.textContent = '⏰ 到点提醒';
  dueText.textContent = reminder.text;
  const repeatTxt =
    reminder.repeat === 'hourly'
      ? ' · 每小时'
      : reminder.repeat === 'daily'
        ? ' · 每天'
        : reminder.repeat === 'weekdays'
          ? ' · 工作日'
          : reminder.repeat === 'weekly'
            ? ' · 每周'
            : '';
  dueTime.textContent = `${new Date(reminder.dueAt).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}${repeatTxt}`;
}

/** 待办到点/过期模式：可完成或延期（延期会被记录进历史） */
function showDueTodo(todo: Todo, overdueDays: number): void {
  dueId = todo.id;
  dueKind = 'todo';
  completeBtn.style.display = 'block';
  composePanel.style.display = 'none';
  duePanel.style.display = 'block';
  cardTitle.textContent = overdueDays > 0 ? `📌 待办已过期 ${overdueDays} 天` : '📌 待办提醒';
  dueText.textContent = todo.content ? `${todo.title}\n${todo.content}` : todo.title;
  dueTime.textContent = `截止 ${new Date(todo.dueAt).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })} · P${todo.priority}`;
}

// 卡片区域按下时拖动整个提醒窗（按钮/输入框/下拉不触发）
const dragCard = document.querySelector<HTMLElement>('.card');
dragCard?.addEventListener('mousedown', (e) => {
  if ((e.target as HTMLElement).closest('button, input, select, a, textarea')) return;
  void window.petAPI?.window.startWindowDrag('reminder');
});

// 设置默认时间为当前时间
function setDefaultTime(): void {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  timeInput.value = `${year}-${month}-${day}T${hours}:${minutes}`;
}

setDefaultTime();

// 保存提醒
saveBtn.addEventListener('click', async () => {
  const text = textInput.value.trim();
  const time = timeInput.value;

  if (!text || !time) {
    return;
  }

  try {
    await window.petAPI?.reminders.save({
      text,
      dueAt: new Date(time).toISOString(),
      repeat: (repeatSelect.value === 'none' ? null : repeatSelect.value) as RepeatRule | null,
    });
    textInput.value = '';
    repeatSelect.value = 'none';
    setDefaultTime();
    await window.petAPI?.window.hideReminder();
  } catch (error) {
    console.error('Failed to save reminder:', error);
  }
});

// 稍后提醒：一次性顺延，重复提醒由后端另建一次性副本；待办走延期并记录历史
document.querySelectorAll<HTMLButtonElement>('.snooze-row button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!dueId) return;
    const minutes = Number(btn.dataset.minutes ?? 10);
    try {
      if (dueKind === 'todo') {
        await window.petAPI?.todos.postpone(dueId, minutes);
        showCompose();
        await window.petAPI?.window.hideReminder();
        return;
      }
      await window.petAPI?.reminders.snooze(dueId, minutes);
      showCompose();
    } catch (error) {
      console.error('Failed to snooze reminder:', error);
    }
  });
});

// 待办完成：直接关闭该待办
completeBtn.addEventListener('click', async () => {
  if (dueId && dueKind === 'todo') {
    try {
      await window.petAPI?.todos.close(dueId);
    } catch (error) {
      console.error('Failed to close todo:', error);
    }
  }
  showCompose();
  await window.petAPI?.window.hideReminder();
});

// 知道了：关闭提醒窗（重复提醒的下一次已由后端排好）
dismissBtn.addEventListener('click', async () => {
  showCompose();
  await window.petAPI?.window.hideReminder();
});

// 取消
cancelBtn.addEventListener('click', async () => {
  textInput.value = '';
  repeatSelect.value = 'none';
  setDefaultTime();
  showCompose();
  await window.petAPI?.window.hideReminder();
});

// 监听提醒触发：切换到到点模式（展示稍后提醒）
window.petAPI?.events.onReminder((reminder: Reminder) => {
  showDue(reminder);
});

// 监听待办到点 / 过期提醒
window.petAPI?.events.onTodoDue(({ todo, overdueDays }) => {
  showDueTodo(todo, overdueDays);
});

// 监听打开提醒编辑器：回到新建模式
window.petAPI?.events.onReminderCompose(() => {
  showCompose();
  setDefaultTime();
  textInput.focus();
});

// 监听宠物切换（主题随宠物变化）
window.petAPI?.events.onPetChanged((petId) => {
  const profile = getPetProfile(petId);
  if (profile) {
    petSpec = profile.spec;
    applyTheme();
  }
});

init();
