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
        }
    }
}

fn settings_path(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("settings.json")
}

/// 桌宠基础窗口边长（px，对齐 pet-spec experience.petSizing.baseWindowPx）
const BASE_PET_WINDOW_PX: f64 = 220.0;

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
    /// 纪念日模拟日期 MM-DD（None = 按真实今天匹配）
    anniversary_sim: Mutex<Option<String>>,
    /// agent 事件去重：(key, 投递时刻)
    last_agent: Mutex<Option<(String, Instant)>>,
    /// 本次会话陪伴计时基准（每次持久化 stats 后重置）
    session_started: Mutex<Option<Instant>>,
    /// 更新检查缓存：(时刻, 结果)，5 分钟内复用；失败不缓存
    update_cache: Mutex<Option<(Instant, Option<UpdateInfo>)>>,
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
    current
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

/// 为提醒排到点定时器：到点弹出提醒窗并触发 notify 动作
fn schedule_reminder(app: &tauri::AppHandle, shared: &SharedState, reminder: Reminder) {
    if let Some(old) = shared.reminder_timers.lock().unwrap().remove(&reminder.id) {
        old.abort();
    }
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
    });
    shared
        .reminder_timers
        .lock()
        .unwrap()
        .insert(reminder_id, handle);
}

fn unschedule_reminder(shared: &SharedState, id: &str) {
    if let Some(old) = shared.reminder_timers.lock().unwrap().remove(id) {
        old.abort();
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

#[tauri::command]
fn window_show_dashboard(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("dashboard") {
        let _ = w.show();
        let _ = w.set_focus();
    }
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
}

#[tauri::command]
fn window_hide_pet(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("pet") {
        let _ = w.hide();
    }
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
    // 限流（403/429）或其他错误：返回 None，前端提示检查失败，不降级缓存
    if status.as_u16() == 403 || status.as_u16() == 429 || !status.is_success() {
        return None;
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
        .with_state(app);

    let addr = SocketAddr::from(([127, 0, 0, 1], 46231));
    println!("agent-bridge listening on http://{}", addr);
    if let Ok(listener) = tokio::net::TcpListener::bind(addr).await {
        let _ = axum::serve(listener, router).await;
    }
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
        &walk, &jump, &stalk, &bury, &sep1, &reminder, &dashboard, &pets_submenu,
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
        .setup(|app| {
            // 首次启动：从 Electron 旧 userData 迁移历史配置/提醒/统计（不覆盖已有数据）
            migrate_legacy_data(app.handle());

            // 恢复持久化的置顶 / 穿透 / 大小设置
            let persisted = get_settings(app.handle().clone());
            apply_pet_settings(app.handle(), &persisted);

            // 注册跨命令 / bridge 共享状态
            app.manage(SharedState::default());

            // 启动时恢复已保存提醒的到点定时器
            let shared = app.state::<SharedState>();
            *shared.session_started.lock().unwrap() = Some(Instant::now());
            for reminder in reminders_list(app.handle().clone()) {
                schedule_reminder(app.handle(), shared.inner(), reminder);
            }

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
            .inner_size(390.0, 360.0)
            .resizable(false)
            .visible(false)
            .build()?;
            let _ = reminder;

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
                    "dashboard" | "tray-dashboard" => {
                        if let Some(dash) = app.get_webview_window("dashboard") {
                            let _ = dash.show();
                            let _ = dash.set_focus();
                            let _ = dash.reload();
                        }
                    }
                    "hide" => {
                        if let Some(win) = app.get_webview_window("pet") {
                            let _ = win.hide();
                        }
                    }
                    "open-pocket" => {
                        let _ = open_pocket_dir(app);
                    }
                    "tray-show" => {
                        if let Some(win) = app.get_webview_window("pet") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
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
                    "quit" | "tray-quit" => app.exit(0),
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
                        if let Some(win) = app.get_webview_window("pet") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings, update_settings,
            pets_list, pets_activate,
            reminders_list, reminders_save, reminders_remove, reminders_get, reminders_update,
            interactions_stats, interactions_trigger,
            show_pet_context_menu,
            window_show_reminder, window_show_dashboard,
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
