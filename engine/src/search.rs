//! Keyless web search for the seats' tools: the DuckDuckGo html endpoint
//! and the Bing RSS feed race each other (the first with results wins), then
//! Wikipedia's search API as a reference backend, then DuckDuckGo's
//! instant-answer JSON API. Every request pins English and the US region
//! (query parameters, a cookie where the engine reads one, and
//! `Accept-Language`), because the keyless engines otherwise localise
//! results to the caller's IP. Each tier is a pure parser over the response
//! body, unit-tested against fixtures without any network.

use futures_util::stream::{FuturesUnordered, StreamExt};
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
                // Decode the two trailing bytes directly. Never slice the &str
                // by computed offsets (`&s[i+1..i+3]`): when a multibyte UTF-8
                // char follows the '%', the byte index lands mid-character and
                // panics ("not a char boundary"), crashing the engine task on a
                // crafted/tampered search response.
                match (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                    (Some(hi), Some(lo)) => {
                        out.push(hi * 16 + lo);
                        i += 3;
                    }
                    _ => {
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

/// Value of a single ASCII hex digit (`0-9a-fA-F`), or `None`.
fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
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
    decode_entities(&strip_tags(s))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
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
        let Some(open_end) = tail.find('>') else {
            break;
        };
        let after = &tail[open_end + 1..];
        let end = after
            .find("</a>")
            .or_else(|| after.find("</div>"))
            .unwrap_or(0);
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
        let Some(open_end) = tail.find('>') else {
            break;
        };
        let tag = &tail[..open_end];
        let inner_after = &tail[open_end + 1..];
        let inner_end = inner_after.find("</a>").unwrap_or(0);
        let title = clean_text(&inner_after[..inner_end]);
        if let Some(href) = attr_value(tag, "href") {
            let url = resolve_ddg_href(&decode_entities(href));
            if !title.is_empty() && url.starts_with("http") {
                let snippet = snippets.get(hits.len()).cloned().unwrap_or_default();
                hits.push(SearchResultItem {
                    title,
                    url,
                    snippet,
                });
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
        let Some(s) = block.find(&open) else {
            return String::new();
        };
        let after = &block[s + open.len()..];
        let Some(e) = after.find(&close) else {
            return String::new();
        };
        clean_text(
            after[..e]
                .trim_start_matches("<![CDATA[")
                .trim_end_matches("]]>"),
        )
    }

    let mut hits = Vec::new();
    let mut rest = body;
    while let Some(s) = rest.find("<item>") {
        let after = &rest[s..];
        let Some(e) = after.find("</item>") else {
            break;
        };
        let block = &after[..e];
        let title = tag_text(block, "title");
        let url = tag_text(block, "link");
        let snippet = tag_text(block, "description");
        if !title.is_empty() && url.starts_with("http") {
            hits.push(SearchResultItem {
                title,
                url,
                snippet,
            });
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
        x.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let abstract_text = s(&v, "AbstractText");
    let abstract_url = s(&v, "AbstractURL");
    if !abstract_text.is_empty() && !abstract_url.is_empty() {
        let heading = s(&v, "Heading");
        hits.push(SearchResultItem {
            title: if heading.is_empty() {
                abstract_url.clone()
            } else {
                heading
            },
            url: abstract_url,
            snippet: abstract_text,
        });
    }
    let mut push_topic = |t: &serde_json::Value| {
        let text = s(t, "Text");
        let url = s(t, "FirstURL");
        if !text.is_empty() && !url.is_empty() {
            let title = text.split(" - ").next().unwrap_or(&text).to_string();
            hits.push(SearchResultItem {
                title,
                url,
                snippet: text.clone(),
            });
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

/// The language every search request asks for.
pub const ACCEPT_LANGUAGE: &str = "en-US,en;q=0.9";
/// Wikipedia asks API clients to identify themselves.
const WIKIPEDIA_USER_AGENT: &str =
    "socratic-council (https://github.com/richer-richard/socratic-council)";

/// One search backend: the request and a pure body parser.
pub struct SearchAttempt {
    pub name: &'static str,
    /// The query as sent, for the relevance gate on the results.
    pub query: String,
    pub url: String,
    pub accept: &'static str,
    /// A cookie pinning the region and language where the engine reads one.
    pub cookie: Option<&'static str>,
    pub user_agent: Option<&'static str>,
    pub parse: fn(&str) -> Vec<SearchResultItem>,
}

/// The backends for `query`, in priority order: DuckDuckGo html, Bing RSS,
/// Wikipedia, DuckDuckGo instant answers.
pub fn search_attempts(query: &str) -> Vec<SearchAttempt> {
    let encoded = url_encode(query.trim());
    vec![
        SearchAttempt {
            name: "duckduckgo",
            query: query.trim().to_string(),
            url: format!("https://html.duckduckgo.com/html/?q={encoded}&kl=us-en&kad=en_US"),
            accept: "text/html,application/xhtml+xml",
            cookie: Some("kl=us-en; kad=en_US"),
            user_agent: None,
            parse: parse_ddg_html,
        },
        SearchAttempt {
            name: "bing",
            query: query.trim().to_string(),
            // `ensearch=1` is the China edition's "international" switch: Bing
            // redirects callers there by IP and ignores `mkt` and `cc` alone.
            url: format!(
                "https://www.bing.com/search?format=rss&q={encoded}&mkt=en-US&setlang=en-US&cc=US&ensearch=1"
            ),
            accept: "application/rss+xml, application/xml, text/xml",
            cookie: None,
            user_agent: None,
            parse: parse_bing_rss,
        },
        SearchAttempt {
            name: "wikipedia",
            query: query.trim().to_string(),
            url: format!(
                "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit={MAX_RESULTS}&srsearch={encoded}"
            ),
            accept: "application/json",
            cookie: None,
            user_agent: Some(WIKIPEDIA_USER_AGENT),
            parse: parse_wikipedia,
        },
        SearchAttempt {
            name: "duckduckgo-instant",
            query: query.trim().to_string(),
            url: format!(
                "https://api.duckduckgo.com/?q={encoded}&format=json&no_redirect=1&no_html=1&kl=us-en"
            ),
            accept: "application/json",
            cookie: None,
            user_agent: None,
            parse: parse_ddg_instant,
        },
    ]
}

/// The canonical article URL for a Wikipedia title.
pub fn wikipedia_page_url(title: &str) -> String {
    let mut out = String::from("https://en.wikipedia.org/wiki/");
    for b in title.trim().replace(' ', "_").as_bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'~'
            | b'('
            | b')'
            | b','
            | b':'
            | b'\''
            | b'/' => out.push(*b as char),
            b => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Parse Wikipedia's `list=search` JSON: `query.search[].{title, snippet}`;
/// the snippet carries `<span class="searchmatch">` highlights.
pub fn parse_wikipedia(body: &str) -> Vec<SearchResultItem> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let Some(items) = v["query"]["search"].as_array() else {
        return Vec::new();
    };
    let hits = items
        .iter()
        .filter_map(|item| {
            let title = item["title"].as_str()?.trim();
            if title.is_empty() {
                return None;
            }
            let snippet = clean_text(item["snippet"].as_str().unwrap_or(""));
            Some(SearchResultItem {
                title: format!("{title} - Wikipedia"),
                url: wikipedia_page_url(title),
                snippet,
            })
        })
        .collect();
    normalize(hits)
}

/// `primary` first, then whatever `extra` adds, deduplicated by URL and
/// capped like a single engine's results.
pub fn merge_hits(
    primary: Vec<SearchResultItem>,
    extra: Vec<SearchResultItem>,
) -> Vec<SearchResultItem> {
    normalize(primary.into_iter().chain(extra).collect())
}

/// Query terms worth matching: lower-cased words of three or more ASCII
/// characters, or two or more when the word is not ASCII (CJK words are
/// short; a CJK query with no spaces is one term).
fn query_terms(query: &str) -> Vec<String> {
    query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| {
            let n = t.chars().count();
            if t.is_ascii() {
                n >= 3
            } else {
                n >= 2
            }
        })
        .map(|t| t.to_lowercase())
        .collect()
}

/// Keep only hits that share a term with the query in their title, snippet
/// or URL. The keyless engines sometimes answer an unmatched query with
/// unrelated (often localised) filler instead of nothing; a hit that mentions
/// none of the query's words is never evidence, and dropping it lets the
/// chain fall through to the next backend. A query with no usable term
/// keeps everything.
pub fn filter_relevant(query: &str, hits: Vec<SearchResultItem>) -> Vec<SearchResultItem> {
    let terms = query_terms(query);
    if terms.is_empty() {
        return hits;
    }
    hits.into_iter()
        .filter(|h| {
            let hay = format!("{} {} {}", h.title, h.snippet, h.url).to_lowercase();
            terms.iter().any(|t| hay.contains(t.as_str()))
        })
        .collect()
}

/// One attempt with its own timeout; empty on any failure. Hits that do not
/// mention the query are dropped.
async fn fetch(http: &reqwest::Client, attempt: &SearchAttempt) -> Vec<SearchResultItem> {
    let fut = async {
        let mut req = http
            .get(&attempt.url)
            .header("accept", attempt.accept)
            .header("accept-language", ACCEPT_LANGUAGE);
        if let Some(cookie) = attempt.cookie {
            req = req.header("cookie", cookie);
        }
        if let Some(ua) = attempt.user_agent {
            req = req.header("user-agent", ua);
        }
        let resp = req.send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        crate::providers::read_capped(resp, crate::providers::BODY_CAP)
            .await
            .ok()
    };
    match tokio::time::timeout(ATTEMPT_TIMEOUT, fut).await {
        Ok(Some(body)) => filter_relevant(&attempt.query, (attempt.parse)(&body)),
        _ => Vec::new(),
    }
}

/// Run the search chain. The two general engines race and the first one to
/// return results wins; Wikipedia and the instant-answer API follow when
/// both come back empty. Best-effort: never an error, at worst no hits.
pub async fn web_search(http: &reqwest::Client, query: &str) -> Vec<SearchResultItem> {
    let query = query.trim();
    if query.is_empty() {
        return Vec::new();
    }
    let attempts = search_attempts(query);
    let mut race: FuturesUnordered<_> = attempts[..2].iter().map(|a| fetch(http, a)).collect();
    while let Some(hits) = race.next().await {
        if !hits.is_empty() {
            return hits;
        }
    }
    for attempt in &attempts[2..] {
        let hits = fetch(http, attempt).await;
        if !hits.is_empty() {
            return hits;
        }
    }
    Vec::new()
}

/// Wikipedia alone — the reference backend claim verification tops up with.
pub async fn wikipedia_search(http: &reqwest::Client, query: &str) -> Vec<SearchResultItem> {
    let attempts = search_attempts(query);
    match attempts.iter().find(|a| a.name == "wikipedia") {
        Some(a) => fetch(http, a).await,
        None => Vec::new(),
    }
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
        assert_eq!(
            decode_entities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;"),
            "a & b <c> \"d\" 'e'"
        );
        assert_eq!(decode_entities("AT&T stays"), "AT&T stays");
        assert_eq!(
            percent_decode("https%3A%2F%2Fexample.com%2Fa+b"),
            "https://example.com/a b"
        );
        assert_eq!(url_encode("rust 1.82 论"), "rust+1.82+%E8%AE%BA");
    }

    #[test]
    fn percent_decode_survives_multibyte_after_percent() {
        // Regression: a crafted/tampered DDG href where a multibyte UTF-8 char
        // immediately follows '%' used to panic ("not a char boundary") because
        // the decoder sliced the &str by byte offset. It must now degrade to a
        // literal '%' and never panic.
        assert_eq!(percent_decode("%论abc"), "%论abc");
        assert_eq!(percent_decode("%41%论"), "A%论");
        // Trailing/garbage escapes stay literal rather than crashing.
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("a%"), "a%");
        // Reached through the real DDG-redirect path with a hostile uddg value.
        let _ = resolve_ddg_href("//duckduckgo.com/l/?uddg=%论rest");
    }

    #[test]
    fn resolves_ddg_redirect_hrefs() {
        let href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rust%2Dlang.org%2F&rut=abc";
        assert_eq!(resolve_ddg_href(href), "https://www.rust-lang.org/");
        assert_eq!(
            resolve_ddg_href("https://direct.example.com/x"),
            "https://direct.example.com/x"
        );
        assert_eq!(
            resolve_ddg_href("//cdn.example.com/y"),
            "https://cdn.example.com/y"
        );
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
    fn attempts_pin_english_us_on_every_engine() {
        let a = search_attempts("rust lang");
        assert_eq!(
            a.iter().map(|x| x.name).collect::<Vec<_>>(),
            ["duckduckgo", "bing", "wikipedia", "duckduckgo-instant"]
        );
        assert!(a[0].url.contains("q=rust+lang") && a[0].url.contains("kl=us-en"));
        assert_eq!(a[0].cookie, Some("kl=us-en; kad=en_US"));
        assert!(a[1].url.contains("mkt=en-US") && a[1].url.contains("cc=US"));
        assert!(a[1].url.contains("ensearch=1"));
        assert!(a[2].url.starts_with("https://en.wikipedia.org/w/api.php?"));
        assert!(a[2].url.contains("srsearch=rust+lang"));
        assert!(a[2].user_agent.unwrap().contains("socratic-council"));
        assert!(a[3].url.contains("kl=us-en"));
        assert_eq!(ACCEPT_LANGUAGE, "en-US,en;q=0.9");
    }

    #[test]
    fn parses_wikipedia_search_json() {
        let body = r#"{"batchcomplete":"","query":{"searchinfo":{"totalhits":2},"search":[
          {"ns":0,"title":"Rust (programming language)","pageid":1,"snippet":"<span class=\"searchmatch\">Rust</span> is a general-purpose &amp; systems language","timestamp":"2026-01-01T00:00:00Z"},
          {"ns":0,"title":"Rust","pageid":2,"snippet":"<span class=\"searchmatch\">Rust</span> is an iron oxide"},
          {"ns":0,"title":"   ","pageid":3,"snippet":"blank title is skipped"}
        ]}}"#;
        let hits = parse_wikipedia(body);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "Rust (programming language) - Wikipedia");
        assert_eq!(
            hits[0].url,
            "https://en.wikipedia.org/wiki/Rust_(programming_language)"
        );
        assert_eq!(
            hits[0].snippet,
            "Rust is a general-purpose & systems language"
        );
        assert_eq!(hits[1].url, "https://en.wikipedia.org/wiki/Rust");
        assert!(parse_wikipedia("not json").is_empty());
        assert!(parse_wikipedia(r#"{"query":{}}"#).is_empty());
        assert_eq!(
            wikipedia_page_url("Café au lait"),
            "https://en.wikipedia.org/wiki/Caf%C3%A9_au_lait"
        );
    }

    #[test]
    fn relevance_gate_drops_filler_and_keeps_matches() {
        let mk = |t: &str, snip: &str, url: &str| SearchResultItem {
            title: t.into(),
            url: url.into(),
            snippet: snip.into(),
        };
        let hits = vec![
            mk("广州市私家侦探", "婚外情调查", "https://example.cn/x"),
            mk(
                "Flaky Tests at Google",
                "About 1.5% of runs are flaky",
                "https://testing.googleblog.com/",
            ),
            mk(
                "Unrelated",
                "nothing here",
                "https://example.com/ci-builds-guide",
            ),
        ];
        let kept = filter_relevant("flaky test prevalence CI builds", hits);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].title, "Flaky Tests at Google");
        assert_eq!(
            kept[1].url, "https://example.com/ci-builds-guide",
            "a URL match counts"
        );
        // Short or empty queries keep everything rather than guess.
        assert_eq!(
            filter_relevant("ab", vec![mk("x", "y", "https://z")]).len(),
            1
        );
        assert_eq!(query_terms("Rust-lang 1.82 论文"), ["rust", "lang", "论文"]);
        assert_eq!(search_attempts("a b")[1].query, "a b");
    }

    #[test]
    fn merge_hits_keeps_primary_first_and_dedupes() {
        let mk = |t: &str, url: &str| SearchResultItem {
            title: t.into(),
            url: url.into(),
            snippet: String::new(),
        };
        let merged = merge_hits(
            vec![mk("a", "https://a"), mk("b", "https://b")],
            vec![
                mk("dup", "https://a"),
                mk("w", "https://en.wikipedia.org/wiki/W"),
            ],
        );
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].title, "a");
        assert_eq!(merged[2].title, "w");
    }

    #[test]
    fn normalize_dedupes_and_caps() {
        let mk = |i: usize, url: &str| SearchResultItem {
            title: format!("t{i}"),
            url: url.to_string(),
            snippet: String::new(),
        };
        let hits = normalize(vec![
            mk(1, "https://a"),
            mk(2, "https://a"),
            mk(3, "https://b"),
            mk(4, "https://c"),
            mk(5, "https://d"),
            mk(6, "https://e"),
            mk(7, "https://f"),
        ]);
        assert_eq!(hits.len(), MAX_RESULTS);
        assert_eq!(hits[0].title, "t1");
        assert_eq!(hits[1].url, "https://b");
        assert_eq!(format_results(&[]), "No results found.");
        assert!(format_results(&hits).starts_with("1. t1 - https://a"));
    }
}
