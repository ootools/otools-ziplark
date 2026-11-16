//! 从上游 `tauri-commands.reference.rs` 复用的辅助逻辑，外加 payload 读取工具。

use serde::Serialize;
use serde_json::Value;
use ziplark_core::{Error, Format, Level};

/// 返回给 GUI Quick Preview 弹窗的载荷（照抄上游定义）。
#[derive(Serialize)]
pub struct PreviewPayload {
    pub path: String,
    pub size: u64,
    pub returned_bytes: usize,
    pub truncated: bool,
    pub kind: &'static str, // "text" | "image" | "binary"
    pub text: Option<String>,
    pub data_url: Option<String>,
    pub hex_preview: Option<String>,
}

pub fn parse_format(s: &str) -> Result<Format, String> {
    Ok(match s.to_ascii_lowercase().as_str() {
        "zip" => Format::Zip,
        "7z" | "sevenz" => Format::SevenZ,
        "tar" => Format::Tar,
        "tar.gz" | "tgz" => Format::TarGz,
        "tar.bz2" => Format::TarBz2,
        "tar.xz" => Format::TarXz,
        "tar.zst" => Format::TarZst,
        "tar.lz4" | "tlz4" => Format::TarLz4,
        "gz" => Format::Gz,
        "bz2" => Format::Bz2,
        "xz" => Format::Xz,
        "zst" => Format::Zst,
        "lz4" => Format::Lz4,
        other => return Err(format!("unknown format '{other}'")),
    })
}

pub fn parse_level(s: &str) -> Level {
    match s {
        "store" => Level::Store,
        "fast" => Level::Fast,
        "best" => Level::Best,
        _ => Level::Default,
    }
}

pub fn image_mime(entry_path: &str) -> Option<&'static str> {
    let l = entry_path.to_ascii_lowercase();
    if l.ends_with(".png") {
        Some("image/png")
    } else if l.ends_with(".jpg") || l.ends_with(".jpeg") {
        Some("image/jpeg")
    } else if l.ends_with(".gif") {
        Some("image/gif")
    } else if l.ends_with(".webp") {
        Some("image/webp")
    } else if l.ends_with(".svg") {
        Some("image/svg+xml")
    } else if l.ends_with(".bmp") {
        Some("image/bmp")
    } else if l.ends_with(".ico") {
        Some("image/x-icon")
    } else {
        None
    }
}

pub fn format_hex_dump(bytes: &[u8], limit: usize) -> String {
    let slice = &bytes[..bytes.len().min(limit)];
    let mut lines = Vec::new();
    for (row, chunk) in slice.chunks(16).enumerate() {
        let mut hex = String::with_capacity(48);
        let mut ascii = String::with_capacity(16);
        for (i, &b) in chunk.iter().enumerate() {
            if i == 8 {
                hex.push(' ');
            }
            hex.push_str(&format!("{b:02x} "));
            ascii.push(if (0x20..=0x7e).contains(&b) {
                b as char
            } else {
                '.'
            });
        }
        lines.push(format!("{:08x}  {:<49} |{}|", row * 16, hex, ascii));
    }
    lines.join("\n")
}

/// 统一错误：core 的 `Cancelled` 映射成前端 `wasCancelled()` 认得的字符串。
pub fn core_err(error: Error) -> String {
    match error {
        Error::Cancelled => "cancelled".to_string(),
        other => other.to_string(),
    }
}

/// 把 core 的 report 序列化成响应里的 `data`。
pub fn to_data<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

/// 读 payload 字段。前端原始代码用 camelCase（`keepBroken` / `splitSize` /
/// `leftPassword` / `caseInsensitive` / `contentDiff`），Tauri 会自动转成
/// reference 里的 snake_case 参数；插件自己接收 JSON，所以两种都认。
pub fn field<'a>(payload: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .find_map(|key| payload.get(*key))
        .filter(|value| !value.is_null())
}

pub fn str_field(payload: &Value, keys: &[&str]) -> Result<String, String> {
    field(payload, keys)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("missing payload field: {}", keys[0]))
}

/// 可选字符串；空串按 `None` 处理（上游对 password 就是 `.filter(|p| !p.is_empty())`）。
pub fn opt_str(payload: &Value, keys: &[&str]) -> Option<String> {
    field(payload, keys)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

pub fn bool_field(payload: &Value, keys: &[&str], default: bool) -> bool {
    field(payload, keys)
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

pub fn str_vec(payload: &Value, keys: &[&str]) -> Vec<String> {
    field(payload, keys)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}
