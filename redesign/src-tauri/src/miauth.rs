//! MiAuth 本地回环回调：成熟的一次性 loopback OAuth 监听（std TcpListener，零新依赖）。
//!
//! 契约（chat 页面前端使用）：
//! - `miauth_begin(session)`：`session` 必须是带连字符的标准 UUID（前端 `crypto.randomUUID()`），
//!   校验通过后绑定 127.0.0.1 随机端口并返回端口号。同一时间只有一个监听；重复 begin 自动作废旧监听。
//! - 授权 URL 的 callback 必须注册为 `http://127.0.0.1:{port}/miauth/callback`，
//!   Misskey 会在其后追加 `?session={session}`。
//! - 仅当路径为 `/miauth/callback` 且 `session` 查询值与 begin 一致才视为有效回调；
//!   favicon / 其他路径 / session 不匹配一律 404 并继续等待，不消耗监听。
//! - 有效回调向 chat 窗口（仅 chat，不广播 token）发 `miauth-callback`
//!   `{ ok: true, query, session }`，`query` 为原始查询串；token 换取由前端完成，壳不验证 token。
//! - 5 分钟超时自动关闭并发 `{ ok: false, error: "timeout", session }`；`miauth_end(session)`
//!   按 session 身份取消，不会误清后来 begin 的新监听（陈旧取消方身份不符时不产生任何事件）。

use serde_json::json;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

/// 回调等待上限：5 分钟。
const WAIT_DEADLINE: Duration = Duration::from_secs(5 * 60);
/// 单连接请求头读取上限（字节），防超大头部。
const MAX_HEADER_BYTES: usize = 16 * 1024;
/// 单连接读取超时。
const READ_TIMEOUT: Duration = Duration::from_secs(3);
/// 接受循环轮询间隔。
const ACCEPT_POLL: Duration = Duration::from_millis(50);

pub struct MiauthSession {
    listener: Arc<TcpListener>,
    session: String,
}

/// 全局 MiAuth 回调会话；None 表示当前无监听。
pub type MiauthState = Arc<Mutex<Option<MiauthSession>>>;

#[tauri::command]
pub fn miauth_begin(
    app: tauri::AppHandle,
    state: tauri::State<MiauthState>,
    session: String,
) -> Result<u16, String> {
    if !is_uuid(&session) {
        return Err("session 必须是带连字符的标准 UUID".into());
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let listener = Arc::new(listener);

    // 替换即作废旧监听：旧 Arc 只剩旧线程持有，旧线程按身份检查自行退出。
    {
        let mut slot = state.lock().map_err(|e| e.to_string())?;
        *slot = Some(MiauthSession {
            listener: listener.clone(),
            session: session.clone(),
        });
    }

    let app = app.clone();
    let shared = state.inner().clone();
    std::thread::spawn(move || run_listener(app, shared, listener, session));
    Ok(port)
}

/// 按 session 身份取消；身份不符（陈旧取消方）时不清除新监听。
#[tauri::command]
pub fn miauth_end(state: tauri::State<MiauthState>, session: String) {
    if let Ok(mut guard) = state.lock() {
        let matches = guard
            .as_ref()
            .map(|s| s.session == session)
            .unwrap_or(false);
        if matches {
            *guard = None;
        }
    }
}

/// 接受循环：非阻塞 accept + 截止时间；身份不符立即静默退出。
fn run_listener(
    app: tauri::AppHandle,
    shared: MiauthState,
    listener: Arc<TcpListener>,
    session: String,
) {
    let deadline = Instant::now() + WAIT_DEADLINE;
    loop {
        if !still_current(&shared, &listener) {
            return;
        }
        if Instant::now() >= deadline {
            if take_if_current(&shared, &listener) {
                let _ = app.emit_to(
                    "chat",
                    "miauth-callback",
                    json!({ "ok": false, "error": "timeout", "session": session }),
                );
            }
            return;
        }
        match listener.accept() {
            Ok((mut stream, _)) => match serve_connection(&mut stream, &session) {
                ConnResult::Authorized(query) => {
                    // 仅发往 chat 窗口：token 不进入全局事件。
                    let _ = app.emit_to(
                        "chat",
                        "miauth-callback",
                        json!({ "ok": true, "query": query, "session": session }),
                    );
                    take_if_current(&shared, &listener);
                    return;
                }
                ConnResult::Ignored => {} // favicon / 其他路径 / session 不符：继续等待
            },
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(ACCEPT_POLL);
            }
            Err(_) => return, // 监听套接字异常：退出
        }
    }
}

enum ConnResult {
    /// 有效回调：携带原始查询串。
    Authorized(String),
    /// 可忽略请求：已给对端答复，继续监听。
    Ignored,
}

fn serve_connection(stream: &mut TcpStream, expected_session: &str) -> ConnResult {
    let head = match read_request_head(stream) {
        Ok(head) => head,
        Err(_) => {
            let _ = stream.write_all(RESP_BAD_REQUEST.as_bytes());
            return ConnResult::Ignored;
        }
    };
    match classify_request(&head, expected_session) {
        RequestOutcome::Authorized(query) => {
            let _ = stream.write_all(success_response().as_bytes());
            ConnResult::Authorized(query)
        }
        RequestOutcome::Rejected => {
            let _ = stream.write_all(RESP_NOT_FOUND.as_bytes());
            ConnResult::Ignored
        }
    }
}

/// 监听是否仍是当前会话（身份检查，防陈旧线程误操作）。
fn still_current(shared: &MiauthState, listener: &Arc<TcpListener>) -> bool {
    shared
        .lock()
        .map(|s| {
            matches!(s.as_ref(), Some(sess) if Arc::ptr_eq(&sess.listener, listener))
        })
        .unwrap_or(false)
}

/// 仅当传入监听仍是当前会话时清空状态；返回是否清理成功。
fn take_if_current(shared: &MiauthState, listener: &Arc<TcpListener>) -> bool {
    let mut guard = match shared.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    match guard.as_ref() {
        Some(sess) if Arc::ptr_eq(&sess.listener, listener) => {
            *guard = None;
            true
        }
        _ => false,
    }
}

// ---------- 纯函数（有测试覆盖） ----------

/// 校验带连字符的标准 UUID：8-4-4-4-12 十六进制，大小写均可。
pub fn is_uuid(s: &str) -> bool {
    let groups = [8usize, 4, 4, 4, 12];
    let mut parts = s.split('-');
    for len in groups {
        match parts.next() {
            Some(p) if p.len() == len && p.bytes().all(|b| b.is_ascii_hexdigit()) => {}
            _ => return false,
        }
    }
    parts.next().is_none()
}

/// 从原始请求头解析请求行，要求 `GET <target> <version>` 三段式。
/// 方法非 GET、缺版本号或有多余字段视为畸形，返回 None。
pub fn parse_request_line(head: &str) -> Option<(&str, &str)> {
    let line = head.lines().next()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    let target = parts.next()?;
    let _version = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if method != "GET" {
        return None;
    }
    Some((method, target))
}

/// 校验回调目标：路径必须恰为 `/miauth/callback`，且 `session` 查询值与预期一致
/// （十六进制大小写不敏感）。通过则返回原样查询串（含 session，供前端二次校验）。
pub fn callback_query(target: &str, expected_session: &str) -> Option<String> {
    let (path, query) = target.split_once('?')?;
    if path != "/miauth/callback" {
        return None;
    }
    let wanted = query_params(query)
        .into_iter()
        .find(|(k, _)| k == "session")
        .map(|(_, v)| v)?;
    if !wanted.eq_ignore_ascii_case(expected_session) {
        return None;
    }
    Some(query.to_string())
}

/// 极简 urlencoded 键值解析（不做百分号解码；session 为十六进制 UUID，不含保留字符）。
fn query_params(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            if k.is_empty() {
                return None;
            }
            Some((k.to_string(), v.to_string()))
        })
        .collect()
}

/// 请求分类结果。
pub enum RequestOutcome {
    Authorized(String),
    Rejected,
}

/// 组合判定：请求行合法且为期望 session 的回调 → Authorized。
pub fn classify_request(head: &str, expected_session: &str) -> RequestOutcome {
    let Some((_, target)) = parse_request_line(head) else {
        return RequestOutcome::Rejected;
    };
    match callback_query(target, expected_session) {
        Some(query) => RequestOutcome::Authorized(query),
        None => RequestOutcome::Rejected,
    }
}

/// 有界读取 HTTP 头部：读到空行（CRLFCRLF，容忍 LFLF）为止；
/// 超过字节上限或读取超时返回 Err。EOF 早停按已有内容解析。
pub fn read_request_head(stream: &mut TcpStream) -> std::io::Result<String> {
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        if find_header_end(&buf).is_some() {
            break;
        }
        if buf.len() > MAX_HEADER_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "request head too large",
            ));
        }
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// 头部结束符：`\r\n\r\n`（容忍 `\n\n`）。
fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4)
        .position(|w| w == b"\r\n\r\n")
        .or_else(|| buf.windows(2).position(|w| w == b"\n\n"))
}

/// 成功页文案：仅说明「已收到授权回应」，不声称 token 已验证（token 校验由前端完成）。
pub fn success_page() -> &'static str {
    "<!doctype html><meta charset=\"utf-8\"><title>Aliya Pet</title>\
<body style=\"font-family:sans-serif;display:flex;min-height:90vh;align-items:center;\
justify-content:center;margin:0;background:#faf7f1;color:#4a4238\">\
<div style=\"text-align:center\"><p style=\"font-size:20px;margin:0 0 8px\">已收到授权回应</p>\
<p style=\"margin:0;color:#8b7f6f\">回到 Aliya 查看连接结果。</p></div></body>"
}

fn success_response() -> String {
    let page = success_page();
    format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        page.len(),
        page
    )
}

const RESP_NOT_FOUND: &str =
    "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
const RESP_BAD_REQUEST: &str =
    "HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "6d3f1a26-8f7e-4c1a-9a52-3f9f2b7c8d01";

    #[test]
    fn accepts_standard_hyphen_uuid() {
        assert!(is_uuid(SESSION));
        assert!(is_uuid("6D3F1A26-8F7E-4C1A-9A52-3F9F2B7C8D01"));
    }

    #[test]
    fn rejects_non_uuid_sessions() {
        // Misskey 旧式 32 位无连字符形式必须拒绝
        assert!(!is_uuid("6d3f1a268f7e4c1a9a523f9f2b7c8d01"));
        assert!(!is_uuid("6d3f1a26-8f7e-4c1a-9a52-3f9f2b7c8d0")); // 组长不足
        assert!(!is_uuid("6d3f1a2-8f7e-4c1a-9a52-3f9f2b7c8d01")); // 首组过短
        assert!(!is_uuid("6d3f1a2g-8f7e-4c1a-9a52-3f9f2b7c8d01")); // 非十六进制
        assert!(!is_uuid(""));
        assert!(!is_uuid("----"));
        assert!(!is_uuid("6d3f1a26-8f7e-4c1a-9a52-3f9f2b7c8d01-extra")); // 多余组
    }

    #[test]
    fn parses_get_request_line() {
        let head = "GET /miauth/callback?session=6d3f1a26 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        let (method, target) = parse_request_line(head).unwrap();
        assert_eq!(method, "GET");
        assert_eq!(target, "/miauth/callback?session=6d3f1a26");
    }

    #[test]
    fn rejects_non_get_and_malformed_request_lines() {
        assert!(parse_request_line("POST /miauth/callback HTTP/1.1\r\n\r\n").is_none());
        // HTTP/0.9 风格缺版本号
        assert!(parse_request_line("GET /miauth/callback\r\n\r\n").is_none());
        assert!(parse_request_line("").is_none());
        assert!(parse_request_line("GET /a HTTP/1.1 junk\r\n\r\n").is_none());
    }

    #[test]
    fn callback_matches_expected_session() {
        let target = format!("/miauth/callback?session={SESSION}");
        let query = callback_query(&target, SESSION).unwrap();
        assert_eq!(query, format!("session={SESSION}"));
    }

    #[test]
    fn callback_session_hex_case_insensitive() {
        let upper = SESSION.to_uppercase();
        let target = format!("/miauth/callback?session={upper}");
        assert!(callback_query(&target, SESSION).is_some());
    }

    #[test]
    fn callback_rejects_wrong_or_missing_session() {
        let other = "11111111-2222-4333-8444-555555555555";
        assert!(callback_query(&format!("/miauth/callback?session={other}"), SESSION).is_none());
        assert!(callback_query("/miauth/callback", SESSION).is_none());
        assert!(callback_query("/miauth/callback?foo=bar", SESSION).is_none());
    }

    #[test]
    fn callback_rejects_foreign_paths_but_keeps_query() {
        assert!(callback_query(&format!("/?session={SESSION}"), SESSION).is_none());
        assert!(callback_query(&format!("/favicon.ico?session={SESSION}"), SESSION).is_none());
        assert!(
            callback_query(&format!("/miauth/callback/extra?session={SESSION}"), SESSION).is_none()
        );
    }

    #[test]
    fn classify_routes_callback_and_favicon() {
        let ok = format!("GET /miauth/callback?session={SESSION} HTTP/1.1\r\n\r\n");
        assert!(matches!(
            classify_request(&ok, SESSION),
            RequestOutcome::Authorized(_)
        ));
        assert!(matches!(
            classify_request("GET /favicon.ico HTTP/1.1\r\n\r\n", SESSION),
            RequestOutcome::Rejected
        ));
        assert!(matches!(
            classify_request("HEAD /miauth/callback HTTP/1.1\r\n\r\n", SESSION),
            RequestOutcome::Rejected
        ));
    }

    #[test]
    fn success_page_reports_receipt_not_verification() {
        let page = success_page();
        assert!(page.contains("已收到授权回应"));
        // 不得声称 token 已验证 / 已连接成功
        assert!(!page.contains("已验证"));
        assert!(!page.contains("已连接"));
        assert!(!page.contains("验证成功"));
    }

    #[test]
    fn read_request_head_parses_real_loopback_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let mut client = TcpStream::connect(addr).unwrap();
        client
            .write_all(format!("GET /miauth/callback?session={SESSION} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
            .unwrap();
        let (mut server, _) = listener.accept().unwrap();
        let head = read_request_head(&mut server).unwrap();
        assert!(head.starts_with("GET /miauth/callback"));
        assert!(head.contains("\r\n\r\n"));
        assert!(matches!(
            classify_request(&head, SESSION),
            RequestOutcome::Authorized(q) if q == format!("session={SESSION}")
        ));
    }

    #[test]
    fn read_request_head_rejects_oversized_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let mut client = TcpStream::connect(addr).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        // 17KB 无空行的头部：超过 16KB 上限必须报错而不是无限等待
        let junk = vec![b'a'; MAX_HEADER_BYTES + 1024];
        client.write_all(&junk).unwrap();
        assert!(read_request_head(&mut server).is_err());
    }
}
