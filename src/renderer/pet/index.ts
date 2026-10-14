import type { Anniversary, AnniversaryStatus, PetSpec, StateActivity } from '../../shared/contracts';
import { exceedsDragThreshold } from '../../main/drag';
import { getPetProfile, PET_PROFILES } from '../../pet-profiles';
import { PetStateMachine } from './state-machine';
import './index.css';

const sprite = document.getElementById('pet-sprite') as HTMLImageElement;
const container = document.getElementById('pet-container') as HTMLDivElement;
const feedbackBubble = document.getElementById('feedback-bubble') as HTMLDivElement;

// Chromium 会默认把 img 当作可拖拽内容；桌宠只允许窗口拖拽。
container.addEventListener('dragstart', (event) => event.preventDefault());

// Webpack 在构建时递归收集所有宠物的素材，运行时按当前宠物过滤。
const assetMap = new Map<string, string>();
const assetContext = require.context('../../pets', true, /\.png$/i);
for (const key of assetContext.keys()) {
  assetMap.set(key.replace(/^\.\//, ''), assetContext(key));
}
// 纪念日素材（所有宠物共用）
const anniversaryContext = require.context('../../anniversaries', true, /\.png$/i);
for (const key of anniversaryContext.keys()) {
  assetMap.set(`anniversaries/${key.replace(/^\.\//, '')}`, anniversaryContext(key));
}

let petSpec: PetSpec = PET_PROFILES[0]!.spec;
let petId: string = PET_PROFILES[0]!.id;
let stateMachine = new PetStateMachine(petSpec.states, performance.now());
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let blinkTimer: ReturnType<typeof setTimeout> | null = null;
let animationFrame: number | null = null;

// 水平移动追踪
let moveStart = 0;
let moveDuration = 0;
let moveState: string | null = null;

// 当前命中的纪念日（待机帧替换源）
let activeAnniversary: Anniversary | null = null;

function frameUrl(frame: string): string | undefined {
  return assetMap.get(`${petId}/assets/${frame}`);
}

// 纪念日待机帧 URL：anniversaries/assets/<id>/<frame>
function anniversaryFrameUrl(frame: string): string | undefined {
  if (!activeAnniversary) return undefined;
  return assetMap.get(`anniversaries/assets/${activeAnniversary.id}/${frame}`);
}

// 当前实际用于 idle 的帧：纪念日命中时替换
function currentIdleFrames(): string[] {
  if (activeAnniversary && activeAnniversary.frames.length > 0) {
    return activeAnniversary.frames;
  }
  return petSpec.states.find((state) => state.id === 'idle')?.frames ?? [];
}

// 根据状态解析实际图片 URL（idle 命中纪念日时切换素材源）
function resolveFrame(stateId: string, frame: string): string | undefined {
  if (stateId === 'idle' && activeAnniversary && activeAnniversary.frames.length > 0) {
    return anniversaryFrameUrl(frame);
  }
  return frameUrl(frame);
}

// 呼吸/回弹 CSS 变量按当前宠物 spec 设置
function applyMotionCss(): void {
  const breathing = petSpec.motion.breathing;
  if (breathing.enabled) {
    document.documentElement.style.setProperty('--breath-period', `${breathing.periodMs}ms`);
    document.documentElement.style.setProperty('--breath-scale-x', `${1 + breathing.scaleX}`);
    document.documentElement.style.setProperty('--breath-scale-y', `${1 + breathing.scaleY}`);
  }
  const squash = petSpec.motion.squashStretch;
  document.documentElement.style.setProperty('--squash-duration', `${squash.durationMs}ms`);
  document.documentElement.style.setProperty('--squash-intensity', `${squash.intensity}`);
}

container.dataset.state = stateMachine.currentStateId();

// 挤压回弹
function playSquash(): void {
  if (!petSpec.motion.squashStretch.enabled) return;
  const squash = petSpec.motion.squashStretch;
  document.documentElement.style.setProperty('--squash-duration', `${squash.durationMs}ms`);
  document.documentElement.style.setProperty('--squash-intensity', `${squash.intensity}`);
  sprite.classList.remove('squash');
  void sprite.offsetWidth; // 触发重绘
  sprite.classList.add('squash');
}

// 显示反馈气泡
function showFeedback(text: string): void {
  feedbackBubble.textContent = text;
  feedbackBubble.classList.add('show');
  setTimeout(() => {
    feedbackBubble.classList.remove('show');
  }, 2000);
}

// 切换状态
function setState(stateId: string, durationMs?: number): void {
  if (!stateMachine.start(stateId, performance.now(), durationMs)) return;
  const snapshot = stateMachine.tick(performance.now());
  container.dataset.state = snapshot.stateId;
  let url: string | undefined;
  if (useAnniversaryFrames(snapshot.stateId)) {
    url = anniversaryFrameByIndex(snapshot.frameIndex);
  } else {
    url = resolveFrame(snapshot.stateId, snapshot.frame);
  }
  if (url) sprite.src = url;
  // 记录移动状态开始时间
  if (stateId === 'walk' || stateId === 'stalk') {
    moveStart = performance.now();
    moveDuration = durationMs ?? 4000;
    moveState = stateId;
  } else {
    moveState = null;
  }
}

// 纪念日命中时，哪些状态用节日待机帧（移动类状态用正常素材）
function useAnniversaryFrames(stateId: string): boolean {
  if (!activeAnniversary || activeAnniversary.frames.length === 0) return false;
  // 移动类状态不替换，用正常素材
  const movementStates = ['walk', 'stalk', 'jump'];
  return !movementStates.includes(stateId);
}

// 取节日帧 URL
function anniversaryFrameByIndex(frameIndex: number): string | undefined {
  if (!activeAnniversary) return undefined;
  const frameName = activeAnniversary.frames[frameIndex % activeAnniversary.frames.length];
  return assetMap.get(`anniversaries/assets/${activeAnniversary.id}/${frameName}`);
}

// 动画循环
function animate(timestamp: number): void {
  const snapshot = stateMachine.tick(timestamp);
  container.dataset.state = snapshot.stateId;
  if (snapshot.stateChanged) {
    let url: string | undefined;
    if (useAnniversaryFrames(snapshot.stateId)) {
      url = anniversaryFrameByIndex(snapshot.frameIndex);
    } else {
      url = resolveFrame(snapshot.stateId, snapshot.frame);
    }
    if (url) sprite.src = url;
  }

  let dx = 0, dy = 0, flip = false;

  if (snapshot.stateId === 'jump') {
    // 跳跃：垂直抛物线位移
    const jumpOffsets = [0, 0, -20, -55, -30, 0];
    dy = jumpOffsets[snapshot.frameIndex] ?? 0;
  } else if (snapshot.stateId === 'walk' || snapshot.stateId === 'stalk') {
    // 水平来回移动 + 方向镜像
    const range = snapshot.stateId === 'walk' ? 90 : 50;
    const elapsed = Math.min(timestamp - moveStart, moveDuration);
    const progress = elapsed / moveDuration; // 0 → 1
    if (progress < 0.5) {
      // 前半段向右走
      const p = progress / 0.5;
      dx = p * range;
      flip = false;
    } else {
      // 后半段向左走
      const p = (progress - 0.5) / 0.5;
      dx = range - p * range;
      flip = true;
    }
    // 走路时轻微上下颠簸
    dy = snapshot.frameIndex % 2 === 0 ? -3 : 0;
  }

  // 组合 transform：位移 + 镜像
  if (dx !== 0 || dy !== 0 || flip) {
    const sx = flip ? -1 : 1;
    container.style.transform = `translate(${dx}px, ${dy}px) scaleX(${sx})`;
  } else {
    container.style.transform = '';
  }

  animationFrame = requestAnimationFrame(animate);
}

// 调度空闲事件（眨眼、随机动作）
function scheduleIdleEvents(): void {
  if (blinkTimer) clearTimeout(blinkTimer);
  if (idleTimer) clearTimeout(idleTimer);

  // 随机眨眼
  const blinkDelay = 4000 + Math.random() * 6000;
  blinkTimer = setTimeout(() => {
    if (stateMachine.currentStateId() === 'idle') {
      setState('blink');
    }
    scheduleIdleEvents();
  }, blinkDelay);

  // 随机空闲动作
  const idleMin = petSpec.motion.idleIntervalMs.min;
  const idleMax = petSpec.motion.idleIntervalMs.max;
  const idleDelay = idleMin + Math.random() * (idleMax - idleMin);
  idleTimer = setTimeout(() => {
    // 暂时不实现随机动作，保持 idle
    scheduleIdleEvents();
  }, idleDelay);
}

// 点击事件
container.addEventListener('click', () => {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  playSquash();
  setState('happy');
  scheduleIdleEvents();
});

// 拖拽
let isDragging = false;
let pointerStart = { x: 0, y: 0 };
let activePointerId: number | undefined;
let dragUpdatePending = false;
let suppressNextClick = false;
let dragBegin: Promise<void> | undefined;

container.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || activePointerId !== undefined) return;
  activePointerId = event.pointerId;
  pointerStart = { x: event.clientX, y: event.clientY };
  container.setPointerCapture(event.pointerId);
});

container.addEventListener('pointermove', (event) => {
  if (event.pointerId !== activePointerId) return;
  if (!isDragging && exceedsDragThreshold(pointerStart, { x: event.clientX, y: event.clientY })) {
    isDragging = true;
    dragBegin = window.petAPI?.window.beginDrag() ?? Promise.resolve();
  }
  if (!isDragging) return;
  if (dragUpdatePending) return;
  dragUpdatePending = true;
  requestAnimationFrame(() => {
    void (dragBegin ?? Promise.resolve())
      .then(() => window.petAPI?.window.updateDrag())
      .catch(() => {})
      .finally(() => { dragUpdatePending = false; });
  });
});

function finishPointer(event: PointerEvent): void {
  if (event.pointerId !== activePointerId) return;
  if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
  activePointerId = undefined;
  const dragged = isDragging;
  isDragging = false;
  dragUpdatePending = false;
  if (dragged) {
    suppressNextClick = true;
    void (dragBegin ?? Promise.resolve())
      .then(() => window.petAPI?.window.endDrag())
      .catch(() => {});
  }
  dragBegin = undefined;
}

container.addEventListener('pointerup', finishPointer);
container.addEventListener('pointercancel', finishPointer);

// 右键菜单
container.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.petAPI?.window.showContextMenu().catch(() => {});
});

// 监听状态活动
window.petAPI?.events.onStateActivity((activity: StateActivity) => {
  if (activity.stateId) {
    setState(activity.stateId, activity.durationMs);
    scheduleIdleEvents();
  }
  if (activity.feedback) {
    showFeedback(activity.feedback);
  }
});

// 切换当前宠物（重建状态机并回到 idle）
function switchPet(nextPetId: string): void {
  const profile = getPetProfile(nextPetId);
  if (!profile || profile.id === petId) return;
  petId = profile.id;
  petSpec = profile.spec;
  stateMachine = new PetStateMachine(petSpec.states, performance.now());
  applyMotionCss();
  container.dataset.state = stateMachine.currentStateId();
  const firstFrame = petSpec.states.find((state) => state.id === 'idle')?.frames[0];
  if (firstFrame) {
    const url = resolveFrame('idle', firstFrame);
    if (url) sprite.src = url;
  }
  moveState = null;
  scheduleIdleEvents();
  playSquash();
}

// 纪念日命中变化：替换待机帧源并立刻刷新当前帧
function applyAnniversary(status: AnniversaryStatus): void {
  const next = status.list.find((item) => item.id === status.activeId) ?? null;
  const changed = (next?.id ?? null) !== (activeAnniversary?.id ?? null);
  activeAnniversary = next;
  if (!changed) return;
  // 立即刷新待机画面
  if (stateMachine.currentStateId() === 'idle') {
    const frames = currentIdleFrames();
    const first = frames[0];
    if (first) {
      const url = resolveFrame('idle', first);
      if (url) sprite.src = url;
    }
  }
  if (next?.description) showFeedback(next.description);
}

// 初始化
async function init(): Promise<void> {
  try {
    // 先取纪念日状态（命中则待机帧源切换）
    const anniversaryStatus = await window.petAPI?.anniversaries.status();
    if (anniversaryStatus) applyAnniversary(anniversaryStatus);

    const settings = await window.petAPI?.settings.get();
    const profile = getPetProfile(settings?.currentPet ?? PET_PROFILES[0]!.id);
    if (profile && profile.id !== petId) {
      petId = profile.id;
      petSpec = profile.spec;
      stateMachine = new PetStateMachine(petSpec.states, performance.now());
      applyMotionCss();
      container.dataset.state = stateMachine.currentStateId();
    }
    // 所有运行素材必须真实解码成功后才能报告 ready。
    const expectedAssets = [...new Set([petSpec.character.coreAsset, ...petSpec.states.flatMap((state) => state.frames)])];
    const loadedAssets = await Promise.all(expectedAssets.map((name) => new Promise<HTMLImageElement>((resolve, reject) => {
      const url = frameUrl(name);
      if (!url) {
        reject(new Error(`Missing runtime asset: ${name}`));
        return;
      }
      const image = new Image();
      image.onload = () => {
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) reject(new Error(`Runtime asset has invalid dimensions: ${name}`));
        else resolve(image);
      };
      image.onerror = () => reject(new Error(`Runtime asset failed to decode: ${name}`));
      image.src = url;
    })));
    const reference = loadedAssets[0];
    if (!reference) throw new Error('No runtime assets were loaded');
    const invalidSize = loadedAssets.find((image) => image.naturalWidth !== reference.naturalWidth || image.naturalHeight !== reference.naturalHeight);
    if (invalidSize) throw new Error('Runtime assets do not share one decoded frame size');

    // 素材确认可用后再启动 idle 和动画循环。
    setState('idle');
    scheduleIdleEvents();
    animationFrame = requestAnimationFrame(animate);

    // 报告就绪
    await window.petAPI?.runtime.ready({
      status: 'ready',
      stateId: 'idle',
      frame: petSpec.states.find((s) => s.id === 'idle')?.frames[0] ?? '',
      assetCount: loadedAssets.length,
      expectedAssetCount: expectedAssets.length,
      naturalWidth: reference.naturalWidth,
      naturalHeight: reference.naturalHeight,
      petVisible: true,
      ipcReady: true,
    });
  } catch (error) {
    window.petAPI?.runtime.fail({
      message: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
  }
}

// 监听宠物切换
window.petAPI?.events.onPetChanged((nextPetId) => {
  switchPet(nextPetId);
});

// 监听纪念日命中变化
window.petAPI?.events.onAnniversaryChanged((status) => {
  applyAnniversary(status);
});

init();
