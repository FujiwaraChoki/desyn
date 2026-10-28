//! Remote image previews (template thumbnails, stock photos, uploads, avatars, icons): fetched once on the network
//! runtime, kept in a small LRU and handed to GPUI as encoded images. Views ask with their entity id and are
//! notified when the image arrives.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use gpui::{App, EntityId, Global, Image, ImageFormat};

use super::Cloud;

const CAPACITY: usize = 600;
const MAX_PREVIEW_BYTES: usize = 12 * 1024 * 1024;

enum Slot {
    Loading(Vec<EntityId>),
    Ready(Arc<Image>),
    Failed,
}

/// The cache (GPUI global).
#[derive(Default)]
pub struct RemoteImages {
    slots: HashMap<String, Slot>,
    order: VecDeque<String>,
}

impl Global for RemoteImages {}

/// Image format from the first bytes (PNG, JPEG, WebP, GIF, SVG).
pub fn sniff(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some(ImageFormat::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageFormat::Jpeg)
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(ImageFormat::Webp)
    } else if bytes.starts_with(b"GIF8") {
        Some(ImageFormat::Gif)
    } else if bytes.starts_with(b"BM") {
        Some(ImageFormat::Bmp)
    } else {
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).to_ascii_lowercase();
        head.contains("<svg").then_some(ImageFormat::Svg)
    }
}

/// The image at `url` when loaded; starts loading it otherwise and notifies `viewer` when it arrives.
pub fn image(url: &str, viewer: EntityId, cx: &mut App) -> Option<Arc<Image>> {
    if url.is_empty() {
        return None;
    }
    if !cx.has_global::<RemoteImages>() {
        cx.set_global(RemoteImages::default());
    }
    let state = cx.global_mut::<RemoteImages>();
    match state.slots.get_mut(url) {
        Some(Slot::Ready(img)) => return Some(img.clone()),
        Some(Slot::Failed) => return None,
        Some(Slot::Loading(w)) => {
            if !w.contains(&viewer) {
                w.push(viewer);
            }
            return None;
        }
        None => {}
    }
    state
        .slots
        .insert(url.to_string(), Slot::Loading(vec![viewer]));
    state.order.push_back(url.to_string());
    while state.order.len() > CAPACITY {
        if let Some(old) = state.order.pop_front()
            && matches!(
                state.slots.get(&old),
                Some(Slot::Ready(_)) | Some(Slot::Failed)
            )
        {
            state.slots.remove(&old);
        }
    }
    let cloud = Cloud::try_get(cx)?;
    let fetch = cloud.fetch_bytes(url, MAX_PREVIEW_BYTES);
    let url = url.to_string();
    cx.spawn(async move |cx| {
        let res = fetch.await;
        cx.update(|cx| {
            let slot = match res {
                Ok((bytes, _)) => match sniff(&bytes) {
                    Some(fmt) => Slot::Ready(Arc::new(Image::from_bytes(fmt, bytes))),
                    None => Slot::Failed,
                },
                Err(e) => {
                    log::debug!("preview {}: {e}", super::http::redact(&url));
                    Slot::Failed
                }
            };
            let waiters = match cx
                .global_mut::<RemoteImages>()
                .slots
                .insert(url.clone(), slot)
            {
                Some(Slot::Loading(w)) => w,
                _ => Vec::new(),
            };
            for w in waiters {
                cx.notify(w);
            }
        });
    })
    .detach();
    None
}

/// An image from bytes already in memory (asset previews).
pub fn from_bytes(bytes: &[u8]) -> Option<Arc<Image>> {
    sniff(bytes).map(|f| Arc::new(Image::from_bytes(f, bytes.to_vec())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_common_formats() {
        assert_eq!(sniff(b"\x89PNG\r\n"), Some(ImageFormat::Png));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some(ImageFormat::Jpeg));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some(ImageFormat::Webp));
        assert_eq!(
            sniff(b"<?xml version='1.0'?><svg xmlns=''/>"),
            Some(ImageFormat::Svg)
        );
        assert_eq!(sniff(b"hello"), None);
    }
}
