//! HTTP request handling with proxy support
//!
//! This module provides HTTP request functionality that supports SOCKS5, HTTP, and HTTPS proxies.
//! It's designed to be called from the frontend via Tauri commands.

use futures_util::StreamExt;
use reqwest::{Client, Proxy};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{watch, Mutex};

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;
const MAX_STREAM_BYTES: usize = 16 * 1024 * 1024;

#[derive(Default)]
pub struct RequestRegistry {
    inner: Mutex<HashMap<String, watch::Sender<bool>>>,
}

impl RequestRegistry {
    async fn register(&self, request_id: &str) -> watch::Receiver<bool> {
        let (sender, receiver) = watch::channel(false);
        self.inner
            .lock()
            .await
            .insert(request_id.to_string(), sender);
        receiver
    }

    async fn cancel(&self, request_id: &str) -> bool {
        if let Some(sender) = self.inner.lock().await.get(request_id).cloned() {
            let _ = sender.send(true);
            return true;
        }
        false
    }

    async fn unregister(&self, request_id: &str) {
        self.inner.lock().await.remove(request_id);
    }
}

/// Proxy configuration from frontend
#[derive(Debug, Clone, Deserialize)]
pub struct ProxyConfig {
    #[serde(rename = "type")]
    pub proxy_type: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// HTTP request configuration
#[derive(Debug, Deserialize)]
pub struct HttpRequestConfig {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    pub proxy: Option<ProxyConfig>,
    pub timeout_ms: Option<u64>,
    #[allow(dead_code)]
    pub stream: Option<bool>,
    pub request_id: Option<String>,
}

/// HTTP response returned to frontend
#[derive(Debug, Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub error: Option<String>,
}

/// Stream chunk event sent to frontend
#[derive(Debug, Clone, Serialize)]
pub struct StreamChunk {
    pub request_id: String,
    pub chunk: String,
    pub done: bool,
    pub error: Option<String>,
}

/// Build proxy URL from config
fn build_proxy_url(config: &ProxyConfig) -> Result<String, String> {
    let auth = match (&config.username, &config.password) {
        (Some(user), Some(pass)) => format!(
            "{}:{}@",
            urlencoding::encode(user),
            urlencoding::encode(pass)
        ),
        (Some(user), None) => format!("{}@", urlencoding::encode(user)),
        _ => String::new(),
    };

    Ok(format!(
        "{}://{}{}:{}",
        config.proxy_type, auth, config.host, config.port
    ))
}

fn emit_stream_event(
    app: &AppHandle,
    request_id: &str,
    chunk: String,
    done: bool,
    error: Option<String>,
) {
    let _ = app.emit(
        "http-stream-chunk",
        StreamChunk {
            request_id: request_id.to_string(),
            chunk,
            done,
            error,
        },
    );
}

fn format_request_error(error: reqwest::Error) -> String {
    if error.is_connect() {
        format!("Connection failed (check proxy settings): {}", error)
    } else if error.is_timeout() {
        format!("Request timed out: {}", error)
    } else {
        format!("Request failed: {}", error)
    }
}

async fn read_response_text_limited(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, String> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Failed to read response body: {}", e))?;
        if body.len() + chunk.len() > max_bytes {
            return Err(format!(
                "Response body exceeded {} bytes limit",
                max_bytes
            ));
        }
        body.extend_from_slice(&chunk);
    }

    Ok(String::from_utf8_lossy(&body).into_owned())
}

async fn read_response_text_truncated(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, String> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    let mut truncated = false;

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Failed to read response body: {}", e))?;
        let remaining = max_bytes.saturating_sub(body.len());
        if remaining == 0 {
            truncated = true;
            break;
        }

        if chunk.len() > remaining {
            body.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }

        body.extend_from_slice(&chunk);
    }

    let mut text = String::from_utf8_lossy(&body).into_owned();
    if truncated {
        text.push_str("\n...[truncated]");
    }
    Ok(text)
}

/// Build HTTP client with optional proxy
fn build_client(proxy_config: Option<&ProxyConfig>, timeout_ms: u64) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .danger_accept_invalid_certs(false);

    if let Some(proxy) = proxy_config {
        if proxy.proxy_type != "none" && !proxy.host.is_empty() && proxy.port > 0 {
            let proxy_url = build_proxy_url(proxy)?;

            let proxy = match proxy.proxy_type.as_str() {
                "socks5" | "socks5h" => Proxy::all(&proxy_url)
                    .map_err(|e| format!("Failed to create SOCKS5 proxy: {}", e))?,
                "http" | "https" => Proxy::all(&proxy_url)
                    .map_err(|e| format!("Failed to create HTTP proxy: {}", e))?,
                _ => return Err(format!("Unsupported proxy type: {}", proxy.proxy_type)),
            };

            builder = builder.proxy(proxy);
        }
    }

    builder
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

/// Make a non-streaming HTTP request
#[tauri::command]
pub async fn http_request(config: HttpRequestConfig) -> Result<HttpResponse, String> {
    let client = build_client(config.proxy.as_ref(), config.timeout_ms.unwrap_or(120000))?;

    let method = config.method.to_uppercase();
    let mut request = match method.as_str() {
        "GET" => client.get(&config.url),
        "POST" => client.post(&config.url),
        "PUT" => client.put(&config.url),
        "DELETE" => client.delete(&config.url),
        "PATCH" => client.patch(&config.url),
        _ => return Err(format!("Unsupported HTTP method: {}", method)),
    };

    // Add headers
    for (key, value) in &config.headers {
        request = request.header(key, value);
    }

    // Add body if present
    if let Some(body) = config.body {
        request = request.body(body);
    }

    // Send request
    let response = request.send().await.map_err(|e| {
        if e.is_connect() {
            format!("Connection failed (check proxy settings): {}", e)
        } else if e.is_timeout() {
            format!("Request timed out: {}", e)
        } else {
            format!("Request failed: {}", e)
        }
    })?;

    let status = response.status().as_u16();
    let mut headers = HashMap::new();
    for (key, value) in response.headers() {
        if let Ok(v) = value.to_str() {
            headers.insert(key.to_string(), v.to_string());
        }
    }

    let body = read_response_text_limited(response, MAX_RESPONSE_BYTES).await?;

    Ok(HttpResponse {
        status,
        headers,
        body,
        error: None,
    })
}

/// Make a streaming HTTP request - emits chunks via events
#[tauri::command]
pub async fn http_request_stream(
    app: AppHandle,
    registry: State<'_, RequestRegistry>,
    config: HttpRequestConfig,
) -> Result<(), String> {
    let request_id = config
        .request_id
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let client = build_client(config.proxy.as_ref(), config.timeout_ms.unwrap_or(120000))?;
    let mut cancel_rx = registry.register(&request_id).await;

    let method = config.method.to_uppercase();
    let mut request = match method.as_str() {
        "GET" => client.get(&config.url),
        "POST" => client.post(&config.url),
        "PUT" => client.put(&config.url),
        "DELETE" => client.delete(&config.url),
        "PATCH" => client.patch(&config.url),
        _ => return Err(format!("Unsupported HTTP method: {}", method)),
    };

    // Add headers
    for (key, value) in &config.headers {
        request = request.header(key, value);
    }

    // Add body if present
    if let Some(body) = config.body {
        request = request.body(body);
    }

    let result = async {
        let response = tokio::select! {
            _ = cancel_rx.changed() => {
                let error_msg = "Request aborted".to_string();
                emit_stream_event(&app, &request_id, String::new(), true, Some(error_msg.clone()));
                return Err(error_msg);
            }
            response = request.send() => response.map_err(|e| {
                let error_msg = format_request_error(e);
                emit_stream_event(&app, &request_id, String::new(), true, Some(error_msg.clone()));
                error_msg
            })?,
        };

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = read_response_text_truncated(response, MAX_ERROR_BODY_BYTES).await?;
            let error_msg = format!("HTTP {}: {}", status, body);
            emit_stream_event(&app, &request_id, String::new(), true, Some(error_msg.clone()));
            return Err(error_msg);
        }

        let mut stream = response.bytes_stream();
        let mut pending_bytes: Vec<u8> = Vec::new();
        let mut total_stream_bytes = 0usize;

        loop {
            let chunk_result = tokio::select! {
                _ = cancel_rx.changed() => {
                    let error_msg = "Request aborted".to_string();
                    emit_stream_event(&app, &request_id, String::new(), true, Some(error_msg.clone()));
                    return Err(error_msg);
                }
                chunk = stream.next() => chunk,
            };

            let Some(chunk_result) = chunk_result else {
                break;
            };

            match chunk_result {
                Ok(bytes) => {
                    total_stream_bytes += bytes.len();
                    if total_stream_bytes > MAX_STREAM_BYTES {
                        let error_msg = format!(
                            "Stream exceeded {} bytes limit",
                            MAX_STREAM_BYTES
                        );
                        emit_stream_event(&app, &request_id, String::new(), true, Some(error_msg.clone()));
                        return Err(error_msg);
                    }

                    pending_bytes.extend_from_slice(&bytes);

                    loop {
                        match std::str::from_utf8(&pending_bytes) {
                            Ok(text) => {
                                if !text.is_empty() {
                                    emit_stream_event(
                                        &app,
                                        &request_id,
                                        text.to_string(),
                                        false,
                                        None,
                                    );
                                }
                                pending_bytes.clear();
                                break;
                            }
                            Err(error) => {
                                let valid_up_to = error.valid_up_to();
                                if valid_up_to > 0 {
                                    if let Ok(text) = std::str::from_utf8(&pending_bytes[..valid_up_to])
                                    {
                                        emit_stream_event(
                                            &app,
                                            &request_id,
                                            text.to_string(),
                                            false,
                                            None,
                                        );
                                    }

                                    let remaining = pending_bytes.split_off(valid_up_to);
                                    pending_bytes = remaining;
                                }

                                if error.error_len().is_none() {
                                    break;
                                }

                                let error_msg =
                                    "Stream error: invalid UTF-8 sequence in response body".to_string();
                                emit_stream_event(
                                    &app,
                                    &request_id,
                                    String::new(),
                                    true,
                                    Some(error_msg.clone()),
                                );
                                return Err(error_msg);
                            }
                        }
                    }
                }
                Err(e) => {
                    let error_msg = format!("Stream error: {}", e);
                    emit_stream_event(&app, &request_id, String::new(), true, Some(error_msg.clone()));
                    return Err(error_msg);
                }
            }
        }

        if !pending_bytes.is_empty() {
            match String::from_utf8(pending_bytes) {
                Ok(text) => {
                    if !text.is_empty() {
                        emit_stream_event(&app, &request_id, text, false, None);
                    }
                }
                Err(_) => {
                    let error_msg = "Stream error: invalid UTF-8 sequence in response body".to_string();
                    emit_stream_event(&app, &request_id, String::new(), true, Some(error_msg.clone()));
                    return Err(error_msg);
                }
            }
        }

        emit_stream_event(&app, &request_id, String::new(), true, None);
        Ok(())
    }
    .await;

    registry.unregister(&request_id).await;
    result
}

#[tauri::command]
pub async fn http_cancel(
    request_id: String,
    registry: State<'_, RequestRegistry>,
) -> Result<bool, String> {
    Ok(registry.cancel(&request_id).await)
}
