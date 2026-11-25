use axum::{
    extract::{Path as AxumPath, State as AxumState},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use chrono::Datelike;
use serde::{Deserialize, Serialize};
use serde::de::DeserializeOwned;
use std::collections::HashMap;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent},
    Emitter, Manager, State,
};
use tauri_plugin_notification::NotificationExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    edge_snap: bool,
    always_on_top: bool,
    typing_reaction: bool,
    click_through: bool,
    pet_scale: f64,
    current_pet: String,
    /// 待办箱子与桌宠的水平间距（点）；0 = 紧贴
    #[serde(default = "default_todo_box_gap")]
    todo_box_gap: f64,
}

fn default_todo_box_gap() -> f64 {
    2.0
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            edge_snap: true,
            always_on_top: true,
            typing_reaction: true,
            click_through: false,
            pet_scale: 1.0,
            current_pet: "ragdoll".to_string(),
            todo_box_gap: default_todo_box_gap(),
        }
    }
}

fn settings_path(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("settings.json")
}

/// 桌宠基础窗口边长（px，对齐 pet-spec experience.petSizing.baseWindowPx）
const BASE_PET_WINDOW_PX: f64 = 220.0;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct SavedPosition {
    x: i32,
    y: i32,
}

fn position_path(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("window-position.json")
}

/// 坐标是否落在任一显示器的可视区域内（避免外接屏拔掉后桌宠跑到屏幕外）
fn position_visible(app: &tauri::AppHandle, x: i32, y: i32) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return false;
    };
    monitors.iter().any(|m| {
        let p = m.position();
        let s = m.size();
        x >= p.x && x < p.x + s.width as i32 && y >= p.y && y < p.y + s.height as i32
    })
}

/// 把桌宠当前坐标落盘（移动事件节流后调用）
fn save_window_position(app: &tauri::AppHandle) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let Ok(pos) = pet.outer_position() else {
        return;
    };
    let path = position_path(app);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string(&SavedPosition { x: pos.x, y: pos.y }) {
        let _ = fs::write(&path, content);
    }
}

/// 启动时恢复上次坐标；文件缺失或坐标不在可见屏幕内则保持默认位置
fn restore_window_position(app: &tauri::AppHandle) {
    let Ok(content) = fs::read_to_string(position_path(app)) else {
        return;
    };
    let Ok(saved) = serde_json::from_str::<SavedPosition>(&content) else {
        return;
    };
    if !position_visible(app, saved.x, saved.y) {
        return;
    }
    if let Some(pet) = app.get_webview_window("pet") {
        let _ = pet.set_position(tauri::PhysicalPosition::new(saved.x, saved.y));
    }
}

/// 桌宠旁边的待办箱子窗口：尺寸与贴边间距（物理像素）
const TODO_BOX_SIZE: f64 = 60.0;
/// 箱子间距上限（点），防止配置过大把箱子推出屏幕
const TODO_BOX_GAP_MAX_PT: f64 = 48.0;

/// 把箱子窗口贴到桌宠窗口右侧；右侧空间不足时翻到左侧，并夹在当前显示器可见区域内
fn position_todo_box(app: &tauri::AppHandle) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let Some(box_win) = app.get_webview_window("todo-box") else {
        return;
    };
    let (Ok(pet_pos), Ok(pet_size), Ok(box_size)) =
        (pet.outer_position(), pet.outer_size(), box_win.outer_size())
    else {
        return;
    };

    let box_w = box_size.width as i32;
    let box_h = box_size.height as i32;
    let gap_pt = get_settings(app.clone())
        .todo_box_gap
        .clamp(0.0, TODO_BOX_GAP_MAX_PT);
    let gap = (gap_pt * pet.scale_factor().unwrap_or(1.0)).round() as i32;
    // 素材画布左右各有约 20% 透明留白，贴边时按留白比例收拢视觉间距
    let (trim_right, trim_left) = *BOX_TRIM.lock().unwrap_or_else(|e| e.into_inner());
    let pet_w = pet_size.width as i32;
    let trim_right_px = ((trim_right.clamp(0.0, 0.45) * pet_w as f64).round()) as i32;
    let trim_left_px = ((trim_left.clamp(0.0, 0.45) * pet_w as f64).round()) as i32;
    let mut x = pet_pos.x + pet_w + gap - trim_right_px;
    let mut y = pet_pos.y + pet_size.height as i32 - box_h;

    if let Ok(Some(monitor)) = pet.current_monitor() {
        let mp = monitor.position();
        let ms = monitor.size();
        let min_x = mp.x;
        let max_x = mp.x + ms.width as i32 - box_w;
        let min_y = mp.y;
        let max_y = mp.y + ms.height as i32 - box_h;
        // 右侧放不下就翻到左侧
        if x > max_x {
            x = pet_pos.x - box_w - gap + trim_left_px;
        }
        x = x.clamp(min_x, max_x.max(min_x));
        y = y.clamp(min_y, max_y.max(min_y));
    }

    let _ = box_win.set_position(tauri::PhysicalPosition::new(x, y));
}

/// 显示/隐藏桌宠时同步箱子窗口（箱子跟着桌宠一起出现或收起）
fn set_pet_visible(app: &tauri::AppHandle, visible: bool) {
    if let Some(win) = app.get_webview_window("pet") {
        if visible {
            let _ = win.show();
            let _ = win.set_focus();
        } else {
            let _ = win.hide();
        }
    }
    if let Some(box_win) = app.get_webview_window("todo-box") {
        if visible {
            position_todo_box(app);
            let _ = box_win.show();
        } else {
            let _ = box_win.hide();
        }
    }
}

/// 把设置应用到桌宠主窗口：置顶、鼠标穿透、按缩放调整窗口大小
fn apply_pet_settings(app: &tauri::AppHandle, settings: &Settings) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let _ = pet.set_always_on_top(settings.always_on_top);
    let _ = pet.set_ignore_cursor_events(settings.click_through);
    let side = (BASE_PET_WINDOW_PX * settings.pet_scale).round() as f64;
    let _ = pet.set_size(tauri::LogicalSize::new(side, side));
}

/// 跨命令 / bridge 共享的运行时状态
#[derive(Default)]
struct SharedState {
    /// 提醒到点定时器：reminder id -> 任务句柄
    reminder_timers: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    /// 待办到点定时器：todo id -> 任务句柄（到期后按天续排，直到关闭）
    todo_timers: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    /// 纪念日模拟日期 MM-DD（None = 按真实今天匹配）
    anniversary_sim: Mutex<Option<String>>,
    /// agent 事件去重：(key, 投递时刻)
    last_agent: Mutex<Option<(String, Instant)>>,
    /// 本次会话陪伴计时基准（每次持久化 stats 后重置）
    session_started: Mutex<Option<Instant>>,
    /// 更新检查缓存：(时刻, 结果)，5 分钟内复用；失败不缓存
    update_cache: Mutex<Option<(Instant, Option<UpdateInfo>)>>,
    /// 窗口位置写入节流：上次落盘时刻
    last_position_save: Mutex<Option<Instant>>,
    /// 箱子窗口位置跟随节流：上次同步时刻
    last_box_move: Mutex<Option<Instant>>,
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> Settings {
    let path = settings_path(&app);
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(s) = serde_json::from_str::<Settings>(&content) {
            return s;
        }
    }
    Settings::default()
}

#[tauri::command]
fn update_settings(app: tauri::AppHandle, patch: serde_json::Value) -> Settings {
    let mut current = get_settings(app.clone());
    let mut json = serde_json::to_value(&current).unwrap();
    if let Some(obj) = json.as_object_mut() {
        if let Some(patch_obj) = patch.as_object() {
            for (k, v) in patch_obj {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    current = serde_json::from_value(json).unwrap_or_default();

    let path = settings_path(&app);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(&current) {
        let _ = fs::write(&path, content);
    }
    apply_pet_settings(&app, &current);
    position_todo_box(&app);
    current
}

#[tauri::command]
fn autostart_get(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())?;
    } else {
        manager.disable().map_err(|e| e.to_string())?;
    }
    manager.is_enabled().map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetProfile {
    id: String,
    display_name: String,
}

#[tauri::command]
fn pets_list() -> Vec<PetProfile> {
    vec![
        PetProfile { id: "ragdoll".to_string(), display_name: "哈哈".to_string() },
        PetProfile { id: "nini".to_string(), display_name: "妮妮".to_string() },
    ]
}

fn tray_image_for(pet_id: &str) -> tauri::image::Image<'static> {
    let bytes: &[u8] = match pet_id {
        "nini" => include_bytes!("../../src/pets/nini/tray/tray-icon.png"),
        _ => include_bytes!("../../src/pets/ragdoll/tray/tray-icon.png"),
    };
    tauri::image::Image::from_bytes(bytes).expect("tray icon decode")
}

fn pet_display_name(id: &str) -> &'static str {
    match id {
        "nini" => "妮妮",
        _ => "哈哈",
    }
}

/// 切换宠物子菜单项文案：当前宠物带 ✓ 标记
fn pet_label(id: &str, current: &str) -> String {
    let name = pet_display_name(id);
    if id == current {
        format!("{} ✓", name)
    } else {
        name.to_string()
    }
}

/// 按当前宠物构建托盘菜单（文案随当前宠物动态生成）
fn build_tray_menu(
    app: &tauri::AppHandle,
    current: &str,
) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(
        app,
        "tray-show",
        format!("🐾 显示{}", pet_display_name(current)),
        true,
        None::<&str>,
    )?;
    let dashboard = MenuItem::with_id(
        app,
        "tray-dashboard",
        format!("🏠 {}的小屋", pet_display_name(current)),
        true,
        None::<&str>,
    )?;
    let pet_ragdoll = MenuItem::with_id(
        app,
        "pet-ragdoll",
        pet_label("ragdoll", current),
        true,
        None::<&str>,
    )?;
    let pet_nini = MenuItem::with_id(
        app,
        "pet-nini",
        pet_label("nini", current),
        true,
        None::<&str>,
    )?;
    let pets_submenu = Submenu::with_id(app, "tray-pets", "🐾 切换宠物", true)?;
    pets_submenu.append_items(&[&pet_ragdoll, &pet_nini])?;
    let clickthrough_label = if get_settings(app.clone()).click_through {
        "🖱️ 关闭鼠标穿透"
    } else {
        "🖱️ 开启鼠标穿透"
    };
    let clickthrough = MenuItem::with_id(app, "tray-clickthrough", clickthrough_label, true, None::<&str>)?;
    let update = MenuItem::with_id(app, "tray-update", "🔄 检查更新", true, None::<&str>)?;
    let sep = tauri::menu::PredefinedMenuItem::separator(app)?;
    let tray_quit = MenuItem::with_id(app, "tray-quit", "🚪 退出", true, None::<&str>)?;
    Menu::with_items(app, &[
        &show,
        &dashboard,
        &pets_submenu,
        &clickthrough,
        &update,
        &sep,
        &tray_quit,
    ])
}

fn activate_pet(app: &tauri::AppHandle, pet_id: &str) {
    eprintln!("[pet] activate_pet -> {}", pet_id);
    let mut current = get_settings(app.clone());
    current.current_pet = pet_id.to_string();
    let path = settings_path(app);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(&current) {
        let _ = fs::write(&path, content);
    }
    let _ = app.emit_to("pet", "pet-changed", pet_id.to_string());
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_icon(Some(tray_image_for(pet_id)));
        let _ = tray.set_tooltip(Some(pet_display_name(pet_id).to_string()));
        if let Ok(menu) = build_tray_menu(app, pet_id) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

#[tauri::command]
fn pets_activate(app: tauri::AppHandle, pet_id: String) -> bool {
    activate_pet(&app, &pet_id);
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reminder {
    id: String,
    text: String,
    due_at: String,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    lead_minutes: Option<u32>,
    /// 重复规则：hourly / daily / weekdays / weekly；缺省 = 一次性
    #[serde(skip_serializing_if = "Option::is_none")]
    repeat: Option<String>,
}

/// 一次延期记录（谁把 dueAt 从哪挪到哪）
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Postponement {
    from: String,
    to: String,
    at: String,
    minutes: u32,
}

fn default_priority() -> u8 {
    3
}

fn default_todo_status() -> String {
    "open".to_string()
}

/// 待办任务：与 Reminder 分开存，但复用同一套到点提醒通道。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Todo {
    id: String,
    /// 标题：列表主行，1–80 字
    title: String,
    #[serde(default)]
    /// 正文：可选，≤2000 字
    content: String,
    /// 精确到分的 RFC3339 时间
    due_at: String,
    /// 1–5，1 最高（红/橙/黄/绿/蓝）
    #[serde(default = "default_priority")]
    priority: u8,
    /// open / closed / abandoned
    #[serde(default = "default_todo_status")]
    status: String,
    created_at: String,
    updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    closed_at: Option<String>,
    /// 放弃理由：仅 status = abandoned 时存在
    #[serde(default, skip_serializing_if = "Option::is_none")]
    abandon_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    postponements: Vec<Postponement>,
    /// 迁移来源标记，例如 reminder-migration
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

/// 只接受白名单内的重复规则
fn normalize_repeat(v: Option<&str>) -> Option<String> {
    match v {
        Some("hourly") | Some("daily") | Some("weekdays") | Some("weekly") => {
            v.map(|s| s.to_string())
        }
        _ => None,
    }
}

fn reminders_path(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("reminders.json")
}

#[tauri::command]
fn reminders_list(app: tauri::AppHandle) -> Vec<Reminder> {
    let path = reminders_path(&app);
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(list) = serde_json::from_str::<Vec<Reminder>>(&content) {
            return list;
        }
    }
    vec![]
}

fn build_reminder(input: &serde_json::Value) -> Reminder {
    let lead = input["leadMinutes"].as_u64().map(|v| v as u32);
    Reminder {
        id: uuid::Uuid::new_v4().to_string(),
        text: input["text"].as_str().unwrap_or("").trim().to_string(),
        due_at: input["dueAt"].as_str().unwrap_or("").to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        lead_minutes: lead.filter(|&m| m > 0 && m <= 1440),
        repeat: normalize_repeat(input["repeat"].as_str()),
    }
}

fn persist_reminders(app: &tauri::AppHandle, list: &[Reminder]) {
    let path = reminders_path(app);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(&list) {
        let _ = fs::write(&path, content);
    }
}

/// 发送一条桌面系统横幅通知（失败静默，不影响主流程）
fn send_system_notification(app: &tauri::AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// 按重复规则推进到下一次；daily/weekly 单步，weekdays 跳过周末，hourly 加一小时
fn next_occurrence(
    current: chrono::DateTime<chrono::FixedOffset>,
    repeat: &str,
) -> chrono::DateTime<chrono::FixedOffset> {
    use chrono::Datelike;
    match repeat {
        "hourly" => current + chrono::Duration::hours(1),
        "weekly" => current + chrono::Duration::weeks(1),
        "weekdays" => {
            let mut next = current + chrono::Duration::days(1);
            while next.weekday().number_from_monday() > 5 {
                next += chrono::Duration::days(1);
            }
            next
        }
        _ => current + chrono::Duration::days(1),
    }
}

/// 重复提醒触发后：把 dueAt 推进到下一次（跳过已错过的周期）并重新排定时器
fn advance_reminder(app: &tauri::AppHandle, fired: &Reminder) {
    let Some(repeat) = fired.repeat.as_deref() else {
        return;
    };
    let Ok(mut next) = chrono::DateTime::parse_from_rfc3339(&fired.due_at) else {
        return;
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    let lead_ms = fired.lead_minutes.unwrap_or(0) as i64 * 60_000;
    // 触发时刻 = due - lead，必须晚于当前，避免休眠/关机后连环补发
    loop {
        next = next_occurrence(next, repeat);
        if next.timestamp_millis() - lead_ms > now_ms {
            break;
        }
    }

    let mut list = reminders_list(app.clone());
    let Some(item) = list.iter_mut().find(|r| r.id == fired.id) else {
        return;
    };
    item.due_at = next.to_rfc3339();
    let updated = item.clone();
    persist_reminders(app, &list);

    let shared = app.state::<SharedState>();
    spawn_reminder_timer(app, shared.inner(), updated);
}

/// 创建到点定时器（不清理同 id 旧句柄，用于重复提醒自我续排）
fn spawn_reminder_timer(app: &tauri::AppHandle, shared: &SharedState, reminder: Reminder) {
    let Ok(due) = chrono::DateTime::parse_from_rfc3339(&reminder.due_at) else {
        return;
    };
    let lead_ms = reminder.lead_minutes.unwrap_or(0) as i64 * 60_000;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let delay_ms = (due.timestamp_millis() - lead_ms - now_ms).max(0);

    let reminder_id = reminder.id.clone();
    let app = app.clone();
    let reminder_task = reminder.clone();
    let handle = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay_ms as u64)).await;
        eprintln!("[reminder] due -> {}", reminder_task.text);
        send_system_notification(&app, "提醒", &reminder_task.text);
        let _ = app.emit_to("reminder", "reminder-due", &reminder_task);
        if let Some(w) = app.get_webview_window("reminder") {
            let _ = w.show();
            let _ = w.set_focus();
        }
        let _ = app.emit_to(
            "pet",
            "state-activity",
            serde_json::json!({
                "kind": "notify",
                "stateId": "notify",
                "durationMs": 1800,
                "feedback": reminder_task.text,
            }),
        );
        advance_reminder(&app, &reminder_task);
    });
    shared
        .reminder_timers
        .lock()
        .unwrap()
        .insert(reminder_id, handle);
}

/// 为提醒排到点定时器：到点弹出提醒窗并触发 notify 动作
fn schedule_reminder(app: &tauri::AppHandle, shared: &SharedState, reminder: Reminder) {
    if let Some(old) = shared.reminder_timers.lock().unwrap().remove(&reminder.id) {
        old.abort();
    }
    spawn_reminder_timer(app, shared, reminder);
}

fn unschedule_reminder(shared: &SharedState, id: &str) {
    if let Some(old) = shared.reminder_timers.lock().unwrap().remove(id) {
        old.abort();
    }
}

// ---------- 待办 ----------

fn todos_path(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("todos.json")
}

fn read_todos(app: &tauri::AppHandle) -> Vec<Todo> {
    let path = todos_path(app);
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(list) = serde_json::from_str::<Vec<Todo>>(&content) {
            return list;
        }
    }
    vec![]
}

fn persist_todos(app: &tauri::AppHandle, list: &[Todo]) {
    let path = todos_path(app);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(&list) {
        let _ = fs::write(&path, content);
    }
}

/// 时间统一精确到分：秒和纳秒归零
fn normalize_minute(value: &str) -> Option<String> {
    use chrono::Timelike;
    let dt = chrono::DateTime::parse_from_rfc3339(value).ok()?;
    let dt = dt.with_second(0)?.with_nanosecond(0)?;
    Some(dt.to_rfc3339())
}

fn clamp_priority(value: Option<u64>) -> u8 {
    value.unwrap_or(3).clamp(1, 5) as u8
}

fn trim_chars(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

fn build_todo(input: &serde_json::Value) -> Option<Todo> {
    let title = trim_chars(input["title"].as_str().unwrap_or(""), 80);
    if title.is_empty() {
        return None;
    }
    let due_at = normalize_minute(input["dueAt"].as_str().unwrap_or(""))?;
    let now = chrono::Utc::now().to_rfc3339();
    Some(Todo {
        id: uuid::Uuid::new_v4().to_string(),
        title,
        content: trim_chars(input["content"].as_str().unwrap_or(""), 2000),
        due_at,
        priority: clamp_priority(input["priority"].as_u64()),
        status: "open".to_string(),
        created_at: now.clone(),
        updated_at: now,
        closed_at: None,
        abandon_reason: None,
        postponements: Vec::new(),
        source: input["source"].as_str().map(|s| s.to_string()),
    })
}

fn emit_todos_changed(app: &tauri::AppHandle) {
    let _ = app.emit("todos-changed", read_todos(app));
}

fn overdue_days(due_at: &str) -> i64 {
    let Ok(due) = chrono::DateTime::parse_from_rfc3339(due_at) else {
        return 0;
    };
    let diff = chrono::Utc::now().timestamp_millis() - due.timestamp_millis();
    if diff <= 0 {
        0
    } else {
        diff / 86_400_000
    }
}

/// 下次提醒时刻：未到期取 dueAt；已过期取今天/明天的同一时分，直到关闭
fn next_todo_fire(due_at: &str, now_ms: i64) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    let due = chrono::DateTime::parse_from_rfc3339(due_at).ok()?;
    if due.timestamp_millis() > now_ms {
        return Some(due);
    }
    let mut next = due;
    while next.timestamp_millis() <= now_ms {
        next += chrono::Duration::days(1);
    }
    Some(next)
}

fn unschedule_todo(shared: &SharedState, id: &str) {
    if let Some(old) = shared.todo_timers.lock().unwrap().remove(id) {
        old.abort();
    }
}

fn schedule_todo(app: &tauri::AppHandle, shared: &SharedState, todo: &Todo) {
    unschedule_todo(shared, &todo.id);
    if todo.status != "open" {
        return;
    }
    let id = todo.id.clone();
    let app_handle = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        loop {
            let list = read_todos(&app_handle);
            let Some(current) = list.into_iter().find(|item| item.id == id) else {
                break;
            };
            if current.status != "open" {
                break;
            }
            let now_ms = chrono::Utc::now().timestamp_millis();
            let Some(fire) = next_todo_fire(&current.due_at, now_ms) else {
                break;
            };
            let delay_ms = (fire.timestamp_millis() - now_ms).max(0) as u64;
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;

            // 睡眠期间可能被关闭或改期，触发前重新读取
            let list = read_todos(&app_handle);
            let Some(latest) = list.into_iter().find(|item| item.id == id) else {
                break;
            };
            if latest.status != "open" {
                break;
            }
            let days = overdue_days(&latest.due_at);
            let label = if days > 0 { "待办已过期" } else { "待办到期" };
            send_system_notification(&app_handle, label, &latest.title);
            let _ = app_handle.emit_to(
                "reminder",
                "todo-due",
                serde_json::json!({ "todo": &latest, "overdueDays": days }),
            );
            if let Some(window) = app_handle.get_webview_window("reminder") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app_handle.emit_to(
                "pet",
                "state-activity",
                serde_json::json!({
                    "kind": "notify",
                    "stateId": "notify",
                    "durationMs": 1800,
                    "feedback": &latest.title,
                }),
            );
            // 同一分钟内不重复触发；下一轮排到明天同一时分
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
    shared.todo_timers.lock().unwrap().insert(todo.id.clone(), handle);
}

#[tauri::command]
fn todos_list(app: tauri::AppHandle) -> Vec<Todo> {
    read_todos(&app)
}

#[tauri::command]
fn todos_create(
    app: tauri::AppHandle,
    shared: State<SharedState>,
    input: serde_json::Value,
) -> Result<Todo, String> {
    let todo = build_todo(&input).ok_or_else(|| "标题不能为空，时间需为有效的 ISO 时间".to_string())?;
    let mut list = read_todos(&app);
    list.push(todo.clone());
    persist_todos(&app, &list);
    schedule_todo(&app, shared.inner(), &todo);
    emit_todos_changed(&app);
    Ok(todo)
}

#[tauri::command]
fn todos_update(
    app: tauri::AppHandle,
    shared: State<SharedState>,
    id: String,
    patch: serde_json::Value,
) -> Result<Todo, String> {
    let mut list = read_todos(&app);
    let Some(item) = list.iter_mut().find(|todo| todo.id == id) else {
        return Err("待办不存在".to_string());
    };
    if let Some(value) = patch["title"].as_str() {
        let title = trim_chars(value, 80);
        if title.is_empty() {
            return Err("标题不能为空".to_string());
        }
        item.title = title;
    }
    if let Some(value) = patch["content"].as_str() {
        item.content = trim_chars(value, 2000);
    }
    if let Some(value) = patch["dueAt"].as_str() {
        item.due_at = normalize_minute(value).ok_or_else(|| "时间格式无效".to_string())?;
    }
    if let Some(value) = patch["priority"].as_u64() {
        item.priority = clamp_priority(Some(value));
    }
    item.updated_at = chrono::Utc::now().to_rfc3339();
    let updated = item.clone();
    persist_todos(&app, &list);
    schedule_todo(&app, shared.inner(), &updated);
    emit_todos_changed(&app);
    Ok(updated)
}

#[tauri::command]
fn todos_close(app: tauri::AppHandle, shared: State<SharedState>, id: String) -> bool {
    let mut list = read_todos(&app);
    let Some(item) = list.iter_mut().find(|todo| todo.id == id) else {
        return false;
    };
    let now = chrono::Utc::now().to_rfc3339();
    item.status = "closed".to_string();
    item.closed_at = Some(now.clone());
    item.updated_at = now;
    persist_todos(&app, &list);
    unschedule_todo(shared.inner(), &id);
    emit_todos_changed(&app);
    true
}

#[tauri::command]
fn todos_reopen(app: tauri::AppHandle, shared: State<SharedState>, id: String) -> bool {
    let mut list = read_todos(&app);
    let Some(item) = list.iter_mut().find(|todo| todo.id == id) else {
        return false;
    };
    item.status = "open".to_string();
    item.closed_at = None;
    item.abandon_reason = None;
    item.updated_at = chrono::Utc::now().to_rfc3339();
    let reopened = item.clone();
    persist_todos(&app, &list);
    schedule_todo(&app, shared.inner(), &reopened);
    emit_todos_changed(&app);
    true
}

/// 放弃待办：必须填写理由（trim 后非空），理由写入 abandon_reason
#[tauri::command]
fn todos_abandon(
    app: tauri::AppHandle,
    shared: State<SharedState>,
    id: String,
    reason: String,
) -> bool {
    let trimmed = reason.trim().to_string();
    if trimmed.is_empty() {
        return false;
    }
    let mut list = read_todos(&app);
    let Some(item) = list.iter_mut().find(|todo| todo.id == id) else {
        return false;
    };
    let now = chrono::Utc::now().to_rfc3339();
    item.status = "abandoned".to_string();
    item.abandon_reason = Some(trimmed);
    item.closed_at = Some(now.clone());
    item.updated_at = now;
    persist_todos(&app, &list);
    unschedule_todo(shared.inner(), &id);
    emit_todos_changed(&app);
    true
}

#[tauri::command]
fn todos_delete(app: tauri::AppHandle, shared: State<SharedState>, id: String) -> bool {
    let mut list = read_todos(&app);
    let before = list.len();
    list.retain(|todo| todo.id != id);
    if list.len() == before {
        return false;
    }
    persist_todos(&app, &list);
    unschedule_todo(shared.inner(), &id);
    emit_todos_changed(&app);
    true
}

#[tauri::command]
fn todos_postpone(
    app: tauri::AppHandle,
    shared: State<SharedState>,
    id: String,
    minutes: u32,
) -> Result<Todo, String> {
    let minutes = minutes.clamp(1, 720);
    let mut list = read_todos(&app);
    let Some(item) = list.iter_mut().find(|todo| todo.id == id) else {
        return Err("待办不存在".to_string());
    };
    let from = item.due_at.clone();
    let base = chrono::DateTime::parse_from_rfc3339(&from)
        .map_err(|_| "待办时间无效，无法延期".to_string())?;
    let to = (base + chrono::Duration::minutes(minutes as i64)).to_rfc3339();
    let now = chrono::Utc::now().to_rfc3339();
    item.postponements.push(Postponement {
        from: from.clone(),
        to: to.clone(),
        at: now.clone(),
        minutes,
    });
    item.due_at = to;
    item.updated_at = now;
    let updated = item.clone();
    persist_todos(&app, &list);
    schedule_todo(&app, shared.inner(), &updated);
    emit_todos_changed(&app);
    Ok(updated)
}

/// 把旧 reminders.json 一次性转成待办：最低优先级 P5，保留原时间。
/// 转换后备份并清空提醒文件，避免同一件事被两套调度重复提醒。
fn migrate_reminders_to_todos(app: &tauri::AppHandle) -> usize {
    let reminders = reminders_list(app.clone());
    if reminders.is_empty() {
        return 0;
    }
    let mut todos = read_todos(app);
    let now = chrono::Utc::now().to_rfc3339();
    let mut added = 0usize;
    for reminder in reminders {
        let text = reminder.text.trim();
        if text.is_empty() {
            continue;
        }
        let title = trim_chars(text, 80);
        let content = if text.chars().count() > 80 {
            text.to_string()
        } else {
            String::new()
        };
        let due_at = normalize_minute(&reminder.due_at).unwrap_or_else(|| reminder.due_at.clone());
        // 已经迁移过（标题 + 时间一致）则不重复生成
        if todos.iter().any(|todo| todo.title == title && todo.due_at == due_at) {
            continue;
        }
        todos.push(Todo {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            content,
            due_at,
            priority: 5,
            status: "open".to_string(),
            created_at: now.clone(),
            updated_at: now.clone(),
            closed_at: None,
            abandon_reason: None,
            postponements: Vec::new(),
            source: Some("reminder-migration".to_string()),
        });
        added += 1;
    }
    if added > 0 {
        persist_todos(app, &todos);
    }
    // 备份首次迁移前的原始提醒；后续残留写入不覆盖已有备份
    let source = reminders_path(app);
    let backup = source.with_file_name("reminders.pre-todo.json");
    if !backup.exists() {
        let _ = fs::copy(&source, &backup);
    }
    // 无论是否新增都清空旧提醒，避免两套调度重复提醒
    let _ = fs::write(&source, "[]");
    added
}

/// 启动时提示已有过期待办（不弹窗打断，只发一条系统通知）
fn notify_overdue_on_start(app: &tauri::AppHandle) {
    let overdue = read_todos(app)
        .into_iter()
        .filter(|todo| todo.status == "open" && overdue_days(&todo.due_at) > 0)
        .count();
    if overdue > 0 {
        send_system_notification(app, "待办提醒", &format!("有 {overdue} 条待办已过期，记得处理"));
    }
}

#[tauri::command]
fn reminders_save(
    app: tauri::AppHandle,
    shared: State<'_, SharedState>,
    input: serde_json::Value,
) -> Reminder {
    let mut list = reminders_list(app.clone());
    let reminder = build_reminder(&input);
    list.push(reminder.clone());
    persist_reminders(&app, &list);
    schedule_reminder(&app, &shared, reminder.clone());
    reminder
}

#[tauri::command]
fn reminders_remove(app: tauri::AppHandle, id: String) -> bool {
    let shared = app.state::<SharedState>();
    let mut list = reminders_list(app.clone());
    let before = list.len();
    list.retain(|r| r.id != id);
    persist_reminders(&app, &list);
    unschedule_reminder(&shared, &id);
    list.len() < before
}

#[tauri::command]
fn reminders_get(app: tauri::AppHandle, id: String) -> Option<Reminder> {
    reminders_list(app).into_iter().find(|r| r.id == id)
}

/// 稍后提醒：一次性提醒顺延 dueAt；重复提醒另建一次性副本，避免打乱原节奏
#[tauri::command]
fn reminders_snooze(app: tauri::AppHandle, id: String, minutes: u32) -> Result<(), String> {
    let clamped = minutes.clamp(1, 720);
    let when = (chrono::Local::now() + chrono::Duration::minutes(clamped as i64)).to_rfc3339();
    let mut list = reminders_list(app.clone());
    let Some(index) = list.iter().position(|r| r.id == id) else {
        return Err("提醒不存在".to_string());
    };

    let shared = app.state::<SharedState>();
    if list[index].repeat.is_some() {
        let copy = Reminder {
            id: uuid::Uuid::new_v4().to_string(),
            text: list[index].text.clone(),
            due_at: when,
            created_at: chrono::Utc::now().to_rfc3339(),
            lead_minutes: None,
            repeat: None,
        };
        list.push(copy.clone());
        persist_reminders(&app, &list);
        schedule_reminder(&app, shared.inner(), copy);
    } else {
        list[index].due_at = when;
        list[index].lead_minutes = None;
        let updated = list[index].clone();
        persist_reminders(&app, &list);
        schedule_reminder(&app, shared.inner(), updated);
    }

    if let Some(w) = app.get_webview_window("reminder") {
        let _ = w.hide();
    }
    Ok(())
}

#[tauri::command]
fn reminders_update(
    app: tauri::AppHandle,
    id: String,
    input: serde_json::Value,
) -> Result<Reminder, String> {
    let shared = app.state::<SharedState>();
    let mut list = reminders_list(app.clone());
    let Some(index) = list.iter().position(|r| r.id == id) else {
        return Err("提醒不存在".to_string());
    };
    let mut reminder = list[index].clone();

    if let Some(text) = input["text"].as_str() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            reminder.text = trimmed.to_string();
        }
    }
    if let Some(due_at) = input["dueAt"].as_str() {
        if !due_at.is_empty() {
            reminder.due_at = due_at.to_string();
        }
    }
    // leadMinutes 显式传入时才覆盖（含 null/0 清除提前量）
    if input["leadMinutes"].is_number() || input["leadMinutes"].is_null() {
        reminder.lead_minutes = input["leadMinutes"]
            .as_u64()
            .map(|v| v as u32)
            .filter(|&m| m > 0 && m <= 1440);
    }
    // repeat 显式传入时才覆盖（null / "none" = 取消重复）
    if input["repeat"].is_string() || input["repeat"].is_null() {
        reminder.repeat = normalize_repeat(input["repeat"].as_str());
    }

    list[index] = reminder.clone();
    persist_reminders(&app, &list);
    unschedule_reminder(&shared, &id);
    schedule_reminder(&app, &shared, reminder.clone());
    Ok(reminder)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    affection: i32,
    mood: i32,
    today_interactions: i32,
    total_companion_ms: i64,
    last_interaction_date: String,
}

impl Default for Stats {
    fn default() -> Self {
        Self {
            affection: 0,
            mood: 80,
            today_interactions: 0,
            total_companion_ms: 0,
            last_interaction_date: today_key(),
        }
    }
}

/// 面向前端公开的统计（不含内部累计毫秒，附陪伴分钟）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublicStats {
    affection: i32,
    mood: i32,
    today_interactions: i32,
    companion_minutes: i64,
    last_interaction_date: String,
}

fn today_key() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn stats_path(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("pet-stats.json")
}

// ---------- 历史数据迁移（Electron 旧 userData → Tauri 数据目录） ----------
const LEGACY_APP_DIR: &str = "布偶猫桌宠";

fn legacy_app_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let home = app.path().home_dir().ok()?;
    #[cfg(target_os = "macos")]
    {
        let dir = home.join("Library/Application Support").join(LEGACY_APP_DIR);
        return dir.is_dir().then_some(dir);
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").ok()?;
        let dir = PathBuf::from(appdata).join(LEGACY_APP_DIR);
        return dir.is_dir().then_some(dir);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = home;
        None
    }
}

/// 复制单个 JSON 配置：目标已存在且可解析为 T 时保留不覆盖；否则校验源后写入。
fn migrate_json_file<T>(src: &Path, dst: &Path)
where
    T: DeserializeOwned + Serialize,
{
    if !src.is_file() {
        return;
    }
    let source: T = match fs::read_to_string(src) {
        Ok(s) => match serde_json::from_str(&s) {
            Ok(v) => v,
            Err(_) => return,
        },
        Err(_) => return,
    };
    if dst.is_file() {
        if let Ok(cur) = fs::read_to_string(dst) {
            if serde_json::from_str::<T>(&cur).is_ok() {
                return; // 目标已有有效数据，保留不覆盖
            }
        }
    }
    if let Some(parent) = dst.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(&source) {
        let _ = fs::write(dst, content);
    }
}

/// 提醒列表：目标已有非空有效列表时保留；否则迁入旧列表（逐条随解析校验）。
fn migrate_reminders_file(src: &Path, dst: &Path) {
    if !src.is_file() {
        return;
    }
    let source: Vec<Reminder> = match fs::read_to_string(src) {
        Ok(s) => match serde_json::from_str(&s) {
            Ok(v) => v,
            Err(_) => return,
        },
        Err(_) => return,
    };
    let has_existing = match fs::read_to_string(dst) {
        Ok(cur) => serde_json::from_str::<Vec<Reminder>>(&cur)
            .map(|v| !v.is_empty())
            .unwrap_or(false),
        Err(_) => false,
    };
    if has_existing {
        return;
    }
    if let Some(parent) = dst.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(&source) {
        let _ = fs::write(dst, content);
    }
}

fn migrate_legacy_data(app: &tauri::AppHandle) {
    let Some(legacy) = legacy_app_dir(app) else {
        return;
    };
    let target = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    let _ = fs::create_dir_all(&target);
    migrate_json_file::<Settings>(&legacy.join("settings.json"), &target.join("settings.json"));
    migrate_reminders_file(&legacy.join("reminders.json"), &target.join("reminders.json"));
    migrate_json_file::<Stats>(&legacy.join("pet-stats.json"), &target.join("pet-stats.json"));
}

fn read_stats(app: &tauri::AppHandle) -> Stats {
    let path = stats_path(app);
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(s) = serde_json::from_str::<Stats>(&content) {
            return s;
        }
    }
    Stats::default()
}

fn write_stats(app: &tauri::AppHandle, stats: &Stats) {
    let path = stats_path(app);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(stats) {
        let _ = fs::write(&path, content);
    }
}

fn normalize_day(stats: &mut Stats) {
    let today = today_key();
    if stats.last_interaction_date != today {
        stats.today_interactions = 0;
        stats.last_interaction_date = today;
    }
}

fn elapsed_session_ms(app: &tauri::AppHandle) -> i64 {
    let shared = app.state::<SharedState>();
    let base = shared.session_started.lock().unwrap();
    base.map(|t| t.elapsed().as_millis() as i64).unwrap_or(0)
}

fn persist_stats(app: &tauri::AppHandle, stats: &mut Stats) {
    stats.total_companion_ms += elapsed_session_ms(app);
    *app.state::<SharedState>().session_started.lock().unwrap() = Some(Instant::now());
    write_stats(app, stats);
}

fn public_stats(app: &tauri::AppHandle, stats: &Stats) -> PublicStats {
    let live_ms = stats.total_companion_ms + elapsed_session_ms(app);
    PublicStats {
        affection: stats.affection,
        mood: stats.mood,
        today_interactions: stats.today_interactions,
        companion_minutes: live_ms / 60_000,
        last_interaction_date: stats.last_interaction_date.clone(),
    }
}

/// 互动增益（两只宠 spec 一致：walk 3 / jump 5 / stalk 2 / bury 1）
fn interaction_gain(id: &str) -> i32 {
    match id {
        "walk" => 3,
        "jump" => 5,
        "stalk" => 2,
        "bury" => 1,
        _ => 1,
    }
}

fn interaction_duration(id: &str) -> u64 {
    match id {
        "walk" => 4000,
        "jump" => 2500,
        "stalk" => 5000,
        "bury" => 1800,
        _ => 1800,
    }
}

/// 互动反馈文案（两宠 spec 一致）
fn interaction_feedback(id: &str) -> &'static [&'static str] {
    match id {
        "walk" => &["遛弯去咯~", "这边风景不错喵", "散步使猫快乐"],
        "jump" => &["跳高高！", "看我跳得多远", "一蹦三尺高喵"],
        "stalk" => &["悄悄靠近...", "潜行模式开启", "不要被发现了喵"],
        "bury" => &["扒拉扒拉~", "埋好埋好", "本喵很爱干净"],
        _ => &[],
    }
}

fn random_feedback(id: &str) -> String {
    let feedbacks = interaction_feedback(id);
    if feedbacks.is_empty() {
        return String::new();
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    feedbacks[(nanos as usize) % feedbacks.len()].to_string()
}

fn broadcast_stats(app: &tauri::AppHandle, stats: &PublicStats) {
    for win in ["pet", "dashboard", "reminder"] {
        let _ = app.emit_to(win, "pet-stats", stats);
    }
}

#[tauri::command]
fn interactions_stats(app: tauri::AppHandle) -> PublicStats {
    let mut stats = read_stats(&app);
    normalize_day(&mut stats);
    public_stats(&app, &stats)
}

#[tauri::command]
fn interactions_trigger(app: tauri::AppHandle, id: String) -> Result<PublicStats, String> {
    if interaction_feedback(&id).is_empty() {
        return Err(format!("Unknown interaction: {id}"));
    }
    let mut stats = read_stats(&app);
    normalize_day(&mut stats);
    let gain = interaction_gain(&id);
    stats.affection = (stats.affection + gain).min(300);
    let mood_gain = ((gain + 1) / 2).max(1);
    stats.mood = (stats.mood + mood_gain).min(100);
    stats.today_interactions += 1;
    persist_stats(&app, &mut stats);
    let value = public_stats(&app, &stats);
    broadcast_stats(&app, &value);

    // 向桌宠窗口下发动作动画 + 反馈泡泡（对齐原版 sendActivity）
    let feedback = random_feedback(&id);
    let _ = app.emit_to(
        "pet",
        "state-activity",
        serde_json::json!({
            "kind": "interaction",
            "stateId": id,
            "durationMs": interaction_duration(&id),
            "feedback": feedback,
        }),
    );
    Ok(value)
}

// ---------- 窗口控制 ----------
fn show_reminder_composer(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("reminder") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit_to("reminder", "reminder-compose", serde_json::json!({}));
    }
}

#[tauri::command]
fn window_show_reminder(app: tauri::AppHandle) {
    show_reminder_composer(&app);
}

/// 从桌宠旁的箱子打开小屋，并让前端切到待办页
#[tauri::command]
fn window_show_dashboard_todo(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("dashboard") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit_to("dashboard", "todo-box-open", ());
    }
    if let Some(b) = app.get_webview_window("todo-box") {
        let _ = b.hide();
    }
}

#[tauri::command]
fn window_show_dashboard(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("dashboard") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    // 小屋展开时收起桌宠旁的箱子，避免两个浮层叠在一起
    if let Some(b) = app.get_webview_window("todo-box") {
        let _ = b.hide();
    }
}

/// 拖动会话序号：自增即让上一个拖动线程退出
static PET_DRAG_SEQ: AtomicU64 = AtomicU64::new(0);

/// 待办箱子贴边用的素材留白比例（right, left），由箱子渲染器按当前宠物上报
static BOX_TRIM: std::sync::Mutex<(f64, f64)> = std::sync::Mutex::new((0.0, 0.0));

/// 箱子渲染器启动时上报当前宠物素材的左右留白比例，并立即重排
#[tauri::command]
fn set_todo_box_trim(app: tauri::AppHandle, right: f64, left: f64) {
    if let Ok(mut v) = BOX_TRIM.lock() {
        *v = (right, left);
    }
    position_todo_box(&app);
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    /// 全局鼠标按键状态：state 0 = combined session，button 0 = 左键
    fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
}

fn left_button_down() -> bool {
    unsafe { CGEventSourceButtonState(0, 0) }
}

fn move_window_impl(app: &tauri::AppHandle, label: &str, dx: f64, dy: f64) {
    let Some(win) = app.get_webview_window(label) else {
        return;
    };
    let Ok(pos) = win.outer_position() else { return };
    let Ok(size) = win.outer_size() else { return };

    let mut x = pos.x + dx.round() as i32;
    let mut y = pos.y + dy.round() as i32;
    if let Ok(Some(monitor)) = win.current_monitor() {
        let mp = monitor.position();
        let ms = monitor.size();
        x = x.clamp(mp.x, (mp.x + ms.width as i32 - size.width as i32).max(mp.x));
        y = y.clamp(mp.y, (mp.y + ms.height as i32 - size.height as i32).max(mp.y));
    }
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}

/// 拖动桌宠：按指针位移移动窗口（物理像素增量）
#[tauri::command]
fn move_pet_window(app: tauri::AppHandle, dx: f64, dy: f64) {
    move_window_impl(&app, "pet", dx, dy);
}

/// 拖动通用窗口：按指针位移移动指定窗口（物理像素增量）
#[tauri::command]
fn move_window(app: tauri::AppHandle, label: String, dx: f64, dy: f64) {
    move_window_impl(&app, &label, dx, dy);
}

/// 开始拖动：后台线程跟随全局光标移动窗口，不依赖 WebView 后续 pointermove
fn start_drag_thread(app: tauri::AppHandle, label: &str) {
    let seq = PET_DRAG_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let app2 = app.clone();
    let label2 = label.to_string();
    if app.get_webview_window(label).is_none() {
        return;
    }
    std::thread::spawn(move || {
        let Ok(mut last) = app2.cursor_position() else { return };
        let started = Instant::now();
        while PET_DRAG_SEQ.load(Ordering::SeqCst) == seq
            && started.elapsed() < Duration::from_secs(10)
        {
            std::thread::sleep(Duration::from_millis(8));
            // 鼠标一旦松开立即停，避免 pointerup 丢失时窗口继续跟着光标跑
            if !left_button_down() {
                break;
            }
            let Ok(cur) = app2.cursor_position() else { break };
            let dx = cur.x - last.x;
            let dy = cur.y - last.y;
            if dx.abs() < 0.5 && dy.abs() < 0.5 {
                continue;
            }
            last = cur;
            move_window_impl(&app2, &label2, dx, dy);
        }
    });
}

#[tauri::command]
fn start_pet_drag(app: tauri::AppHandle) {
    start_drag_thread(app, "pet");
}

/// 通用窗口拖动（dashboard / reminder 等），替代原生 startDragging
#[tauri::command]
fn start_window_drag(app: tauri::AppHandle, window: String) {
    start_drag_thread(app, &window);
}

#[tauri::command]
fn end_pet_drag() {
    PET_DRAG_SEQ.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
fn window_hide_reminder(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("reminder") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn window_hide_dashboard(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("dashboard") {
        let _ = w.hide();
    }
    // 小屋收起后，桌宠还露在外面就把箱子放回来
    let pet_visible = app
        .get_webview_window("pet")
        .and_then(|p| p.is_visible().ok())
        .unwrap_or(false);
    if pet_visible {
        if let Some(b) = app.get_webview_window("todo-box") {
            position_todo_box(&app);
            let _ = b.show();
        }
    }
}

#[tauri::command]
fn window_hide_pet(app: tauri::AppHandle) {
    set_pet_visible(&app, false);
}

// ---------- runtime 就绪/失败上报（占位） ----------
#[tauri::command]
fn runtime_ready(report: serde_json::Value) {
    println!("runtime ready: {report}");
}

#[tauri::command]
fn runtime_fail(report: serde_json::Value) {
    eprintln!("runtime fail: {report}");
}

// ---------- 更新检查（GitHub Releases 轻量检查：比对版本号，打开下载页，不自动下载安装） ----------
const UPDATE_REPO: &str = "vio-lin/ShanshanGuoguoDeMaoYA";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    current_version: String,
    latest_version: String,
    has_update: bool,
    release_url: String,
    download_url: Option<String>,
    notes: String,
}

/// 点分版本号比较：a>b 返回 1，相等 0，a<b -1
fn compare_versions(a: &str, b: &str) -> i32 {
    let pa: Vec<i64> = a.split('.').map(|p| p.parse::<i64>().unwrap_or(0)).collect();
    let pb: Vec<i64> = b.split('.').map(|p| p.parse::<i64>().unwrap_or(0)).collect();
    for i in 0..pa.len().max(pb.len()) {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return (x - y).signum() as i32;
        }
    }
    0
}

/// 取子串：start 之后到 end 之前
fn between<'a>(s: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let i = s.find(start)?;
    let tail = &s[i + start.len()..];
    let j = tail.find(end)?;
    Some(&tail[..j])
}

/// API 限流/失败时降级 Releases Atom feed（网页域，不走 API 配额）
fn fetch_update_from_atom(current: &str) -> Option<UpdateInfo> {
    let url = format!("https://github.com/{UPDATE_REPO}/releases.atom");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(format!("ShanshanGuoguoDeMaoYA/{current}"))
        .build()
        .ok()?;
    let resp = client.get(&url).send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let xml = resp.text().ok()?;
    let entry = between(&xml, "<entry>", "</entry>")?;
    let title = between(entry, "<title>", "</title>").unwrap_or("");
    let href = between(entry, "href=\"", "\"").unwrap_or("");
    let latest = title.trim_start_matches('v').trim().to_string();
    if latest.is_empty() || href.is_empty() {
        return None;
    }
    let has_update = compare_versions(&latest, current) > 0;
    Some(UpdateInfo {
        current_version: current.to_string(),
        latest_version: latest.clone(),
        has_update,
        release_url: href.to_string(),
        download_url: None,
        notes: String::new(),
    })
}

fn fetch_from_github(current: &str) -> Option<UpdateInfo> {
    let url = format!("https://api.github.com/repos/{UPDATE_REPO}/releases/latest");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(format!("ShanshanGuoguoDeMaoYA/{current}"))
        .build()
        .ok()?;
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .ok()?;
    let status = resp.status();
    if status.as_u16() == 404 {
        return Some(UpdateInfo {
            current_version: current.to_string(),
            latest_version: current.to_string(),
            has_update: false,
            ..Default::default()
        });
    }
    // 限流（403/429）、网络错误或其他非成功：先降级 Atom feed；Atom 也失败才返回 None
    if status.as_u16() == 403 || status.as_u16() == 429 || !status.is_success() {
        return fetch_update_from_atom(current);
    }
    let release: serde_json::Value = resp.json().ok()?;
    let tag = release.get("tag_name")?.as_str()?.trim_start_matches('v').to_string();
    let html_url = release.get("html_url")?.as_str()?.to_string();
    let body = release
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let ext: &str = if cfg!(target_os = "macos") { ".dmg" } else { ".exe" };
    let mut download_url: Option<String> = None;
    if let Some(assets) = release.get("assets").and_then(|v| v.as_array()) {
        for asset in assets {
            if let (Some(name), Some(durl)) = (
                asset.get("name").and_then(|v| v.as_str()),
                asset.get("browser_download_url").and_then(|v| v.as_str()),
            ) {
                if name.ends_with(ext) {
                    download_url = Some(durl.to_string());
                    break;
                }
            }
        }
    }
    Some(UpdateInfo {
        current_version: current.to_string(),
        has_update: compare_versions(&tag, current) > 0,
        latest_version: tag,
        release_url: html_url,
        download_url,
        notes: body,
    })
}

#[tauri::command]
fn update_check(shared: State<SharedState>) -> Option<UpdateInfo> {
    let current = env!("CARGO_PKG_VERSION").to_string();

    // 5 分钟内复用成功结果；失败不缓存
    if let Some((at, cached)) = &*shared.update_cache.lock().unwrap() {
        if Instant::now().duration_since(*at) < Duration::from_secs(300) {
            return cached.clone();
        }
    }

    let result = fetch_from_github(&current);
    if result.is_some() {
        *shared.update_cache.lock().unwrap() = Some((Instant::now(), result.clone()));
    }
    result
}

/// 跨平台用默认浏览器打开 URL
fn open_url_external(url: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "", url])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

/// 跨平台在系统文件管理器中打开目录
fn open_path_in_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(path)
            .spawn()
            .map_err(|e| format!("无法打开目录: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("无法打开目录: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("无法打开目录: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn update_open(url: String) {
    open_url_external(&url);
}

// ---------- Claude 技能（pet-reminder） ----------
const SKILL_NAME: &str = "pet-reminder";
const SKILL_MD_BYTES: &[u8] = include_bytes!("../../tools/skills/pet-reminder/SKILL.md");
const REMINDER_PY_BYTES: &[u8] = include_bytes!("../../tools/add-reminder.py");

/// (相对技能目录的路径, 编译期内嵌的最新源字节)
fn skill_sources() -> [(&'static str, &'static [u8]); 2] {
    [
        ("SKILL.md", SKILL_MD_BYTES),
        ("scripts/add-reminder.py", REMINDER_PY_BYTES),
    ]
}

fn skill_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("无法定位主目录: {e}"))?;
    Ok(home.join(".claude/skills").join(SKILL_NAME))
}

fn read_bytes(path: &Path) -> Option<Vec<u8>> {
    fs::read(path).ok()
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn skills_check(app: tauri::AppHandle) -> serde_json::Value {
    let dir = match skill_dir(&app) {
        Ok(d) => d,
        Err(reason) => {
            return serde_json::json!({ "installed": false, "upToDate": false, "message": reason });
        }
    };

    if !dir.is_dir() {
        return serde_json::json!({
            "installed": false,
            "upToDate": false,
            "message": format!("未安装：{}", dir.display()),
        });
    }

    let mut lines: Vec<String> = Vec::new();
    let mut all_up = true;
    let mut any_exists = false;
    for (rel, src) in skill_sources() {
        let dest = dir.join(rel);
        match read_bytes(&dest) {
            Some(bytes) => {
                any_exists = true;
                let up = bytes.as_slice() == src;
                all_up &= up;
                lines.push(if up {
                    format!("  最新: {}", dest.display())
                } else {
                    format!("  存在但内容不一致: {}", dest.display())
                });
            }
            None => {
                all_up = false;
                lines.push(format!("  缺失: {}", dest.display()));
            }
        }
    }

    let message = if all_up {
        format!("技能 {SKILL_NAME} 已是最新配置。")
    } else {
        format!(
            "{} 技能 {SKILL_NAME} 需要更新（点击安装 / 更新即可）。",
            lines.join(" ")
        )
    };
    serde_json::json!({ "installed": any_exists, "upToDate": all_up, "message": message })
}

#[tauri::command]
fn skills_install(app: tauri::AppHandle) -> serde_json::Value {
    let dir = match skill_dir(&app) {
        Ok(d) => d,
        Err(reason) => {
            return serde_json::json!({ "ok": false, "state": "error", "message": reason });
        }
    };

    let existed = dir.is_dir();
    let already_up = existed
        && skill_sources()
            .iter()
            .all(|(rel, src)| matches!(read_bytes(&dir.join(rel)), Some(b) if b.as_slice() == *src));

    if already_up {
        return serde_json::json!({
            "ok": true,
            "state": "unchanged",
            "message": format!("技能 {SKILL_NAME} 已是最新配置，无需变更。"),
        });
    }

    // 备份旧版本（与技能目录同级，时间戳后缀）
    let mut backup: Option<PathBuf> = None;
    if existed {
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let bak = dir.with_file_name(format!("{SKILL_NAME}.bak-{stamp}"));
        if copy_dir_all(&dir, &bak).is_ok() {
            backup = Some(bak);
        }
    }

    let mut messages: Vec<String> = Vec::new();
    let mut ok = true;
    for (rel, src) in skill_sources() {
        let dest = dir.join(rel);
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }
        match fs::write(&dest, src) {
            Ok(_) => messages.push(format!("已安装: {}", dest.display())),
            Err(e) => {
                ok = false;
                messages.push(format!("写入失败 {}: {e}", dest.display()));
            }
        }
    }

    if !ok {
        return serde_json::json!({ "ok": false, "state": "error", "message": messages.join(" ") });
    }

    let state = if existed { "updated" } else { "installed" };
    if let Some(bak) = backup {
        messages.push(format!("旧版本已备份: {}", bak.display()));
    }
    messages.push(
        "安装完成。在 Claude Code 里说「小猫咪 帮我加个会议，今天下午 3 点」即可触发。".to_string(),
    );
    serde_json::json!({ "ok": true, "state": state, "message": messages.join(" ") })
}

// ---------- 纪念日 ----------
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Anniversary {
    id: String,
    date: String,
    title: String,
    description: String,
    frames: Vec<String>,
    frame_duration_ms: u32,
}

const ANNIVERSARY_JSON: &str = include_str!("../../src/anniversaries/index.json");

fn anniversary_list() -> Vec<Anniversary> {
    serde_json::from_str(ANNIVERSARY_JSON).unwrap_or_default()
}

fn today_mmdd() -> String {
    let now = chrono::Local::now();
    format!("{:02}-{:02}", now.month(), now.day())
}

fn anniversary_status(sim: &Option<String>) -> serde_json::Value {
    let list = anniversary_list();
    let active = match sim {
        Some(d) => list.iter().find(|a| &a.date == d).map(|a| a.id.clone()),
        None => list
            .iter()
            .find(|a| a.date == today_mmdd())
            .map(|a| a.id.clone()),
    };
    serde_json::json!({ "list": list, "activeId": active, "simulated": sim.is_some() })
}

#[tauri::command]
fn anniversaries_status(app: tauri::AppHandle) -> serde_json::Value {
    let sim = app
        .state::<SharedState>()
        .anniversary_sim
        .lock()
        .unwrap()
        .clone();
    anniversary_status(&sim)
}

#[tauri::command]
fn anniversaries_simulate(
    app: tauri::AppHandle,
    shared: State<'_, SharedState>,
    date: Option<String>,
) -> serde_json::Value {
    let normalized = date.filter(|d| !d.is_empty());
    *shared.anniversary_sim.lock().unwrap() = normalized.clone();
    let status = anniversary_status(&normalized);
    let _ = app.emit("anniversary-changed", &status);
    status
}

// ---------- 文件口袋 ----------
/// 与 pet-spec.json 的 features.filePocket 对齐（当前两只宠均为 false，菜单入口据此隐藏）
const FILE_POCKET_ENABLED: bool = false;
const POCKET_DIR_NAME: &str = "布偶猫桌宠";

fn pocket_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let doc = app
        .path()
        .document_dir()
        .map_err(|e| format!("无法定位文档目录: {e}"))?;
    Ok(doc.join(POCKET_DIR_NAME))
}

/// 防重名：已存在时追加 -1、-2…（对齐原版 uniqueDestination）
fn unique_destination(dir: &Path, filename: &str) -> PathBuf {
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let base = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename);
    let mut candidate = dir.join(filename);
    let mut counter = 1;
    while candidate.exists() {
        let name = if ext.is_empty() {
            format!("{base}-{counter}")
        } else {
            format!("{base}-{counter}.{ext}")
        };
        candidate = dir.join(name);
        counter += 1;
    }
    candidate
}

#[tauri::command]
fn files_put(app: tauri::AppHandle, paths: Vec<String>) -> serde_json::Value {
    let mut copied: Vec<String> = Vec::new();
    let mut failed: Vec<serde_json::Value> = Vec::new();

    let dir = match pocket_dir(&app) {
        Ok(d) => d,
        Err(reason) => {
            for source in paths {
                failed.push(serde_json::json!({ "source": source, "reason": reason }));
            }
            return serde_json::json!({ "copied": copied, "failed": failed });
        }
    };
    let _ = fs::create_dir_all(&dir);

    for source in paths {
        match (|| -> Result<String, String> {
            let meta = fs::metadata(&source).map_err(|e| e.to_string())?;
            if !meta.is_file() {
                return Err("仅支持普通文件".to_string());
            }
            let filename = Path::new(&source)
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| "无效文件名".to_string())?;
            let target = unique_destination(&dir, filename);
            fs::copy(&source, &target).map_err(|e| e.to_string())?;
            Ok(target.to_string_lossy().into_owned())
        })() {
            Ok(target) => copied.push(target),
            Err(reason) => failed.push(serde_json::json!({ "source": source, "reason": reason })),
        }
    }

    serde_json::json!({ "copied": copied, "failed": failed })
}

fn open_pocket_dir(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = pocket_dir(app)?;
    let _ = fs::create_dir_all(&dir);
    open_path_in_manager(&dir).map_err(|e| format!("无法打开口袋目录: {e}"))?;
    Ok(())
}

#[tauri::command]
fn files_open_pocket(app: tauri::AppHandle) -> Result<(), String> {
    open_pocket_dir(&app)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentTaskEvent {
    kind: String,
    text: String,
    source: Option<String>,
    session_id: Option<String>,
    ts: Option<String>,
}

async fn agent_task_handler(
    AxumState(app): AxumState<tauri::AppHandle>,
    Json(event): Json<AgentTaskEvent>,
) -> Json<serde_json::Value> {
    let shared = app.state::<SharedState>();
    let key = match &event.session_id {
        Some(s) => format!("{}:{}", event.kind, s),
        None => format!("{}:{}", event.kind, event.text),
    };
    {
        let mut last = shared.last_agent.lock().unwrap();
        let hit = last
            .as_ref()
            .map(|(k, at)| k == &key && at.elapsed().as_secs() < 3)
            .unwrap_or(false);
        if hit {
            return Json(serde_json::json!({ "ok": true, "deduped": true }));
        }
        *last = Some((key, Instant::now()));
    }

    let completed = event.kind == "task-complete";
    let activity = if completed {
        serde_json::json!({ "kind": "agent-complete", "stateId": "notify", "durationMs": 2400 })
    } else {
        serde_json::json!({ "kind": "agent-input", "stateId": "peek", "durationMs": 2800 })
    };
    let _ = app.emit_to("pet", "state-activity", &activity);
    let _ = app.emit_to("pet", "agent-task", &event);
    let notify_title = if completed { "任务完成" } else { "新任务" };
    send_system_notification(&app, notify_title, &event.text);
    Json(serde_json::json!({ "ok": true }))
}

async fn reminders_create_handler(
    AxumState(app): AxumState<tauri::AppHandle>,
    Json(input): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let shared = app.state::<SharedState>();
    let mut list = reminders_list(app.clone());
    let reminder = build_reminder(&input);
    list.push(reminder.clone());
    persist_reminders(&app, &list);
    schedule_reminder(&app, &shared, reminder.clone());
    Json(serde_json::json!({ "ok": true, "reminder": reminder }))
}

async fn reminders_list_handler(
    AxumState(app): AxumState<tauri::AppHandle>,
) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "reminders": reminders_list(app) }))
}

async fn reminders_get_handler(
    AxumState(app): AxumState<tauri::AppHandle>,
    AxumPath(id): AxumPath<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match reminders_list(app).into_iter().find(|r| r.id == id) {
        Some(reminder) => (StatusCode::OK, Json(serde_json::json!({ "ok": true, "reminder": reminder }))),
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "ok": false, "error": "提醒不存在" })),
        ),
    }
}

async fn reminders_update_handler(
    AxumState(app): AxumState<tauri::AppHandle>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
    match reminders_update(app, id, input) {
        Ok(reminder) => (StatusCode::OK, Json(serde_json::json!({ "ok": true, "reminder": reminder }))),
        Err(error) => (StatusCode::NOT_FOUND, Json(serde_json::json!({ "ok": false, "error": error }))),
    }
}

async fn reminders_delete_handler(
    AxumState(app): AxumState<tauri::AppHandle>,
    AxumPath(id): AxumPath<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let removed = reminders_remove(app, id);
    if removed {
        (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "ok": false, "error": "提醒不存在" })),
        )
    }
}

async fn todos_list_handler(
    AxumState(app): AxumState<tauri::AppHandle>,
) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "todos": read_todos(&app) }))
}

async fn todos_get_handler(
    AxumState(app): AxumState<tauri::AppHandle>,
    AxumPath(id): AxumPath<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match read_todos(&app).into_iter().find(|t| t.id == id) {
        Some(todo) => (StatusCode::OK, Json(serde_json::json!({ "ok": true, "todo": todo }))),
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "ok": false, "error": "待办不存在" })),
        ),
    }
}

async fn todos_create_handler(
    AxumState(app): AxumState<tauri::AppHandle>,
    Json(input): Json<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(todo) = build_todo(&input) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "标题不能为空，时间需为有效的 ISO 时间" })),
        );
    };
    let mut list = read_todos(&app);
    list.push(todo.clone());
    persist_todos(&app, &list);
    let shared = app.state::<SharedState>();
    schedule_todo(&app, shared.inner(), &todo);
    emit_todos_changed(&app);
    (StatusCode::OK, Json(serde_json::json!({ "ok": true, "todo": todo })))
}

async fn todos_update_handler(
    AxumState(app): AxumState<tauri::AppHandle>,
    AxumPath(id): AxumPath<String>,
    Json(patch): Json<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
    let shared = app.state::<SharedState>();
    let app_call = app.clone();
    match todos_update(app_call, shared, id, patch) {
        Ok(todo) => (StatusCode::OK, Json(serde_json::json!({ "ok": true, "todo": todo }))),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": error })),
        ),
    }
}

async fn todos_close_handler(
    AxumState(app): AxumState<tauri::AppHandle>,
    AxumPath(id): AxumPath<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let shared = app.state::<SharedState>();
    let app_call = app.clone();
    if todos_close(app_call, shared, id) {
        (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "ok": false, "error": "待办不存在" })),
        )
    }
}

async fn todos_reopen_handler(
    AxumState(app): AxumState<tauri::AppHandle>,
    AxumPath(id): AxumPath<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let shared = app.state::<SharedState>();
    let app_call = app.clone();
    if todos_reopen(app_call, shared, id) {
        (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "ok": false, "error": "待办不存在" })),
        )
    }
}

async fn todos_abandon_handler(
    AxumState(app): AxumState<tauri::AppHandle>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
    let shared = app.state::<SharedState>();
    let app_call = app.clone();
    let reason = body
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if todos_abandon(app_call, shared, id, reason) {
        (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
    } else {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "待办不存在或放弃理由为空" })),
        )
    }
}

async fn todos_delete_handler(
    AxumState(app): AxumState<tauri::AppHandle>,
    AxumPath(id): AxumPath<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let shared = app.state::<SharedState>();
    let app_call = app.clone();
    if todos_delete(app_call, shared, id) {
        (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "ok": false, "error": "待办不存在" })),
        )
    }
}

async fn todos_postpone_handler(
    AxumState(app): AxumState<tauri::AppHandle>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
    let minutes = input["minutes"].as_u64().unwrap_or(10) as u32;
    let shared = app.state::<SharedState>();
    let app_call = app.clone();
    match todos_postpone(app_call, shared, id, minutes) {
        Ok(todo) => (StatusCode::OK, Json(serde_json::json!({ "ok": true, "todo": todo }))),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": error })),
        ),
    }
}

async fn start_agent_bridge(app: tauri::AppHandle) {
    let router = Router::new()
        .route("/agent-task", post(agent_task_handler))
        .route(
            "/reminders",
            get(reminders_list_handler).post(reminders_create_handler),
        )
        .route(
            "/reminders/{id}",
            get(reminders_get_handler)
                .put(reminders_update_handler)
                .delete(reminders_delete_handler),
        )
        .route("/todos", get(todos_list_handler).post(todos_create_handler))
        .route(
            "/todos/{id}",
            get(todos_get_handler)
                .put(todos_update_handler)
                .delete(todos_delete_handler),
        )
        .route("/todos/{id}/close", post(todos_close_handler))
        .route("/todos/{id}/reopen", post(todos_reopen_handler))
        .route("/todos/{id}/abandon", post(todos_abandon_handler))
        .route("/todos/{id}/postpone", post(todos_postpone_handler))
        .with_state(app);

    let addr = SocketAddr::from(([127, 0, 0, 1], 46231));
    println!("agent-bridge listening on http://{}", addr);
    if let Ok(listener) = tokio::net::TcpListener::bind(addr).await {
        let _ = axum::serve(listener, router).await;
    }
}

/// 下一个整点（秒归零），用于整点喝水/久坐提醒
fn next_whole_hour() -> chrono::DateTime<chrono::Local> {
    use chrono::Timelike;
    let now = chrono::Local::now();
    let mut target = now + chrono::Duration::minutes(60 - now.minute() as i64);
    target -= chrono::Duration::seconds(target.second() as i64);
    target
}

/// 今天的指定时刻；已过则顺延到明天
fn next_daily_at(hour: u32, minute: u32) -> chrono::DateTime<chrono::Local> {
    use chrono::TimeZone;
    let now = chrono::Local::now();
    let today = now
        .date_naive()
        .and_hms_opt(hour, minute, 0)
        .unwrap_or_else(|| now.naive_local());
    let target = chrono::Local
        .from_local_datetime(&today)
        .earliest()
        .unwrap_or(now);
    if target <= now {
        target + chrono::Duration::days(1)
    } else {
        target
    }
}

/// 菜单快捷预设：直接建一条重复提醒并提示
fn create_preset_reminder(
    app: &tauri::AppHandle,
    text: &str,
    repeat: &str,
    due: chrono::DateTime<chrono::Local>,
) {
    let reminder = Reminder {
        id: uuid::Uuid::new_v4().to_string(),
        text: text.to_string(),
        due_at: due.to_rfc3339(),
        created_at: chrono::Utc::now().to_rfc3339(),
        lead_minutes: None,
        repeat: normalize_repeat(Some(repeat)),
    };
    let mut list = reminders_list(app.clone());
    list.push(reminder.clone());
    persist_reminders(app, &list);
    let shared = app.state::<SharedState>();
    schedule_reminder(app, shared.inner(), reminder);
    let label = match repeat {
        "hourly" => "每小时",
        "daily" => "每天",
        "weekdays" => "工作日",
        "weekly" => "每周",
        _ => "一次性",
    };
    send_system_notification(
        app,
        "已添加提醒",
        &format!("{}（{}，首次 {}）", text, label, due.format("%m-%d %H:%M")),
    );
}

#[tauri::command]
fn show_pet_context_menu(app: tauri::AppHandle) {
    let Some(win) = app.get_webview_window("pet") else { return };

    let current = get_settings(app.clone()).current_pet;
    let pet_ragdoll =
        MenuItem::with_id(&app, "pet-ragdoll", pet_label("ragdoll", &current), true, None::<&str>).unwrap();
    let pet_nini =
        MenuItem::with_id(&app, "pet-nini", pet_label("nini", &current), true, None::<&str>).unwrap();
    let pets_submenu = Submenu::with_id(&app, "ctx-pets", "🐾 切换宠物", true).unwrap();
    pets_submenu
        .append_items(&[&pet_ragdoll, &pet_nini])
        .unwrap();

    let walk = MenuItem::with_id(&app, "walk", "🚶 散步去", true, None::<&str>).unwrap();
    let jump = MenuItem::with_id(&app, "jump", "🦘 蹦高高", true, None::<&str>).unwrap();
    let stalk = MenuItem::with_id(&app, "stalk", "🐾 悄悄走", true, None::<&str>).unwrap();
    let bury = MenuItem::with_id(&app, "bury", "💩 埋粑粑", true, None::<&str>).unwrap();
    let sep1 = PredefinedMenuItem::separator(&app).unwrap();
    let reminder = MenuItem::with_id(&app, "reminder", "⏰ 添加提醒", true, None::<&str>).unwrap();
    let quick_water = MenuItem::with_id(&app, "quick-water", "💧 每小时喝水", true, None::<&str>).unwrap();
    let quick_stand = MenuItem::with_id(&app, "quick-stand", "🧘 每小时起来活动", true, None::<&str>).unwrap();
    let quick_sleep = MenuItem::with_id(&app, "quick-sleep", "🌙 每天 22:30 休息", true, None::<&str>).unwrap();
    let quick_submenu = Submenu::with_id(&app, "ctx-quick-reminders", "⏱ 快捷提醒", true).unwrap();
    quick_submenu
        .append_items(&[&quick_water, &quick_stand, &quick_sleep])
        .unwrap();
    let dashboard = MenuItem::with_id(
        &app,
        "dashboard",
        format!("🏠 {}的小屋", pet_display_name(&current)),
        true,
        None::<&str>,
    )
    .unwrap();
    let pocket = FILE_POCKET_ENABLED.then(|| {
        MenuItem::with_id(&app, "open-pocket", "📁 打开文件口袋", true, None::<&str>).unwrap()
    });
    let sep2 = PredefinedMenuItem::separator(&app).unwrap();
    let hide = MenuItem::with_id(&app, "hide", "🙈 隐藏桌宠", true, None::<&str>).unwrap();
    let quit = MenuItem::with_id(&app, "quit", "❌ 退出", true, None::<&str>).unwrap();

    let mut items: Vec<&dyn IsMenuItem<tauri::Wry>> = vec![
        &walk, &jump, &stalk, &bury, &sep1, &reminder, &quick_submenu, &dashboard, &pets_submenu,
    ];
    if let Some(p) = &pocket {
        items.push(p);
    }
    items.extend_from_slice(&[&sep2, &hide, &quit]);

    let menu = Menu::with_items(&app, &items).unwrap();

    win.popup_menu(&menu).unwrap();

    // 菜单事件统一在 setup 里注册，这里只 popup
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .on_window_event(|window, event| {
            if window.label() == "pet" {
                if let tauri::WindowEvent::Moved(_) = event {
                    let app = window.app_handle();
                    let shared = app.state::<SharedState>();
                    let mut last = shared.last_position_save.lock().unwrap();
                    let now = Instant::now();
                    let due = last.map_or(true, |t| now.duration_since(t) >= Duration::from_millis(500));
                    if due {
                        *last = Some(now);
                        drop(last);
                        save_window_position(app);
                    }
                    // 箱子窗口跟随桌宠移动（更细的节流，避免拖动时明显滞后）
                    let mut box_last = shared.last_box_move.lock().unwrap();
                    let box_due =
                        box_last.map_or(true, |t| now.duration_since(t) >= Duration::from_millis(60));
                    if box_due {
                        *box_last = Some(now);
                        drop(box_last);
                        position_todo_box(app);
                    }
                }
            }
        })
        .setup(|app| {
            // 首次启动：从 Electron 旧 userData 迁移历史配置/提醒/统计（不覆盖已有数据）
            migrate_legacy_data(app.handle());

            // 恢复持久化的置顶 / 穿透 / 大小设置
            let persisted = get_settings(app.handle().clone());
            apply_pet_settings(app.handle(), &persisted);

            // 恢复上次桌宠位置（坐标需落在当前可见屏幕内）
            restore_window_position(app.handle());

            // 注册跨命令 / bridge 共享状态
            app.manage(SharedState::default());

            // 启动时恢复已保存提醒的到点定时器（先迁移，避免旧提醒与待办重复提醒）
            let shared = app.state::<SharedState>();
            *shared.session_started.lock().unwrap() = Some(Instant::now());
            let migrated = migrate_reminders_to_todos(app.handle());
            if migrated > 0 {
                eprintln!("[todo] migrated {migrated} reminders to todos");
            }
            for reminder in reminders_list(app.handle().clone()) {
                schedule_reminder(app.handle(), shared.inner(), reminder);
            }

            // 为全部待办排提醒
            for todo in read_todos(app.handle()) {
                schedule_todo(app.handle(), shared.inner(), &todo);
            }
            notify_overdue_on_start(app.handle());

            // 启动广播纪念日命中状态（前端 init 也会主动拉取一次）
            let sim = shared.anniversary_sim.lock().unwrap().clone();
            let anniversary = anniversary_status(&sim);
            let _ = app.emit("anniversary-changed", &anniversary);

            // 创建 dashboard 窗口（初始隐藏）
            let dashboard = tauri::WebviewWindowBuilder::new(
                app,
                "dashboard",
                tauri::WebviewUrl::App("frontend/dashboard.html".into()),
            )
            .title("哈哈的小屋")
            .decorations(false)
            .transparent(true)
            .inner_size(520.0, 700.0)
            .min_inner_size(480.0, 620.0)
            .resizable(true)
            .visible(false)
            .build()?;
            let _ = dashboard;

            // 创建 reminder 窗口（初始隐藏）
            let reminder = tauri::WebviewWindowBuilder::new(
                app,
                "reminder",
                tauri::WebviewUrl::App("frontend/reminder.html".into()),
            )
            .title("添加提醒")
            .decorations(false)
            .transparent(true)
            .inner_size(390.0, 440.0)
            .resizable(false)
            .visible(false)
            .build()?;
            let _ = reminder;

            // 创建桌宠旁的待办箱子窗口（无边框透明小窗，位置跟随桌宠）
            let todo_box = tauri::WebviewWindowBuilder::new(
                app,
                "todo-box",
                tauri::WebviewUrl::App("frontend/todo-box.html".into()),
            )
            .title("待办箱子")
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .inner_size(TODO_BOX_SIZE, TODO_BOX_SIZE)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .accept_first_mouse(true)
            .focused(false)
            .visible(false)
            .build()?;
            let _ = todo_box;

            position_todo_box(app.handle());
            if let Some(box_win) = app.get_webview_window("todo-box") {
                let _ = box_win.show();
            }

            // 全局菜单事件处理（右键菜单 + 托盘菜单统一在此分发）
            app.on_menu_event(|app, event| {
                match event.id.0.as_str() {
                    "walk" | "jump" | "stalk" | "bury" => {
                        let id = event.id.0.as_str().to_string();
                        let _ = interactions_trigger(app.clone(), id);
                    }
                    "reminder" => {
                        show_reminder_composer(app);
                    }
                    "quick-water" => {
                        create_preset_reminder(app, "该喝水啦 💧", "hourly", next_whole_hour());
                    }
                    "quick-stand" => {
                        create_preset_reminder(app, "起来活动一下 🧘", "hourly", next_whole_hour());
                    }
                    "quick-sleep" => {
                        create_preset_reminder(app, "该休息啦 🌙", "daily", next_daily_at(22, 30));
                    }
                    "dashboard" | "tray-dashboard" => {
                        if let Some(dash) = app.get_webview_window("dashboard") {
                            let _ = dash.show();
                            let _ = dash.set_focus();
                            let _ = dash.reload();
                        }
                        if let Some(b) = app.get_webview_window("todo-box") {
                            let _ = b.hide();
                        }
                    }
                    "hide" => {
                        set_pet_visible(app, false);
                    }
                    "open-pocket" => {
                        let _ = open_pocket_dir(app);
                    }
                    "tray-show" => {
                        set_pet_visible(app, true);
                    }
                    "pet-ragdoll" => activate_pet(app, "ragdoll"),
                    "pet-nini" => activate_pet(app, "nini"),
                    "tray-clickthrough" => {
                        let mut current = get_settings(app.clone());
                        current.click_through = !current.click_through;
                        let path = settings_path(app);
                        if let Some(parent) = path.parent() {
                            let _ = fs::create_dir_all(parent);
                        }
                        if let Ok(content) = serde_json::to_string_pretty(&current) {
                            let _ = fs::write(&path, content);
                        }
                        if let Some(win) = app.get_webview_window("pet") {
                            let _ = win.set_ignore_cursor_events(current.click_through);
                        }
                        if let Some(tray) = app.tray_by_id("main-tray") {
                            if let Ok(menu) = build_tray_menu(app, &current.current_pet) {
                                let _ = tray.set_menu(Some(menu));
                            }
                        }
                    }
                    "tray-update" => {
                        // 检查更新：当前无更新源，占位
                    }
                    "quit" | "tray-quit" => {
                        save_window_position(app);
                        app.exit(0)
                    }
                    _ => {}
                }
            });

            // 启动 agent-bridge HTTP 服务
            tauri::async_runtime::spawn(start_agent_bridge(app.handle().clone()));

            // 托盘菜单（文案按当前宠物动态生成）
            let current_pet = get_settings(app.handle().clone()).current_pet;
            let menu = build_tray_menu(app.handle(), &current_pet)?;

            TrayIconBuilder::with_id("main-tray")
                .icon(tray_image_for(&current_pet))
                .tooltip(pet_display_name(&current_pet))
                .menu(&menu)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        let visible = app
                            .get_webview_window("pet")
                            .and_then(|win| win.is_visible().ok())
                            .unwrap_or(false);
                        set_pet_visible(app, !visible);
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings, update_settings,
            autostart_get, autostart_set,
            pets_list, pets_activate,
            reminders_list, reminders_save, reminders_remove, reminders_get, reminders_update,
            reminders_snooze,
            todos_list, todos_create, todos_update, todos_close, todos_reopen, todos_abandon, todos_delete, todos_postpone,
            interactions_stats, interactions_trigger,
            show_pet_context_menu,
            move_pet_window,
        start_pet_drag,
        end_pet_drag,
        move_window,
        start_window_drag,
        set_todo_box_trim,
            window_show_reminder, window_show_dashboard, window_show_dashboard_todo,
            window_hide_reminder, window_hide_dashboard, window_hide_pet,
            runtime_ready, runtime_fail,
            update_check, update_open,
            skills_check, skills_install,
            anniversaries_status, anniversaries_simulate,
            files_put, files_open_pocket
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod update_tests {
    use super::compare_versions;

    #[test]
    fn compare_equal() {
        assert_eq!(compare_versions("1.5.0", "1.5.0"), 0);
    }

    #[test]
    fn compare_newer_minor() {
        assert_eq!(compare_versions("1.5.0", "1.4.1"), 1);
    }

    #[test]
    fn compare_older() {
        assert_eq!(compare_versions("1.3.1", "1.5.0"), -1);
    }

    #[test]
    fn compare_pad_missing_parts() {
        assert_eq!(compare_versions("1.5", "1.5.0"), 0);
        assert_eq!(compare_versions("1.10.0", "1.9.0"), 1);
    }
}
