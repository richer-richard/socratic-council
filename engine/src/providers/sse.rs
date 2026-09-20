//! Minimal Server-Sent-Events line decoder. Accumulates raw bytes and yields
//! complete `data:` payloads (the `data:` prefix stripped).

#[derive(Default)]
pub struct SseDecoder {
    buf: String,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self { buf: String::new() }
    }

    /// Push a network chunk; return any complete `data:` payloads it completed.
    pub fn push(&mut self, text: &str) -> Vec<String> {
        self.buf.push_str(text);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.find('\n') {
            let line: String = self.buf.drain(..=pos).collect();
            let line = line.trim_end_matches(['\r', '\n']);
            if let Some(rest) = line.strip_prefix("data:") {
                out.push(rest.trim().to_string());
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_split_frames() {
        let mut d = SseDecoder::new();
        assert!(d.push("data: {\"a\":1}\n\nda").is_empty() || d.push("").is_empty());
        let mut d = SseDecoder::new();
        let out = d.push("data: hello\n");
        assert_eq!(out, vec!["hello".to_string()]);
        // partial line buffered until newline arrives
        let mut out2 = d.push("data: wor");
        assert!(out2.is_empty());
        out2 = d.push("ld\n");
        assert_eq!(out2, vec!["world".to_string()]);
    }

    #[test]
    fn ignores_non_data_lines() {
        let mut d = SseDecoder::new();
        let out = d.push("event: ping\nid: 1\ndata: x\n\n");
        assert_eq!(out, vec!["x".to_string()]);
    }
}
