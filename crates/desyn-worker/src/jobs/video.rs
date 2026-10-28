//! MP4 / WebM export: desyn-raster renders the timeline frame by frame and the RGB(A) frames are piped into an
//! ffmpeg subprocess (H.264 + AAC in MP4 with `+faststart`, VP9 + Opus in WebM, with alpha when the background is
//! transparent). Audio nodes and the sound of unmuted video nodes are trimmed, faded, delayed to their place on the
//! timeline and mixed by ffmpeg.
//!
//! Video nodes are drawn with their poster frame: the renderer has no per-frame video decoding.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use desyn_core::model::{Design, Id, Node};
use desyn_raster::export::{Background, ExportOptions, bitmap, frames};
use desyn_raster::{Color4, Renderer, output_size};

use super::render::timeline;
use crate::error::{ApiError, ApiResult};
use crate::metrics::{Counter, Metrics};
use crate::runtime::Cancel;

/// Video container / codec.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCodec {
    /// H.264 + AAC in MP4.
    Mp4,
    /// VP9 + Opus in WebM.
    Webm,
}

impl VideoCodec {
    /// MIME type.
    pub fn mime(self) -> &'static str {
        match self {
            VideoCodec::Mp4 => "video/mp4",
            VideoCodec::Webm => "video/webm",
        }
    }

    /// File extension.
    pub fn extension(self) -> &'static str {
        match self {
            VideoCodec::Mp4 => "mp4",
            VideoCodec::Webm => "webm",
        }
    }
}

/// What the worker knows about its ffmpeg.
#[derive(Debug, Clone, Default)]
pub struct FfmpegInfo {
    /// First line of `ffmpeg -version`.
    pub version: String,
    /// libx264 + aac are available (MP4).
    pub mp4: bool,
    /// libvpx-vp9 + libopus are available (WebM).
    pub webm: bool,
}

impl FfmpegInfo {
    /// Probes `ffmpeg -version` and `-encoders`; `None` when ffmpeg cannot run.
    pub fn probe(ffmpeg: &Path) -> Option<FfmpegInfo> {
        let version = Command::new(ffmpeg)
            .arg("-version")
            .stdin(Stdio::null())
            .output()
            .ok()?;
        if !version.status.success() {
            return None;
        }
        let encoders = Command::new(ffmpeg)
            .args(["-hide_banner", "-encoders"])
            .stdin(Stdio::null())
            .output()
            .ok()?;
        let list = String::from_utf8_lossy(&encoders.stdout);
        let has = |name: &str| {
            list.lines()
                .any(|l| l.split_whitespace().nth(1) == Some(name))
        };
        Some(FfmpegInfo {
            version: String::from_utf8_lossy(&version.stdout)
                .lines()
                .next()
                .unwrap_or("ffmpeg")
                .to_string(),
            mp4: has("libx264") && has("aac"),
            webm: has("libvpx-vp9") && has("libopus"),
        })
    }

    /// The codec can be encoded.
    pub fn supports(&self, codec: VideoCodec) -> bool {
        match codec {
            VideoCodec::Mp4 => self.mp4,
            VideoCodec::Webm => self.webm,
        }
    }
}

/// ffmpeg settings.
#[derive(Clone)]
pub struct VideoEnv {
    /// ffmpeg binary.
    pub ffmpeg: PathBuf,
    /// Encoder threads.
    pub threads: usize,
    /// Directory for temporary files (`TMPDIR`; the container root is read-only).
    pub tmp_root: PathBuf,
    /// Metrics.
    pub metrics: Arc<Metrics>,
}

/// A sound placed on the timeline.
#[derive(Debug, Clone)]
pub struct AudioClip {
    /// Source asset.
    pub asset: Id,
    /// Bytes of the audio / video file.
    pub bytes: Arc<[u8]>,
    /// Timeline position (ms).
    pub start_ms: f64,
    /// Offset into the source (ms).
    pub trim_start_ms: f64,
    /// Played length (ms).
    pub length_ms: f64,
    /// Gain 0..1.
    pub volume: f64,
    /// Fade in (ms).
    pub fade_in_ms: f64,
    /// Fade out (ms).
    pub fade_out_ms: f64,
    /// Loop the source (video nodes with `loop`).
    pub looped: bool,
}

fn finite_or(v: f64, d: f64) -> f64 {
    if v.is_finite() { v } else { d }
}

/// Sounds of the selected pages. Audio `startMs` is relative to the start of its page on the timeline; sounds stop
/// when their page ends. Hidden nodes (and nodes under hidden containers) are silent.
pub fn audio_clips(
    design: &Design,
    pages: &[Id],
    duration_override: Option<f64>,
    media: &BTreeMap<Id, Arc<[u8]>>,
) -> Vec<AudioClip> {
    let (spans, _) = timeline(design, pages, duration_override);
    let mut out = Vec::new();
    for (page, page_start, page_dur) in spans {
        let page_end = page_start + page_dur;
        design.walk(&page, &mut |n, _| {
            if !n.base().visible {
                return false;
            }
            let clip = match n {
                Node::Audio(a) => media.get(&a.asset_id).map(|bytes| {
                    let start = page_start + finite_or(a.start_ms, 0.0).max(0.0);
                    let trim = finite_or(a.trim_start_ms, 0.0).max(0.0);
                    let avail = a
                        .trim_end_ms
                        .filter(|e| e.is_finite())
                        .map_or(f64::INFINITY, |e| e - trim);
                    AudioClip {
                        asset: a.asset_id.clone(),
                        bytes: bytes.clone(),
                        start_ms: start,
                        trim_start_ms: trim,
                        length_ms: avail.min(page_end - start),
                        volume: finite_or(a.volume, 1.0).clamp(0.0, 1.0),
                        fade_in_ms: a.fade_in_ms.map_or(0.0, |f| finite_or(f, 0.0).max(0.0)),
                        fade_out_ms: a.fade_out_ms.map_or(0.0, |f| finite_or(f, 0.0).max(0.0)),
                        looped: false,
                    }
                }),
                Node::Video(v) if !v.muted => media.get(&v.asset_id).map(|bytes| {
                    let trim = finite_or(v.trim_start_ms, 0.0).max(0.0);
                    let avail = match (v.looped, v.trim_end_ms.filter(|e| e.is_finite())) {
                        (false, Some(e)) => e - trim,
                        _ => f64::INFINITY,
                    };
                    AudioClip {
                        asset: v.asset_id.clone(),
                        bytes: bytes.clone(),
                        start_ms: page_start,
                        trim_start_ms: trim,
                        length_ms: avail.min(page_dur),
                        volume: finite_or(v.volume, 1.0).clamp(0.0, 1.0),
                        fade_in_ms: 0.0,
                        fade_out_ms: 0.0,
                        looped: v.looped,
                    }
                }),
                _ => None,
            };
            if let Some(mut c) = clip
                && c.length_ms > 1.0
                && c.volume > 0.0
            {
                c.fade_in_ms = c.fade_in_ms.min(c.length_ms);
                c.fade_out_ms = c.fade_out_ms.min(c.length_ms);
                out.push(c);
            }
            true
        });
    }
    out
}

/// A private temporary directory removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(root: &Path) -> ApiResult<TempDir> {
        let mut rnd = [0u8; 8];
        getrandom::fill(&mut rnd).map_err(|e| ApiError::internal(format!("random: {e}")))?;
        let name: String = rnd.iter().map(|b| format!("{b:02x}")).collect();
        let dir = root.join(format!("desyn-worker-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir)
            .map_err(|e| ApiError::internal(format!("temporary directory: {e}")))?;
        Ok(TempDir(dir))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Kills ffmpeg if the encode is abandoned.
struct ChildGuard(Option<Child>);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(mut c) = self.0.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

fn wait_until(child: &mut Child, deadline: Instant) -> ApiResult<std::process::ExitStatus> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ApiError::timeout());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(ApiError::internal(format!("ffmpeg: {e}"))),
        }
    }
}

/// Demuxers a sound file may be opened with. ffmpeg picks the demuxer from the file's content, and some (DASH
/// manifests, concat lists, SDP, playlists) make it open further files or network streams named inside the file;
/// sounds come from user uploads, so only plain audio / video containers are accepted.
const SOUND_DEMUXERS: &str = "aac,ac3,aiff,amr,ape,asf,au,avi,caf,eac3,flac,flv,matroska,webm,mov,mp4,m4a,3gp,mp3,mpeg,mpegts,ogg,w64,wav,wv";

/// Input options that confine ffmpeg to the local sound file (no other protocol, no reference-following demuxer).
fn confine_sound_input(cmd: &mut Command) {
    cmd.args([
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        SOUND_DEMUXERS,
    ]);
}

/// True when ffmpeg can decode an audio stream from `path` (bad uploads are skipped instead of failing the export).
fn has_audio(ffmpeg: &Path, path: &Path, deadline: Instant) -> bool {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-loglevel", "error"]);
    confine_sound_input(&mut cmd);
    let Ok(child) = cmd
        .arg("-i")
        .arg(path)
        .args(["-map", "0:a:0", "-t", "0.2", "-f", "null", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let mut guard = ChildGuard(Some(child));
    let until = deadline.min(Instant::now() + Duration::from_secs(15));
    let ok = guard
        .0
        .as_mut()
        .is_some_and(|c| wait_until(c, until).is_ok_and(|s| s.success()));
    guard.0 = None;
    ok
}

fn secs(ms: f64) -> String {
    format!("{:.3}", ms.max(0.0) / 1000.0)
}

/// The `-filter_complex` graph: even frame size and pixel format for the video, and one chain per sound mixed into
/// `[a]`.
fn filter_graph(codec: VideoCodec, alpha: bool, clips: &[&AudioClip]) -> String {
    let pix = match (codec, alpha) {
        (VideoCodec::Webm, true) => "yuva420p",
        _ => "yuv420p",
    };
    // 4:2:0 needs even dimensions; crop the odd last row / column instead of resampling the whole frame.
    let mut g = format!("[0:v]crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0,format={pix}[v]");
    if clips.is_empty() {
        return g;
    }
    for (i, c) in clips.iter().enumerate() {
        let mut chain = format!(
            ";[{}:a]aresample=48000,atrim=start={}",
            i + 1,
            secs(c.trim_start_ms)
        );
        if c.length_ms.is_finite() {
            chain.push_str(&format!(",atrim=duration={}", secs(c.length_ms)));
        }
        chain.push_str(&format!(",asetpts=PTS-STARTPTS,volume={:.3}", c.volume));
        if c.fade_in_ms > 0.0 {
            chain.push_str(&format!(",afade=t=in:st=0:d={}", secs(c.fade_in_ms)));
        }
        if c.fade_out_ms > 0.0 && c.length_ms.is_finite() {
            chain.push_str(&format!(
                ",afade=t=out:st={}:d={}",
                secs(c.length_ms - c.fade_out_ms),
                secs(c.fade_out_ms)
            ));
        }
        chain.push_str(&format!(
            ",adelay=delays={}:all=1[a{i}]",
            c.start_ms.max(0.0).round() as u64
        ));
        g.push_str(&chain);
    }
    g.push(';');
    for i in 0..clips.len() {
        g.push_str(&format!("[a{i}]"));
    }
    if clips.len() == 1 {
        g.push_str("apad[a]");
    } else {
        g.push_str(&format!(
            "amix=inputs={}:duration=longest:dropout_transition=0:normalize=0,apad[a]",
            clips.len()
        ));
    }
    g
}

/// Renders the timeline of `pages` and encodes it. Returns the file bytes.
#[allow(clippy::too_many_arguments)]
pub fn encode(
    renderer: &mut Renderer,
    design: &Design,
    pages: &[Id],
    opts: &ExportOptions,
    codec: VideoCodec,
    total_ms: f64,
    clips: &[AudioClip],
    env: &VideoEnv,
    cancel: &Cancel,
) -> ApiResult<Vec<u8>> {
    let started = Instant::now();
    let tmp = TempDir::new(&env.tmp_root)?;
    let Some(Node::Page(first)) = design.node(&pages[0]) else {
        return Err(ApiError::bad_request("page_not_found", "no such page"));
    };
    let (w, h) = output_size(
        &desyn_core::geometry::Rect::new(0.0, 0.0, first.base.width, first.base.height),
        opts.scale,
    )?;
    let alpha = codec == VideoCodec::Webm && matches!(opts.background, Background::Transparent);

    // Sounds: written to files, kept only when ffmpeg can decode them.
    let mut inputs: Vec<(&AudioClip, PathBuf)> = Vec::new();
    for (i, c) in clips.iter().enumerate() {
        let path = tmp.0.join(format!("sound-{i}"));
        std::fs::write(&path, &c.bytes)
            .map_err(|e| ApiError::internal(format!("temporary file: {e}")))?;
        if has_audio(&env.ffmpeg, &path, cancel.deadline()) {
            inputs.push((c, path));
        } else {
            tracing::warn!(asset = %c.asset, "sound skipped: ffmpeg cannot decode an audio stream from it");
        }
    }
    cancel.check()?;

    let out_path = tmp.0.join(format!("out.{}", codec.extension()));
    let mut cmd = Command::new(&env.ffmpeg);
    cmd.args(["-hide_banner", "-nostats", "-loglevel", "error", "-y"])
        .args([
            "-f",
            "rawvideo",
            "-pix_fmt",
            if alpha { "rgba" } else { "rgb24" },
        ])
        .args([
            "-s",
            &format!("{w}x{h}"),
            "-framerate",
            &format!("{}", opts.anim.fps),
            "-i",
            "pipe:0",
        ]);
    for (c, path) in &inputs {
        if c.looped {
            cmd.args(["-stream_loop", "-1"]);
        }
        confine_sound_input(&mut cmd);
        cmd.arg("-i").arg(path);
    }
    let clip_refs: Vec<&AudioClip> = inputs.iter().map(|(c, _)| *c).collect();
    cmd.args([
        "-filter_complex",
        &filter_graph(codec, alpha, &clip_refs),
        "-map",
        "[v]",
    ]);
    if !inputs.is_empty() {
        cmd.args(["-map", "[a]"]);
    }
    let threads = env.threads.to_string();
    match codec {
        VideoCodec::Mp4 => {
            cmd.args([
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "18",
                "-profile:v",
                "high",
            ])
            .args(["-movflags", "+faststart", "-threads", &threads]);
            if !inputs.is_empty() {
                cmd.args(["-c:a", "aac", "-b:a", "192k"]);
            }
        }
        VideoCodec::Webm => {
            cmd.args([
                "-c:v",
                "libvpx-vp9",
                "-b:v",
                "0",
                "-crf",
                "32",
                "-row-mt",
                "1",
            ])
            .args(["-deadline", "good", "-cpu-used", "4", "-threads", &threads]);
            if !inputs.is_empty() {
                cmd.args(["-c:a", "libopus", "-b:a", "160k"]);
            }
        }
    }
    cmd.args(["-t", &secs(total_ms)])
        .arg(&out_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| {
        env.metrics.inc(Counter::Ffmpeg, "spawn_failed");
        ApiError::internal(format!("ffmpeg could not start: {e}"))
    })?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stderr = child.stderr.take().expect("piped stderr");
    let mut guard = ChildGuard(Some(child));

    // Keep the tail of ffmpeg's stderr for error messages (reading it also keeps the pipe from filling up).
    let tail = Arc::new(Mutex::new(Vec::<u8>::new()));
    let tail_writer = tail.clone();
    let reader = std::thread::spawn(move || {
        let mut stderr = stderr;
        let mut buf = [0u8; 4096];
        while let Ok(n) = stderr.read(&mut buf) {
            if n == 0 {
                break;
            }
            let mut t = tail_writer.lock().expect("stderr tail");
            t.extend_from_slice(&buf[..n]);
            let excess = t.len().saturating_sub(4096);
            t.drain(..excess);
        }
    });
    let stderr_text = |tail: &Arc<Mutex<Vec<u8>>>| {
        String::from_utf8_lossy(&tail.lock().expect("stderr tail"))
            .trim()
            .to_string()
    };

    let rendered = frames::render_frames(renderer, design, pages, opts, |fr| {
        if cancel.is_cancelled() {
            return Err(desyn_raster::RenderError::Encode("cancelled".into()));
        }
        let buf = if alpha {
            bitmap::pixmap_rgba(fr.pixmap)
        } else {
            bitmap::pixmap_rgb_on(fr.pixmap, Color4::WHITE)
        };
        stdin.write_all(&buf).map_err(|e| {
            desyn_raster::RenderError::Encode(format!("ffmpeg stopped reading frames: {e}"))
        })
    });
    drop(stdin);
    let seq = match rendered {
        Ok(seq) => seq,
        Err(e) => {
            drop(guard);
            let _ = reader.join();
            env.metrics.inc(Counter::Ffmpeg, "failed");
            if cancel.is_cancelled() {
                return Err(ApiError::timeout());
            }
            let detail = stderr_text(&tail);
            return Err(match e {
                desyn_raster::RenderError::Encode(m) if !detail.is_empty() => {
                    ApiError::internal(format!("video encoding failed: {m}; ffmpeg: {detail}"))
                }
                other => ApiError::from(other),
            });
        }
    };
    let status = {
        let child = guard.0.as_mut().expect("child present");
        wait_until(child, cancel.deadline())
    };
    guard.0 = None;
    let _ = reader.join();
    let status = status?;
    if !status.success() {
        env.metrics.inc(Counter::Ffmpeg, "failed");
        return Err(ApiError::internal(format!(
            "ffmpeg exited with {status}: {}",
            stderr_text(&tail)
        )));
    }
    let bytes =
        std::fs::read(&out_path).map_err(|e| ApiError::internal(format!("ffmpeg output: {e}")))?;
    env.metrics.inc(Counter::Ffmpeg, "ok");
    tracing::info!(
        codec = codec.extension(),
        frames = seq.frames,
        width = w,
        height = h,
        fps = opts.anim.fps,
        sounds = inputs.len(),
        bytes = bytes.len(),
        ms = started.elapsed().as_millis() as u64,
        "video encoded"
    );
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(start: f64, len: f64, fade: f64) -> AudioClip {
        AudioClip {
            asset: "snd000000001".into(),
            bytes: Arc::from(Vec::new()),
            start_ms: start,
            trim_start_ms: 500.0,
            length_ms: len,
            volume: 0.8,
            fade_in_ms: fade,
            fade_out_ms: fade,
            looped: false,
        }
    }

    #[test]
    fn graph_for_video_only_and_mixed_audio() {
        assert_eq!(
            filter_graph(VideoCodec::Mp4, false, &[]),
            "[0:v]crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0,format=yuv420p[v]"
        );
        let a = clip(1000.0, 2000.0, 250.0);
        let b = clip(0.0, f64::INFINITY, 0.0);
        let g = filter_graph(VideoCodec::Webm, true, &[&a, &b]);
        assert!(g.contains("format=yuva420p[v]"));
        assert!(g.contains("[1:a]aresample=48000,atrim=start=0.500,atrim=duration=2.000,asetpts=PTS-STARTPTS,volume=0.800,afade=t=in:st=0:d=0.250,afade=t=out:st=1.750:d=0.250,adelay=delays=1000:all=1[a0]"));
        assert!(g.contains("[2:a]aresample=48000,atrim=start=0.500,asetpts=PTS-STARTPTS,volume=0.800,adelay=delays=0:all=1[a1]"));
        assert!(g.ends_with(
            "[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad[a]"
        ));
    }
}
