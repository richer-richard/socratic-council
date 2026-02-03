//! HTTP request handling with proxy support
//!
//! This module provides HTTP request functionality that supports SOCKS5, HTTP, and HTTPS proxies.
//! It's designed to be called from the frontend via Tauri commands.

use reqwest::{Client, Proxy};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use futures_util::StreamExt;

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
fn build_proxy_url(config: &ProxyConfig) -> String {
    let auth = match (&config.username, &config.password) {
        (Some(user), Some(pass)) => format!("{}:{}@", user, pass),
        (Some(user), None) => format!("{}@", user),
        _ => String::new(),
    };

    format!("{}://{}{}:{}", config.proxy_type, auth, config.host, config.port)
}

/// Build HTTP client with optional proxy
fn build_client(proxy_config: Option<&ProxyConfig>, timeout_ms: u64) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .danger_accept_invalid_certs(false);

    if let Some(proxy) = proxy_config {
        if proxy.proxy_type != "none" && !proxy.host.is_empty() && proxy.port > 0 {
            let proxy_url = build_proxy_url(proxy);

            let proxy = match proxy.proxy_type.as_str() {
                "socks5" | "socks5h" => {
                    Proxy::all(&proxy_url).map_err(|e| format!("Failed to create SOCKS5 proxy: {}", e))?
                }
                "http" | "https" => {
                    Proxy::all(&proxy_url).map_err(|e| format!("Failed to create HTTP proxy: {}", e))?
                }
                _ => return Err(format!("Unsupported proxy type: {}", proxy.proxy_type)),
            };

            builder = builder.proxy(proxy);
        }
    }

    builder.build().map_err(|e| format!("Failed to build HTTP client: {}", e))
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

    let body = response.text().await.map_err(|e| format!("Failed to read response body: {}", e))?;

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
    config: HttpRequestConfig,
) -> Result<(), String> {
    let request_id = config.request_id.clone().unwrap_or_else(|| "default".to_string());
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

    // Send request and stream response
    let response = request.send().await.map_err(|e| {
        let error_msg = if e.is_connect() {
            format!("Connection failed (check proxy settings): {}", e)
        } else if e.is_timeout() {
            format!("Request timed out: {}", e)
        } else {
            format!("Request failed: {}", e)
        };

        // Emit error event
        let _ = app.emit("http-stream-chunk", StreamChunk {
            request_id: request_id.clone(),
            chunk: String::new(),
            done: true,
            error: Some(error_msg.clone()),
        });

        error_msg
    })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        let error_msg = format!("HTTP {}: {}", status, body);

        let _ = app.emit("http-stream-chunk", StreamChunk {
            request_id,
            chunk: String::new(),
            done: true,
            error: Some(error_msg.clone()),
        });

        return Err(error_msg);
    }

    // Stream the response body
    let mut stream = response.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(bytes) => {
                if let Ok(text) = String::from_utf8(bytes.to_vec()) {
                    let _ = app.emit("http-stream-chunk", StreamChunk {
                        request_id: request_id.clone(),
                        chunk: text,
                        done: false,
                        error: None,
                    });
                }
            }
            Err(e) => {
                let _ = app.emit("http-stream-chunk", StreamChunk {
                    request_id: request_id.clone(),
                    chunk: String::new(),
                    done: true,
                    error: Some(format!("Stream error: {}", e)),
                });
                return Err(format!("Stream error: {}", e));
            }
        }
    }

    // Send completion event
    let _ = app.emit("http-stream-chunk", StreamChunk {
        request_id,
        chunk: String::new(),
        done: true,
        error: None,
    });

    Ok(())
}
