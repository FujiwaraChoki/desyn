//! Error type.

use std::fmt;

/// Rendering / export failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderError {
    /// The design has no page with this id (or no pages at all).
    NoPage(String),
    /// Invalid options (zero size, unknown format, out-of-range values).
    InvalidOptions(String),
    /// The requested output is too large to allocate.
    TooLarge(String),
    /// The format is not compiled in (missing cargo feature) or not available on this target.
    Unsupported(String),
    /// Encoding the output failed.
    Encode(String),
    /// Reading or writing files (CLI).
    Io(String),
    /// The design JSON could not be parsed.
    Parse(String),
}

impl fmt::Display for RenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RenderError::NoPage(p) => write!(f, "no such page: {p}"),
            RenderError::InvalidOptions(m) => write!(f, "invalid options: {m}"),
            RenderError::TooLarge(m) => write!(f, "output too large: {m}"),
            RenderError::Unsupported(m) => write!(f, "unsupported: {m}"),
            RenderError::Encode(m) => write!(f, "encoding failed: {m}"),
            RenderError::Io(m) => write!(f, "i/o error: {m}"),
            RenderError::Parse(m) => write!(f, "invalid design: {m}"),
        }
    }
}

impl std::error::Error for RenderError {}
