//! The error type of every fallible engine call.

use std::fmt;

/// Why an engine call failed. Swift sees this as `EngineError` (an `Error` with associated values).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Error)]
pub enum EngineError {
    /// A JSON argument could not be parsed (design, transaction, options).
    InvalidJson {
        /// Parser message.
        detail: String,
    },
    /// No design is loaded (call `load` first).
    NoDesign,
    /// The design has no page with this id (or no pages at all).
    PageNotFound {
        /// Requested page id.
        id: String,
    },
    /// No node with this id.
    NodeNotFound {
        /// Requested node id.
        id: String,
    },
    /// The node exists but is not a text node.
    NotText {
        /// Node id.
        id: String,
    },
    /// An argument is out of range (viewport size, scale, buffer too small, color syntax).
    InvalidArgument {
        /// What is wrong.
        detail: String,
    },
    /// Rendering or exporting failed.
    Render {
        /// Renderer message.
        detail: String,
    },
    /// Font bytes could not be registered.
    Font {
        /// Font database message.
        detail: String,
    },
}

impl EngineError {
    pub(crate) fn json(e: impl fmt::Display) -> Self {
        EngineError::InvalidJson {
            detail: e.to_string(),
        }
    }

    pub(crate) fn arg(detail: impl Into<String>) -> Self {
        EngineError::InvalidArgument {
            detail: detail.into(),
        }
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::InvalidJson { detail } => write!(f, "invalid JSON: {detail}"),
            EngineError::NoDesign => f.write_str("no design is loaded"),
            EngineError::PageNotFound { id } => write!(f, "no such page: {id}"),
            EngineError::NodeNotFound { id } => write!(f, "no such node: {id}"),
            EngineError::NotText { id } => write!(f, "not a text node: {id}"),
            EngineError::InvalidArgument { detail } => write!(f, "invalid argument: {detail}"),
            EngineError::Render { detail } => write!(f, "render failed: {detail}"),
            EngineError::Font { detail } => write!(f, "font rejected: {detail}"),
        }
    }
}

impl std::error::Error for EngineError {}

impl From<desyn_raster::RenderError> for EngineError {
    fn from(e: desyn_raster::RenderError) -> Self {
        match e {
            desyn_raster::RenderError::NoPage(id) => EngineError::PageNotFound { id },
            desyn_raster::RenderError::InvalidOptions(m) => {
                EngineError::InvalidArgument { detail: m }
            }
            other => EngineError::Render {
                detail: other.to_string(),
            },
        }
    }
}
