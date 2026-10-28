//! Minimal stderr logger (`DESYN_LOG=debug|info|warn|error`, default `warn`).

use log::{Level, LevelFilter, Log, Metadata, Record};

struct Logger(Level);

impl Log for Logger {
    fn enabled(&self, m: &Metadata) -> bool {
        m.level() <= self.0 && (m.target().starts_with("desyn") || m.level() <= Level::Warn)
    }

    fn log(&self, r: &Record) {
        if self.enabled(r.metadata()) {
            eprintln!("[{} {}] {}", r.level(), r.target(), r.args());
        }
    }

    fn flush(&self) {}
}

/// Installs the logger once.
pub fn init() {
    let level = match std::env::var("DESYN_LOG").as_deref() {
        Ok("trace") => Level::Trace,
        Ok("debug") => Level::Debug,
        Ok("info") => Level::Info,
        Ok("error") => Level::Error,
        _ => Level::Warn,
    };
    let logger: &'static Logger = Box::leak(Box::new(Logger(level)));
    if log::set_logger(logger).is_ok() {
        log::set_max_level(LevelFilter::Trace.min(level.to_level_filter()));
    }
}
