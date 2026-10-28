//! Prometheus text exposition (`GET /metrics`), written by hand: a handful of counters, gauges and one histogram
//! do not justify a metrics framework.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::Duration;

/// Request duration buckets (seconds).
const BUCKETS: [f64; 14] = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0,
];

#[derive(Default)]
struct Histogram {
    counts: [u64; BUCKETS.len()],
    count: u64,
    sum: f64,
}

/// Process-wide metrics.
#[derive(Default)]
pub struct Metrics {
    requests: Mutex<BTreeMap<(&'static str, u16), u64>>,
    durations: Mutex<BTreeMap<&'static str, Histogram>>,
    labelled: Mutex<BTreeMap<(&'static str, String), u64>>,
    in_flight: AtomicI64,
    jobs_running: AtomicI64,
    jobs_waiting: AtomicI64,
    asset_bytes: AtomicU64,
    output_bytes: AtomicU64,
}

/// Counter families with one label (`name{label="value"}`); names are fixed here so the exposition is stable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Counter {
    /// `desyn_worker_renders_total{format}`.
    Renders,
    /// `desyn_worker_asset_fetches_total{result}`.
    AssetFetches,
    /// `desyn_worker_font_loads_total{result}`.
    FontLoads,
    /// `desyn_worker_ffmpeg_runs_total{result}`.
    Ffmpeg,
    /// `desyn_worker_rejections_total{reason}`.
    Rejections,
}

impl Counter {
    fn name(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Counter::Renders => (
                "desyn_worker_renders_total",
                "format",
                "Successful renders and exports by output format.",
            ),
            Counter::AssetFetches => (
                "desyn_worker_asset_fetches_total",
                "result",
                "Asset fetches by result (ok, cached, blocked, status, too_large, timeout, error).",
            ),
            Counter::FontLoads => (
                "desyn_worker_font_loads_total",
                "result",
                "Font provider loads by source and result.",
            ),
            Counter::Ffmpeg => (
                "desyn_worker_ffmpeg_runs_total",
                "result",
                "ffmpeg encodes by result.",
            ),
            Counter::Rejections => (
                "desyn_worker_rejections_total",
                "reason",
                "Requests turned away before work started (auth, limits, overload).",
            ),
        }
    }
}

impl Metrics {
    /// New registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Records a finished request.
    pub fn request(&self, route: &'static str, status: u16, elapsed: Duration) {
        *self
            .requests
            .lock()
            .expect("metrics lock")
            .entry((route, status))
            .or_default() += 1;
        let secs = elapsed.as_secs_f64();
        let mut d = self.durations.lock().expect("metrics lock");
        let h = d.entry(route).or_default();
        for (i, b) in BUCKETS.iter().enumerate() {
            if secs <= *b {
                h.counts[i] += 1;
            }
        }
        h.count += 1;
        h.sum += secs;
    }

    /// Increments a labelled counter.
    pub fn inc(&self, counter: Counter, label: &str) {
        self.add(counter, label, 1);
    }

    /// Adds to a labelled counter.
    pub fn add(&self, counter: Counter, label: &str, n: u64) {
        let (name, _, _) = counter.name();
        *self
            .labelled
            .lock()
            .expect("metrics lock")
            .entry((name, label.to_string()))
            .or_default() += n;
    }

    /// Requests being served (gauge).
    pub fn in_flight(&self, delta: i64) {
        self.in_flight.fetch_add(delta, Ordering::Relaxed);
    }

    /// CPU jobs running (gauge).
    pub fn jobs_running(&self, delta: i64) {
        self.jobs_running.fetch_add(delta, Ordering::Relaxed);
    }

    /// Requests waiting for a CPU slot (gauge).
    pub fn jobs_waiting(&self, delta: i64) {
        self.jobs_waiting.fetch_add(delta, Ordering::Relaxed);
    }

    /// Current number of waiting requests.
    pub fn waiting(&self) -> i64 {
        self.jobs_waiting.load(Ordering::Relaxed)
    }

    /// Bytes downloaded from asset URLs.
    pub fn asset_bytes(&self, n: u64) {
        self.asset_bytes.fetch_add(n, Ordering::Relaxed);
    }

    /// Bytes of rendered output.
    pub fn output_bytes(&self, n: u64) {
        self.output_bytes.fetch_add(n, Ordering::Relaxed);
    }

    /// Prometheus text format.
    pub fn render(&self, release: &str, concurrency: usize, uptime: Duration) -> String {
        let mut s = String::new();
        let _ = writeln!(s, "# HELP desyn_worker_build_info Build information.");
        let _ = writeln!(s, "# TYPE desyn_worker_build_info gauge");
        let _ = writeln!(
            s,
            "desyn_worker_build_info{{release=\"{}\"}} 1",
            escape(release)
        );
        gauge(
            &mut s,
            "desyn_worker_uptime_seconds",
            "Seconds since start.",
            uptime.as_secs_f64(),
        );
        gauge(
            &mut s,
            "desyn_worker_concurrency",
            "Configured CPU job slots.",
            concurrency as f64,
        );
        gauge(
            &mut s,
            "desyn_worker_requests_in_flight",
            "Requests being served.",
            self.in_flight.load(Ordering::Relaxed) as f64,
        );
        gauge(
            &mut s,
            "desyn_worker_jobs_running",
            "CPU jobs running on the blocking pool.",
            self.jobs_running.load(Ordering::Relaxed) as f64,
        );
        gauge(
            &mut s,
            "desyn_worker_jobs_waiting",
            "Requests waiting for a CPU slot.",
            self.jobs_waiting.load(Ordering::Relaxed) as f64,
        );
        counter(
            &mut s,
            "desyn_worker_asset_bytes_total",
            "Bytes downloaded from asset URLs.",
            self.asset_bytes.load(Ordering::Relaxed),
        );
        counter(
            &mut s,
            "desyn_worker_output_bytes_total",
            "Bytes of rendered output.",
            self.output_bytes.load(Ordering::Relaxed),
        );

        let _ = writeln!(
            s,
            "# HELP desyn_worker_requests_total Requests by route and status."
        );
        let _ = writeln!(s, "# TYPE desyn_worker_requests_total counter");
        for ((route, status), n) in self.requests.lock().expect("metrics lock").iter() {
            let _ = writeln!(
                s,
                "desyn_worker_requests_total{{route=\"{route}\",status=\"{status}\"}} {n}"
            );
        }

        let _ = writeln!(
            s,
            "# HELP desyn_worker_request_duration_seconds Request latency by route."
        );
        let _ = writeln!(s, "# TYPE desyn_worker_request_duration_seconds histogram");
        for (route, h) in self.durations.lock().expect("metrics lock").iter() {
            for (i, b) in BUCKETS.iter().enumerate() {
                let _ = writeln!(
                    s,
                    "desyn_worker_request_duration_seconds_bucket{{route=\"{route}\",le=\"{b}\"}} {}",
                    h.counts[i]
                );
            }
            let _ = writeln!(
                s,
                "desyn_worker_request_duration_seconds_bucket{{route=\"{route}\",le=\"+Inf\"}} {}",
                h.count
            );
            let _ = writeln!(
                s,
                "desyn_worker_request_duration_seconds_sum{{route=\"{route}\"}} {}",
                h.sum
            );
            let _ = writeln!(
                s,
                "desyn_worker_request_duration_seconds_count{{route=\"{route}\"}} {}",
                h.count
            );
        }

        let labelled = self.labelled.lock().expect("metrics lock");
        for c in [
            Counter::Renders,
            Counter::AssetFetches,
            Counter::FontLoads,
            Counter::Ffmpeg,
            Counter::Rejections,
        ] {
            let (name, label, help) = c.name();
            let _ = writeln!(s, "# HELP {name} {help}");
            let _ = writeln!(s, "# TYPE {name} counter");
            for ((n, value), count) in labelled.iter() {
                if *n == name {
                    let _ = writeln!(s, "{name}{{{label}=\"{}\"}} {count}", escape(value));
                }
            }
        }
        s
    }
}

fn gauge(s: &mut String, name: &str, help: &str, v: f64) {
    let _ = writeln!(s, "# HELP {name} {help}");
    let _ = writeln!(s, "# TYPE {name} gauge");
    let _ = writeln!(s, "{name} {v}");
}

fn counter(s: &mut String, name: &str, help: &str, v: u64) {
    let _ = writeln!(s, "# HELP {name} {help}");
    let _ = writeln!(s, "# TYPE {name} counter");
    let _ = writeln!(s, "{name} {v}");
}

fn escape(v: &str) -> String {
    v.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposition_has_counters_and_histogram() {
        let m = Metrics::new();
        m.request("render", 200, Duration::from_millis(30));
        m.request("render", 200, Duration::from_secs(3));
        m.inc(Counter::Renders, "png");
        m.inc(Counter::AssetFetches, "blocked");
        let text = m.render("v\"1", 4, Duration::from_secs(5));
        assert!(text.contains("desyn_worker_requests_total{route=\"render\",status=\"200\"} 2"));
        assert!(text.contains(
            "desyn_worker_request_duration_seconds_bucket{route=\"render\",le=\"0.05\"} 1"
        ));
        assert!(text.contains(
            "desyn_worker_request_duration_seconds_bucket{route=\"render\",le=\"+Inf\"} 2"
        ));
        assert!(text.contains("desyn_worker_renders_total{format=\"png\"} 1"));
        assert!(text.contains("desyn_worker_asset_fetches_total{result=\"blocked\"} 1"));
        assert!(text.contains("release=\"v\\\"1\""));
    }
}
