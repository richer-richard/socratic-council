//! Keyless web search for the oracle tools — the app's three-tier chain
//! (`services/tools.ts`) in pure Rust: the DuckDuckGo html endpoint first,
//! then the Bing RSS feed, then DuckDuckGo's instant-answer JSON API. Each
//! tier is a pure parser over the response body, so all three are unit-tested
//! against fixtures without any network.

use std::time::Duration;

/// One normalized search hit.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchResultItem {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// Results returned per query (the core oracle's normalize limit).
const MAX_RESULTS: usize = 5;
/// Per-attempt budget; the whole chain is also capped by the caller's 25 s.
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(12);

/// Decode the HTML entities that actually occur in DDG/Bing payloads.
pub fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        let semi = tail.find(';').filter(|i| *i <= 10);
        match semi {
            Some(end) => {
                let entity = &tail[1..end];
                match entity {
                    "amp" => out.push('&'),
                    "lt" => out.push('<'),
                    "gt" => out.push('>'),
                    "quot" => out.push('"'),
                    "apos" => out.push('\''),
                    "nbsp" => out.push(' '),
                    _ if entity.starts_with('#') => {
                        let num = entity.trim_start_matches('#');
                        let code = if let Some(hex) = num.strip_prefix(['x', 'X']) {
                            u32::from_str_radix(hex, 16).ok()
                        } else {
                            num.parse::<u32>().ok()
                        };
                        match code.and_then(char::from_u32) {
                            Some(c) => out.push(c),
                            None => out.push_str(&tail[..end + 1]),
                        }
                    }
                    _ => out.push_str(&tail[..end + 1]),
                }
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Percent-decode a URL component (`+` becomes a space).
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = &s[i + 1..i + 3];
                match u8::from_str_radix(hex, 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// Resolve a DDG result href: `//duckduckgo.com/l/?uddg=<encoded>&…` redirect
/// links unwrap to their real target; everything else passes through.
pub fn resolve_ddg_href(href: &str) -> String {
    let href = href.trim();
    if let Some(q) = href.find("uddg=") {
        let tail = &href[q + 5..];
        let end = tail.find('&').unwrap_or(tail.len());
        let decoded = percent_decode(&tail[..end]);
        if decoded.starts_with("http") {
            return decoded;
        }
    }
    if let Some(rest) = href.strip_prefix("//") {
        return format!("https://{rest}");
    }
    href.to_string()
}

fn clean_text(s: &str) -> String {
    decode_entities(&strip_tags(s)).split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Extract `attr="…"` from a tag string.
fn attr_value<'a>(tag: &'a str, attr: &str) -> Option<&'a str> {
    let probe = format!("{attr}=\"");
    let at = tag.find(&probe)? + probe.len();
    let end = tag[at..].find('"')? + at;
    Some(&tag[at..end])
}

/// Parse the DuckDuckGo html-lite results page: anchors with class
/// `result__a` carry the title + (redirect) href; `result__snippet` elements
/// carry the snippet, paired in document order.
pub fn parse_ddg_html(body: &str) -> Vec<SearchResultItem> {
    let mut hits: Vec<SearchResultItem> = Vec::new();
    let mut snippets: Vec<String> = Vec::new();

    // Collect snippets first (anchors or divs with class result__snippet).
    let mut rest = body;
    while let Some(at) = rest.find("result__snippet") {
        let tail = &rest[at..];
        let Some(open_end) = tail.find('>') else { break };
        let after = &tail[open_end + 1..];
        let end = after.find("</a>").or_else(|| after.find("</div>")).unwrap_or(0);
        snippets.push(clean_text(&after[..end]));
        rest = &after[end..];
    }

    let mut rest = body;
    while let Some(at) = rest.find("result__a") {
        // Walk back to the start of the enclosing `<a` tag.
        let tag_start = body.len() - rest.len() + at;
        let head = &body[..tag_start];
        let Some(open) = head.rfind("<a") else { break };
        let tail = &body[open..];
        let Some(open_end) = tail.find('>') else { break };
        let tag = &tail[..open_end];
        let inner_after = &tail[open_end + 1..];
        let inner_end = inner_after.find("</a>").unwrap_or(0);
        let title = clean_text(&inner_after[..inner_end]);
        if let Some(href) = attr_value(tag, "href") {
            let url = resolve_ddg_href(&decode_entities(href));
            if !title.is_empty() && url.starts_with("http") {
                let snippet = snippets.get(hits.len()).cloned().unwrap_or_default();
                hits.push(SearchResultItem { title, url, snippet });
            }
        }
        rest = &rest[at + "result__a".len()..];
    }
    normalize(hits)
}

/// Parse a Bing RSS search feed (`<item><title/><link/><description/></item>`).
pub fn parse_bing_rss(body: &str) -> Vec<SearchResultItem> {
    fn tag_text(block: &str, tag: &str) -> String {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        let Some(s) = block.find(&open) else { return String::new() };
        let after = &block[s + open.len()..];
        let Some(e) = after.find(&close) else { return String::new() };
        clean_text(after[..e].trim_start_matches("<![CDATA[").trim_end_matches("]]>"))
    }

    let mut hits = Vec::new();
    let mut rest = body;
    while let Some(s) = rest.find("<item>") {
        let after = &rest[s..];
        let Some(e) = after.find("</item>") else { break };
        let block = &after[..e];
        let title = tag_text(block, "title");
        let url = tag_text(block, "link");
        let snippet = tag_text(block, "description");
        if !title.is_empty() && url.starts_with("http") {
            hits.push(SearchResultItem { title, url, snippet });
        }
        rest = &after[e + "</item>".len()..];
    }
    normalize(hits)
}

/// Parse the DuckDuckGo instant-answer JSON API.
pub fn parse_ddg_instant(body: &str) -> Vec<SearchResultItem> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let mut hits = Vec::new();
    let s = |x: &serde_json::Value, k: &str| -> String {
        x.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
    };
    let abstract_text = s(&v, "AbstractText");
    let abstract_url = s(&v, "AbstractURL");
    if !abstract_text.is_empty() && !abstract_url.is_empty() {
        let heading = s(&v, "Heading");
        hits.push(SearchResultItem {
            title: if heading.is_empty() { abstract_url.clone() } else { heading },
            url: abstract_url,
            snippet: abstract_text,
        });
    }
    let mut push_topic = |t: &serde_json::Value| {
        let text = s(t, "Text");
        let url = s(t, "FirstURL");
        if !text.is_empty() && !url.is_empty() {
            let title = text.split(" - ").next().unwrap_or(&text).to_string();
            hits.push(SearchResultItem { title, url, snippet: text.clone() });
        }
    };
    if let Some(topics) = v.get("RelatedTopics").and_then(|t| t.as_array()) {
        for topic in topics {
            push_topic(topic);
            if let Some(subs) = topic.get("Topics").and_then(|t| t.as_array()) {
                for sub in subs {
                    push_topic(sub);
                }
            }
        }
    }
    normalize(hits)
}

fn normalize(hits: Vec<SearchResultItem>) -> Vec<SearchResultItem> {
    let mut seen = std::collections::HashSet::new();
    hits.into_iter()
        .filter(|h| !h.title.is_empty() && !h.url.is_empty())
        .filter(|h| seen.insert(h.url.clone()))
        .take(MAX_RESULTS)
        .collect()
}

/// Format hits the way the app posts tool results into the transcript.
pub fn format_results(hits: &[SearchResultItem]) -> String {
    if hits.is_empty() {
        return "No results found.".to_string();
    }
    hits.iter()
        .enumerate()
        .map(|(i, h)| format!("{}. {} - {}\n{}", i + 1, h.title, h.url, h.snippet))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// One search backend: URL, accept header, and a pure body parser.
type SearchAttempt = (String, &'static str, fn(&str) -> Vec<SearchResultItem>);

/// Run the three-tier search chain. Best-effort: each tier gets its own
/// timeout; the first tier yielding results wins.
pub async fn web_search(http: &reqwest::Client, query: &str) -> Vec<SearchResultItem> {
    let query = query.trim();
    if query.is_empty() {
        return Vec::new();
    }
    let encoded: String = url_encode(query);
    let attempts: [SearchAttempt; 3] = [
        (
            format!("https://html.duckduckgo.com/html/?q={encoded}"),
            "text/html,application/xhtml+xml",
            parse_ddg_html,
        ),
        (
            format!("https://www.bing.com/search?format=rss&q={encoded}"),
            "application/rss+xml, application/xml, text/xml",
            parse_bing_rss,
        ),
        (
            format!("https://api.duckduckgo.com/?q={encoded}&format=json&no_redirect=1&no_html=1"),
            "application/json",
            parse_ddg_instant,
        ),
    ];

    for (url, accept, parser) in attempts {
        let fut = async {
            let resp = http.get(&url).header("accept", accept).send().await.ok()?;
            if !resp.status().is_success() {
                return None;
            }
            resp.text().await.ok()
        };
        if let Ok(Some(body)) = tokio::time::timeout(ATTEMPT_TIMEOUT, fut).await {
            let hits = parser(&body);
            if !hits.is_empty() {
                return hits;
            }
        }
    }
    Vec::new()
}

/// Minimal percent-encoder for a query-string value.
pub fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            b' ' => out.push('+'),
            b => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_entities_and_percent_escapes() {
        assert_eq!(decode_entities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;"), "a & b <c> \"d\" 'e'");
        assert_eq!(decode_entities("AT&T stays"), "AT&T stays");
        assert_eq!(percent_decode("https%3A%2F%2Fexample.com%2Fa+b"), "https://example.com/a b");
        assert_eq!(url_encode("rust 1.82 论"), "rust+1.82+%E8%AE%BA");
    }

    #[test]
    fn resolves_ddg_redirect_hrefs() {
        let href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rust%2Dlang.org%2F&rut=abc";
        assert_eq!(resolve_ddg_href(href), "https://www.rust-lang.org/");
        assert_eq!(resolve_ddg_href("https://direct.example.com/x"), "https://direct.example.com/x");
        assert_eq!(resolve_ddg_href("//cdn.example.com/y"), "https://cdn.example.com/y");
    }

    #[test]
    fn parses_ddg_html_results() {
        let body = r##"
          <div class="result">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">First <b>Result</b></a>
            <a class="result__snippet" href="#">Snippet one with &amp; entity.</a>
          </div>
          <div class="result">
            <a class="result__a" href="https://example.com/two">Second Result</a>
            <a class="result__snippet" href="#">Snippet two.</a>
          </div>"##;
        let hits = parse_ddg_html(body);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "First Result");
        assert_eq!(hits[0].url, "https://example.com/one");
        assert_eq!(hits[0].snippet, "Snippet one with & entity.");
        assert_eq!(hits[1].url, "https://example.com/two");
    }

    #[test]
    fn parses_bing_rss_items() {
        let body = r#"<rss><channel>
          <item><title>Bing &quot;One&quot;</title><link>https://example.com/a</link><description>Alpha &amp; beta.</description></item>
          <item><title><![CDATA[Bing Two]]></title><link>https://example.com/b</link><description>Gamma.</description></item>
          <item><title>No link</title><description>skipped</description></item>
        </channel></rss>"#;
        let hits = parse_bing_rss(body);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "Bing \"One\"");
        assert_eq!(hits[0].snippet, "Alpha & beta.");
        assert_eq!(hits[1].title, "Bing Two");
    }

    #[test]
    fn parses_ddg_instant_json() {
        let body = r#"{
          "Heading": "Rust",
          "AbstractText": "Rust is a systems language.",
          "AbstractURL": "https://en.wikipedia.org/wiki/Rust_(programming_language)",
          "RelatedTopics": [
            {"Text": "Cargo - the package manager", "FirstURL": "https://doc.rust-lang.org/cargo/"},
            {"Topics": [{"Text": "Clippy - lints", "FirstURL": "https://github.com/rust-lang/rust-clippy"}]}
          ]
        }"#;
        let hits = parse_ddg_instant(body);
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].title, "Rust");
        assert_eq!(hits[1].title, "Cargo");
        assert_eq!(hits[2].url, "https://github.com/rust-lang/rust-clippy");
        assert!(parse_ddg_instant("not json").is_empty());
    }

    #[test]
    fn normalize_dedupes_and_caps() {
        let mk = |i: usize, url: &str| SearchResultItem {
            title: format!("t{i}"),
            url: url.to_string(),
            snippet: String::new(),
        };
        let hits = normalize(vec![
            mk(1, "https://a"), mk(2, "https://a"), mk(3, "https://b"), mk(4, "https://c"),
            mk(5, "https://d"), mk(6, "https://e"), mk(7, "https://f"),
        ]);
        assert_eq!(hits.len(), MAX_RESULTS);
        assert_eq!(hits[0].title, "t1");
        assert_eq!(hits[1].url, "https://b");
        assert_eq!(format_results(&[]), "No results found.");
        assert!(format_results(&hits).starts_with("1. t1 - https://a"));
    }
}
