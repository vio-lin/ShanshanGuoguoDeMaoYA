import type { Todo } from '../../shared/contracts';
import { PET_PROFILES } from '../../pet-profiles';

const box = document.getElementById('todo-box') as HTMLButtonElement | null;
const badge = document.getElementById('todo-box-badge');

// 按当前宠物素材的透明留白比例上报，箱子贴边时 Rust 侧据此收拢视觉间距
async function reportTrim(): Promise<void> {
  try {
    const settings = await window.petAPI?.settings.get();
    const spec = PET_PROFILES.find((p) => p.id === settings?.currentPet)?.spec
      ?? PET_PROFILES[0]?.spec;
    const layout = spec?.layout;
    if (layout) {
      await window.__TAURI__?.core.invoke('set_todo_box_trim', {
        right: layout.trimRightRatio ?? 0,
        left: layout.trimLeftRatio ?? 0,
      });
    }
  } catch (error) {
    console.error('Failed to report box trim:', error);
  }
}
void reportTrim();

function render(todos: Todo[] | undefined): void {
  const open = (todos ?? []).filter((todo) => todo.status === 'open');
  const overdue = open.filter((todo) => new Date(todo.dueAt).getTime() < Date.now());
  if (badge) {
    badge.textContent = `${open.length}`;
    badge.hidden = open.length === 0;
    badge.classList.toggle('alert', overdue.length > 0);
  }
  if (box) {
    box.title = overdue.length
      ? `待办箱子：${open.length} 项未关闭，${overdue.length} 项已过期`
      : `待办箱子：${open.length} 项未关闭`;
  }
}

async function refresh(): Promise<void> {
  try {
    render(await window.petAPI?.todos.list());
  } catch (error) {
    console.error('Failed to load todos:', error);
  }
}

let lastOpenAt = 0;
// 窗口很小，整个窗口区域都当作箱子点击，避免点在边缘透明处没反应
function openDashboard(): void {
  const now = Date.now();
  if (now - lastOpenAt < 400) return;
  lastOpenAt = now;
  void window.__TAURI__?.core.invoke('window_show_dashboard_todo');
}

box?.addEventListener('click', openDashboard);
document.addEventListener('click', openDashboard);

window.petAPI?.events.onTodosChanged((todos) => render(todos));
void refresh();
// 过期状态随时间变化，兜底每分钟刷新一次角标（数据变更仍由事件即时推送）
window.setInterval(() => void refresh(), 60_000);
