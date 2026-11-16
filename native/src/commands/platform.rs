//! 应用 / 平台类命令：抽屉里的降级实现。
//! 插件没有 Tauri 的窗口、沙箱或 OS 右键菜单安装能力，这里给出对前端
//! 友好的固定结果，避免 UI 因拿到 `undefined` 而崩溃。

use crate::helpers::str_field;
use crate::state;
use serde_json::{json, Value};
use std::path::PathBuf;

pub fn cancel_operation() -> Result<Value, String> {
    state::request_cancel();
    Ok(Value::Null)
}

pub fn take_pending_file() -> Result<Value, String> {
    Ok(state::take_pending_file())
}

pub fn poll_events() -> Result<Value, String> {
    Ok(state::poll_events())
}

pub fn push_open_file(payload: &Value) -> Result<Value, String> {
    let path = str_field(payload, &["path"])?;
    state::push_open_file(path);
    Ok(Value::Null)
}

pub fn app_version() -> Result<Value, String> {
    Ok(json!("0.1.0"))
}

pub fn app_is_sandboxed() -> Result<Value, String> {
    Ok(json!(false))
}

pub fn selftest_action() -> Result<Value, String> {
    Ok(Value::Null)
}

pub fn selftest_log() -> Result<Value, String> {
    Ok(Value::Null)
}

/// 插件模式不安装 OS 右键菜单。字段形状与 `ShellStatus` 保持一致，
/// 让 `renderShellStatus` 能把这句说明显示出来而不是当作异常。
fn shell_status() -> Value {
    json!({
        "supported": true,
        "installed": false,
        "platform": "OTools 插件模式",
        "details": [["插件模式不支持 OS 右键菜单集成", false]],
    })
}

pub fn shell_integration_status() -> Result<Value, String> {
    Ok(shell_status())
}

pub fn shell_integration_install() -> Result<Value, String> {
    Ok(shell_status())
}

pub fn shell_integration_uninstall() -> Result<Value, String> {
    Ok(shell_status())
}

/// 在系统默认浏览器打开 http(s) URL（不是 app webview）。
pub fn open_url(payload: &Value) -> Result<Value, String> {
    let url = str_field(payload, &["url"])?;
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs are allowed".into());
    }
    let spawn = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&url).spawn()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
    } else {
        std::process::Command::new("xdg-open").arg(&url).spawn()
    };
    spawn.map(|_| Value::Null).map_err(|e| e.to_string())
}

/// 在 OS 文件管理器中显示已完成的文件。
pub fn reveal_in_file_manager(payload: &Value) -> Result<Value, String> {
    let path = str_field(payload, &["path"])?;
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("that path no longer exists".into());
    }
    let spawn = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg("-R").arg(&p).spawn()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("explorer")
            .arg(format!("/select,{path}"))
            .spawn()
    } else {
        let dir = p.parent().unwrap_or(&p);
        std::process::Command::new("xdg-open").arg(dir).spawn()
    };
    spawn.map(|_| Value::Null).map_err(|e| e.to_string())
}
