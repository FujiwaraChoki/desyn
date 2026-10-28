//! Canvas tools (the floating tool dock, DESIGN_SYSTEM §6). Keys match the web editor (docs shortcut table).

/// A canvas tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Tool {
    /// Select / move / transform (V).
    #[default]
    Select,
    /// Pan (H, or hold space).
    Hand,
    /// Frame (F).
    Frame,
    /// Rectangle (R).
    Rect,
    /// Ellipse (O).
    Ellipse,
    /// Polygon.
    Polygon,
    /// Star.
    Star,
    /// Line (L).
    Line,
    /// Arrow (shift+L).
    Arrow,
    /// Pen with bezier editing (P).
    Pen,
    /// Text (T).
    Text,
    /// Place an image (mod+shift+K).
    Image,
}

impl Tool {
    /// Every tool in dock order.
    pub const ALL: [Tool; 12] = [
        Tool::Select,
        Tool::Hand,
        Tool::Frame,
        Tool::Rect,
        Tool::Ellipse,
        Tool::Polygon,
        Tool::Star,
        Tool::Line,
        Tool::Arrow,
        Tool::Pen,
        Tool::Text,
        Tool::Image,
    ];

    /// Shapes grouped under one dock button.
    pub const SHAPES: [Tool; 6] = [
        Tool::Rect,
        Tool::Ellipse,
        Tool::Polygon,
        Tool::Star,
        Tool::Line,
        Tool::Arrow,
    ];

    /// Label.
    pub fn label(self) -> &'static str {
        match self {
            Tool::Select => "Select",
            Tool::Hand => "Hand",
            Tool::Frame => "Frame",
            Tool::Rect => "Rectangle",
            Tool::Ellipse => "Ellipse",
            Tool::Polygon => "Polygon",
            Tool::Star => "Star",
            Tool::Line => "Line",
            Tool::Arrow => "Arrow",
            Tool::Pen => "Pen",
            Tool::Text => "Text",
            Tool::Image => "Image",
        }
    }

    /// Stable id used by commands and scripts.
    pub fn id(self) -> &'static str {
        match self {
            Tool::Select => "select",
            Tool::Hand => "hand",
            Tool::Frame => "frame",
            Tool::Rect => "rect",
            Tool::Ellipse => "ellipse",
            Tool::Polygon => "polygon",
            Tool::Star => "star",
            Tool::Line => "line",
            Tool::Arrow => "arrow",
            Tool::Pen => "pen",
            Tool::Text => "text",
            Tool::Image => "image",
        }
    }

    /// Parses [`Tool::id`].
    pub fn from_id(id: &str) -> Option<Tool> {
        Tool::ALL.into_iter().find(|t| t.id() == id)
    }

    /// Icon file (assets/icons).
    pub fn icon(self) -> &'static str {
        match self {
            Tool::Select => "icons/mouse-pointer-2.svg",
            Tool::Hand => "icons/hand.svg",
            Tool::Frame => "icons/frame.svg",
            Tool::Rect => "icons/square.svg",
            Tool::Ellipse => "icons/circle.svg",
            Tool::Polygon => "icons/pentagon.svg",
            Tool::Star => "icons/star.svg",
            Tool::Line => "icons/minus.svg",
            Tool::Arrow => "icons/move-up-right.svg",
            Tool::Pen => "icons/pen-tool.svg",
            Tool::Text => "icons/type.svg",
            Tool::Image => "icons/image.svg",
        }
    }

    /// Whether dragging on the canvas creates a shape.
    pub fn creates_shape(self) -> bool {
        matches!(
            self,
            Tool::Frame
                | Tool::Rect
                | Tool::Ellipse
                | Tool::Polygon
                | Tool::Star
                | Tool::Line
                | Tool::Arrow
        )
    }

    /// Whether the tool belongs to the shapes button.
    pub fn is_shape(self) -> bool {
        Tool::SHAPES.contains(&self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip() {
        for t in Tool::ALL {
            assert_eq!(Tool::from_id(t.id()), Some(t));
            assert!(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("assets")
                    .join(t.icon())
                    .exists(),
                "{t:?}"
            );
        }
        assert!(Tool::Rect.creates_shape() && !Tool::Text.creates_shape());
    }
}
