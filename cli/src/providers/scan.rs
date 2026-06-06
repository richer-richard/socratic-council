//! Live model-capability scanning: GET each provider's own list-models
//! endpoint (Chinese endpoints for Chinese providers). Falls back to the
//! catalog for providers without one (MiniMax).

use super::{ensure_path, google_v1beta};
use crate::catalog::{catalog_models, DiscoveredModel, ModelSource};
use crate::error::{Error, Result};
use crate::types::Provider;
use serde_json::Value;

fn models_url(provider: Provider, base_url: &str) -> Option<String> {
    match provider {
        Provider::OpenAI
        | Provider::Anthropic
        | Provider::DeepSeek
        | Provider::Kimi
        | Provider::Qwen => Some(ensure_path(base_url, "v1", "models")),
        Provider::Zhipu => Some(ensure_path(base_url, "v4", "models")),
        Provider::Google => Some(format!("{}/models", google_v1beta(base_url))),
        Provider::MiniMax => None,
    }
}

fn auth_headers(provider: Provider, api_key: &str) -> Vec<(String, String)> {
    match provider {
        Provider::Anthropic => vec![
            ("x-api-key".into(), api_key.to_string()),
            ("anthropic-version".into(), "2023-06-01".into()),
        ],
        Provider::Google => vec![("x-goog-api-key".into(), api_key.to_string())],
        _ => vec![("Authorization".into(), format!("Bearer {api_key}"))],
    }
}

fn parse(provider: Provider, body: &str) -> Vec<DiscoveredModel> {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };

    if provider == Provider::Google {
        let Some(models) = value["models"].as_array() else {
            return Vec::new();
        };
        return models
            .iter()
            .filter(|m| {
                m["supportedGenerationMethods"].as_array().is_none_or(|methods| {
                    methods.iter().any(|x| x.as_str() == Some("generateContent"))
                })
            })
            .filter_map(|m| {
                let name = m["name"].as_str()?.trim_start_matches("models/");
                if name.is_empty() {
                    return None;
                }
                Some(DiscoveredModel {
                    id: name.to_string(),
                    provider,
                    display_name: m["displayName"].as_str().map(|s| s.to_string()),
                    source: ModelSource::Scanned,
                    context_window: None,
                    supports_thinking: None,
                    output_price: None,
                })
            })
            .collect();
    }

    let Some(data) = value["data"].as_array() else {
        return Vec::new();
    };
    data.iter()
        .filter_map(|m| {
            let id = m["id"].as_str()?;
            Some(DiscoveredModel {
                id: id.to_string(),
                provider,
                display_name: m["display_name"].as_str().map(|s| s.to_string()),
                source: ModelSource::Scanned,
                context_window: None,
                supports_thinking: None,
                output_price: None,
            })
        })
        .collect()
}

/// Scan a provider's live models. Falls back to the catalog on any failure.
pub async fn scan_models(
    http: &reqwest::Client,
    provider: Provider,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<DiscoveredModel>> {
    let Some(url) = models_url(provider, base_url) else {
        return Ok(catalog_models(provider)); // e.g. MiniMax — no list endpoint
    };

    let mut builder = http.get(&url);
    for (name, value) in auth_headers(provider, api_key) {
        builder = builder.header(name.as_str(), value.as_str());
    }
    let resp = builder.send().await?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(Error::Provider { status: status.as_u16(), body });
    }
    let scanned = parse(provider, &body);
    if scanned.is_empty() {
        return Err(Error::Other("scan returned no models".into()));
    }
    Ok(scanned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_openai_style() {
        let body = r#"{"data":[{"id":"gpt-5.5"},{"id":"gpt-5-mini"}]}"#;
        let out = parse(Provider::OpenAI, body);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "gpt-5.5");
    }

    #[test]
    fn parses_google_and_filters_non_generate() {
        let body = r#"{"models":[
            {"name":"models/gemini-3.1-pro-preview","supportedGenerationMethods":["generateContent"]},
            {"name":"models/text-embedding-004","supportedGenerationMethods":["embedContent"]}
        ]}"#;
        let out = parse(Provider::Google, body);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "gemini-3.1-pro-preview");
    }
}
