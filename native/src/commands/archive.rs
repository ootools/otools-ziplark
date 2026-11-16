//! 归档命令：薄薄一层，把上游 `in_background` 的异步包装换成同步调用，
//! 全部真实逻辑仍由 `ziplark-core` 完成。

use crate::helpers::{
    bool_field, core_err, format_hex_dump, image_mime, opt_str, parse_format, parse_level,
    str_field, str_vec, to_data, PreviewPayload,
};
use crate::state;
use base64::Engine as _;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use ziplark_core::{
    add as core_add, convert as core_convert, create as core_create, detect, diff as core_diff,
    extract as core_extract, grep as core_grep, hash as core_hash, list as core_list,
    parse_byte_size, read_entry as core_read_entry, remove as core_remove, rename as core_rename,
    smart_dest, test as core_test, ConvertOptions, CreateOptions, DiffOptions, Error,
    ExtractOptions, GrepOptions, HashAlgorithm, HashOptions, Level, ListOptions, MatchMode,
    Progress, ReadOptions, RemoveOptions, RenameOptions,
};

/// 同步执行一个引擎任务：清零取消标志、挂上进度/取消回调、统一映射错误。
/// 对应上游的 `in_background`，只是不再 `spawn_blocking`（宿主已经做了）。
fn with_progress<T, F>(job: F) -> Result<T, String>
where
    F: FnOnce(&mut dyn FnMut(Progress) -> bool) -> ziplark_core::Result<T>,
{
    state::begin_operation();
    let mut callback = state::progress_callback();
    job(&mut callback).map_err(core_err)
}

pub fn detect_format(payload: &Value) -> Result<Value, String> {
    let path = str_field(payload, &["path"])?;
    Ok(json!(
        detect(Path::new(&path)).map(|f| f.label().to_string())
    ))
}

pub fn list_archive(payload: &Value) -> Result<Value, String> {
    let path = str_field(payload, &["path"])?;
    let password = opt_str(payload, &["password"]);
    let info = with_progress(|_| core_list(&path, &ListOptions { password }))?;
    to_data(info)
}

pub fn test_archive(payload: &Value) -> Result<Value, String> {
    let path = str_field(payload, &["path"])?;
    let password = opt_str(payload, &["password"]);
    let report =
        with_progress(|progress| core_test(&path, &ListOptions { password }, Some(progress)))?;
    to_data(report)
}

pub fn preview_archive_entry(payload: &Value) -> Result<Value, String> {
    let path = str_field(payload, &["path"])?;
    let entry = str_field(payload, &["entry"])?;
    let password = opt_str(payload, &["password"]);
    let preview = with_progress(|_| {
        let mime = image_mime(&entry);
        let max_bytes = if mime.is_some() {
            4 * 1024 * 1024
        } else {
            256 * 1024
        };
        let content = core_read_entry(
            &path,
            &entry,
            &ReadOptions {
                password,
                offset: 0,
                max_bytes,
            },
        )?;
        let returned_bytes = content.bytes.len();
        if let Some(m) = mime {
            if !content.truncated {
                let b64 = base64::engine::general_purpose::STANDARD.encode(&content.bytes);
                return Ok(PreviewPayload {
                    path: content.path,
                    size: content.size,
                    returned_bytes,
                    truncated: false,
                    kind: "image",
                    text: None,
                    data_url: Some(format!("data:{m};base64,{b64}")),
                    hex_preview: None,
                });
            }
        }
        let is_binary = content.bytes.contains(&0) || std::str::from_utf8(&content.bytes).is_err();
        if !is_binary {
            Ok(PreviewPayload {
                path: content.path,
                size: content.size,
                returned_bytes,
                truncated: content.truncated,
                kind: "text",
                text: Some(String::from_utf8_lossy(&content.bytes).into_owned()),
                data_url: None,
                hex_preview: None,
            })
        } else {
            Ok(PreviewPayload {
                path: content.path,
                size: content.size,
                returned_bytes,
                truncated: content.truncated,
                kind: "binary",
                text: None,
                data_url: None,
                hex_preview: Some(format_hex_dump(&content.bytes, 2048)),
            })
        }
    })?;
    to_data(preview)
}

pub fn extract_archive(payload: &Value) -> Result<Value, String> {
    let path = str_field(payload, &["path"])?;
    let dest = str_field(payload, &["dest"])?;
    let password = opt_str(payload, &["password"]);
    let overwrite = bool_field(payload, &["overwrite"], false);
    let include = str_vec(payload, &["include"]);
    let exact = bool_field(payload, &["exact"], false);
    let keep_broken = bool_field(payload, &["keep_broken", "keepBroken"], false);
    let smart = bool_field(payload, &["smart"], false);
    let opts = ExtractOptions {
        password,
        dest: PathBuf::from(dest),
        overwrite,
        include,
        match_mode: if exact {
            MatchMode::Exact
        } else {
            MatchMode::Auto
        },
        keep_broken,
        smart,
    };
    let report = with_progress(|progress| core_extract(&path, &opts, Some(progress)))?;
    to_data(report)
}

pub fn extract_archive_here(payload: &Value) -> Result<Value, String> {
    let path = str_field(payload, &["path"])?;
    let password = opt_str(payload, &["password"]);
    let keep_broken = bool_field(payload, &["keep_broken", "keepBroken"], false);
    let report = with_progress(|progress| {
        let arc_path = Path::new(&path);
        let parent = arc_path.parent().unwrap_or(Path::new("."));
        let info = core_list(
            arc_path,
            &ListOptions {
                password: password.clone(),
            },
        )?;
        let dest = smart_dest(&info.path, parent, &info.entries, true);
        let opts = ExtractOptions {
            password,
            dest,
            overwrite: true,
            include: Vec::new(),
            match_mode: MatchMode::Auto,
            keep_broken,
            smart: false,
        };
        core_extract(arc_path, &opts, Some(progress))
    })?;
    to_data(report)
}

pub fn create_archive(payload: &Value) -> Result<Value, String> {
    let output = str_field(payload, &["output"])?;
    let inputs = str_vec(payload, &["inputs"]);
    let format = str_field(payload, &["format"])?;
    let level = opt_str(payload, &["level"]).unwrap_or_else(|| "default".to_string());
    if inputs.is_empty() {
        return Err("select at least one file or folder".into());
    }
    let split_size = opt_str(payload, &["split_size", "splitSize"]);
    let parsed_split = match split_size.as_deref().map(str::trim) {
        Some(s) if !s.is_empty() => Some(parse_byte_size(s).map_err(core_err)?),
        _ => None,
    };
    let opts = CreateOptions {
        format: parse_format(&format)?,
        level: parse_level(&level),
        password: opt_str(payload, &["password"]),
        split_size: parsed_split,
    };
    let paths: Vec<PathBuf> = inputs.into_iter().map(PathBuf::from).collect();
    let report = with_progress(|progress| core_create(&output, &paths, &opts, Some(progress)))?;
    to_data(report)
}

pub fn add_to_archive(payload: &Value) -> Result<Value, String> {
    let archive = str_field(payload, &["archive"])?;
    let inputs = str_vec(payload, &["inputs"]);
    let password = opt_str(payload, &["password"]);
    if inputs.is_empty() {
        return Err("select at least one file or folder".into());
    }
    let fmt = detect(Path::new(&archive))
        .ok_or_else(|| "cannot modify this archive format".to_string())?;
    if !fmt.can_modify() {
        return Err(format!("{} archives are read-only", fmt.label()));
    }
    let opts = CreateOptions {
        format: fmt,
        level: Level::Default,
        password,
        split_size: None,
    };
    let paths: Vec<PathBuf> = inputs.into_iter().map(PathBuf::from).collect();
    let report = with_progress(|progress| core_add(&archive, &paths, &opts, Some(progress)))?;
    to_data(report)
}

pub fn remove_from_archive(payload: &Value) -> Result<Value, String> {
    let archive = str_field(payload, &["archive"])?;
    let entries = str_vec(payload, &["entries"]);
    let password = opt_str(payload, &["password"]);
    if entries.is_empty() {
        return Err("select at least one entry to remove".into());
    }
    let fmt = detect(Path::new(&archive))
        .ok_or_else(|| "cannot modify this archive format".to_string())?;
    if !fmt.can_modify() {
        return Err(format!("{} archives are read-only", fmt.label()));
    }
    let opts = RemoveOptions {
        password,
        include: entries,
        match_mode: MatchMode::Exact,
        level: Level::Default,
    };
    let report = with_progress(|progress| core_remove(&archive, &opts, Some(progress)))?;
    to_data(report)
}

pub fn rename_in_archive(payload: &Value) -> Result<Value, String> {
    let archive = str_field(payload, &["archive"])?;
    let from = str_field(payload, &["from"])?;
    let to = str_field(payload, &["to"])?;
    let password = opt_str(payload, &["password"]);
    let fmt = detect(Path::new(&archive))
        .ok_or_else(|| "cannot modify this archive format".to_string())?;
    if !fmt.can_modify() {
        return Err(format!("{} archives are read-only", fmt.label()));
    }
    let opts = RenameOptions {
        password,
        level: Level::Default,
    };
    let report =
        with_progress(|progress| core_rename(&archive, &from, &to, &opts, Some(progress)))?;
    to_data(report)
}

pub fn diff_archives(payload: &Value) -> Result<Value, String> {
    let left = str_field(payload, &["left"])?;
    let right = str_field(payload, &["right"])?;
    let left_password = opt_str(payload, &["left_password", "leftPassword"]);
    let right_password = opt_str(payload, &["right_password", "rightPassword"]);
    let content_diff = bool_field(payload, &["content_diff", "contentDiff"], true);
    let opts = DiffOptions {
        left_password,
        right_password,
        content: content_diff,
        ..DiffOptions::default()
    };
    let report = with_progress(|progress| core_diff(&left, &right, &opts, Some(progress)))?;
    to_data(report)
}

pub fn hash_archive(payload: &Value) -> Result<Value, String> {
    let path = str_field(payload, &["path"])?;
    let algorithm = opt_str(payload, &["algorithm"]);
    let password = opt_str(payload, &["password"]);
    let algo = match algorithm.as_deref() {
        Some("sha1") | Some("sha-1") => HashAlgorithm::Sha1,
        Some("crc32") | Some("crc-32") => HashAlgorithm::Crc32,
        _ => HashAlgorithm::Sha256,
    };
    let opts = HashOptions {
        password,
        algorithm: algo,
        include: Vec::new(),
        match_mode: MatchMode::Auto,
    };
    let report = with_progress(|progress| core_hash(&path, &opts, Some(progress)))?;
    to_data(report)
}

pub fn convert_archive(payload: &Value) -> Result<Value, String> {
    let source = str_field(payload, &["source"])?;
    let output = str_field(payload, &["output"])?;
    let format = str_field(payload, &["format"])?;
    let level = opt_str(payload, &["level"]).unwrap_or_else(|| "default".to_string());
    let opts = ConvertOptions {
        read_password: opt_str(payload, &["password"]),
        create: CreateOptions {
            format: parse_format(&format)?,
            level: parse_level(&level),
            password: None,
            split_size: None,
        },
    };
    let report = with_progress(|progress| core_convert(&source, &output, &opts, Some(progress)))?;
    to_data(report)
}

pub fn grep_archive(payload: &Value) -> Result<Value, String> {
    let path = str_field(payload, &["path"])?;
    let pattern = str_field(payload, &["pattern"])?;
    let password = opt_str(payload, &["password"]);
    let case_insensitive = bool_field(payload, &["case_insensitive", "caseInsensitive"], true);
    let opts = GrepOptions {
        password,
        case_insensitive,
        ..GrepOptions::default()
    };
    let report = with_progress(|progress| core_grep(&path, &pattern, &opts, Some(progress)))?;
    to_data(report)
}

pub fn extract_nested_archive(payload: &Value) -> Result<Value, String> {
    let path = str_field(payload, &["path"])?;
    let entry = str_field(payload, &["entry"])?;
    let password = opt_str(payload, &["password"]);
    let extracted = with_progress(|progress| {
        let base = std::env::temp_dir().join(format!(
            "ziplark-nested-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&base)?;
        let opts = ExtractOptions {
            password,
            dest: base.clone(),
            overwrite: true,
            include: vec![entry.clone()],
            match_mode: MatchMode::Exact,
            keep_broken: false,
            smart: false,
        };
        core_extract(&path, &opts, Some(progress))?;
        let extracted = base.join(entry.replace('\\', "/").trim_start_matches("./"));
        if !extracted.exists() {
            return Err(Error::other(format!(
                "nested entry could not be extracted: {entry}"
            )));
        }
        Ok(extracted.to_string_lossy().to_string())
    })?;
    to_data(extracted)
}
