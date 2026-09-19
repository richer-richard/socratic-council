//! Reading and searching the session's attachments.

use crate::attach::{file_search, Attachment};

/// Cap on an attachment slice handed back to a model.
pub const READ_CHAR_CAP: usize = 12_000;

/// A slice of one attachment's text by character offset.
pub fn read_attachment(
    attachments: &[Attachment],
    name: &str,
    start: usize,
    length: Option<usize>,
) -> Result<String, String> {
    let a = attachments
        .iter()
        .find(|a| a.name.eq_ignore_ascii_case(name.trim()))
        .ok_or_else(|| {
            let names: Vec<&str> = attachments.iter().map(|a| a.name.as_str()).collect();
            format!(
                "no attachment named {name:?}; attached: {}",
                names.join(", ")
            )
        })?;
    let total = a.text.chars().count();
    let len = length.unwrap_or(READ_CHAR_CAP).min(READ_CHAR_CAP);
    let slice: String = a.text.chars().skip(start).take(len).collect();
    let end = (start + len).min(total);
    Ok(format!(
        "[{}: chars {start}..{end} of {total}]\n{slice}",
        a.name
    ))
}

pub fn search_attachments(attachments: &[Attachment], query: &str) -> Result<String, String> {
    if attachments.is_empty() {
        return Err("no attachments in this session".into());
    }
    Ok(file_search(attachments, query))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_slices_by_char_and_reports_bounds() {
        let att = vec![Attachment {
            name: "a.md".into(),
            text: "héllo world".into(),
        }];
        let out = read_attachment(&att, "A.MD", 1, Some(4)).unwrap();
        assert!(out.starts_with("[a.md: chars 1..5 of 11]"));
        assert!(out.ends_with("éllo"));
        assert!(read_attachment(&att, "b.md", 0, None)
            .unwrap_err()
            .contains("a.md"));
    }
}
