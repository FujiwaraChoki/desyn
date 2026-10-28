//! CPU slots and deadlines.
//!
//! Rendering is CPU-bound and never runs on the async executor: every job runs on tokio's blocking pool while
//! holding one of `WORKER_CONCURRENCY` slots. Requests that cannot get a slot wait (at most `WORKER_QUEUE_LIMIT` of
//! them, for at most `WORKER_QUEUE_TIMEOUT_MS`) and are otherwise turned away with 503 + `Retry-After`, which the
//! Convex client retries with backoff.
//!
//! A blocking job cannot be killed. When a request's deadline passes, the caller gets 504 at once and the job's
//! [`Cancel`] flips, so loops that check it (frame rendering, ffmpeg, font downloads) stop early; the job keeps its
//! slot until it returns, so a runaway job still counts against the concurrency limit.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::error::{ApiError, ApiResult};
use crate::metrics::{Counter, Metrics};

/// Cooperative cancellation: a deadline plus a flag set when the caller gave up.
#[derive(Debug, Clone)]
pub struct Cancel {
    flag: Arc<AtomicBool>,
    deadline: Instant,
}

impl Cancel {
    /// Token expiring at `deadline`.
    pub fn new(deadline: Instant) -> Self {
        Cancel {
            flag: Arc::new(AtomicBool::new(false)),
            deadline,
        }
    }

    /// The deadline.
    pub fn deadline(&self) -> Instant {
        self.deadline
    }

    /// Marks the job as abandoned.
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    /// True once cancelled or past the deadline.
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst) || Instant::now() >= self.deadline
    }

    /// `Err(timeout)` once cancelled.
    pub fn check(&self) -> ApiResult<()> {
        if self.is_cancelled() {
            Err(ApiError::timeout())
        } else {
            Ok(())
        }
    }
}

/// The CPU slot limiter.
pub struct Gate {
    slots: Arc<Semaphore>,
    waiting: AtomicUsize,
    queue_limit: usize,
    queue_timeout: Duration,
    metrics: Arc<Metrics>,
}

/// A held CPU slot.
pub struct Slot {
    _permit: OwnedSemaphorePermit,
    metrics: Arc<Metrics>,
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.metrics.jobs_running(-1);
    }
}

struct Waiting<'a>(&'a Gate);

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.waiting.fetch_sub(1, Ordering::SeqCst);
        self.0.metrics.jobs_waiting(-1);
    }
}

impl Gate {
    /// Limiter with `concurrency` slots.
    pub fn new(
        concurrency: usize,
        queue_limit: usize,
        queue_timeout: Duration,
        metrics: Arc<Metrics>,
    ) -> Self {
        Gate {
            slots: Arc::new(Semaphore::new(concurrency.max(1))),
            waiting: AtomicUsize::new(0),
            queue_limit,
            queue_timeout,
            metrics,
        }
    }

    /// Takes a slot, waiting in the queue when all are busy (bounded by the queue timeout and `deadline`).
    pub async fn acquire(&self, deadline: Instant) -> ApiResult<Slot> {
        let permit = match self.slots.clone().try_acquire_owned() {
            Ok(p) => p,
            Err(_) => {
                if self.waiting.fetch_add(1, Ordering::SeqCst) >= self.queue_limit {
                    self.waiting.fetch_sub(1, Ordering::SeqCst);
                    self.metrics.inc(Counter::Rejections, "queue_full");
                    return Err(ApiError::unavailable(
                        "overloaded",
                        "the worker is at capacity; retry shortly",
                        2,
                    ));
                }
                self.metrics.jobs_waiting(1);
                let _waiting = Waiting(self);
                let until = deadline.min(Instant::now() + self.queue_timeout);
                match tokio::time::timeout_at(until.into(), self.slots.clone().acquire_owned())
                    .await
                {
                    Ok(Ok(p)) => p,
                    Ok(Err(_)) => {
                        return Err(ApiError::unavailable(
                            "shutting_down",
                            "the worker is stopping",
                            1,
                        ));
                    }
                    Err(_) => {
                        self.metrics.inc(Counter::Rejections, "queue_timeout");
                        return Err(ApiError::unavailable(
                            "busy",
                            "no render slot became free in time; retry shortly",
                            5,
                        ));
                    }
                }
            }
        };
        self.metrics.jobs_running(1);
        Ok(Slot {
            _permit: permit,
            metrics: self.metrics.clone(),
        })
    }

    /// Slots not in use.
    pub fn available(&self) -> usize {
        self.slots.available_permits()
    }
}

/// Cancels the job when the request is dropped before the job finished (the caller disconnected or gave up), so
/// frame loops, ffmpeg and font downloads stop instead of holding a CPU slot for a result nobody reads.
struct CancelOnDrop<'a>(Option<&'a Cancel>);

impl Drop for CancelOnDrop<'_> {
    fn drop(&mut self) {
        if let Some(c) = self.0.take() {
            c.cancel();
        }
    }
}

/// Runs `f` on the blocking pool while holding a CPU slot; answers 504 when the deadline passes first.
pub async fn run_job<T, F>(gate: &Gate, cancel: &Cancel, f: F) -> ApiResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Cancel) -> ApiResult<T> + Send + 'static,
{
    let mut abandon = CancelOnDrop(Some(cancel));
    let result = run_job_inner(gate, cancel, f).await;
    abandon.0 = None;
    result
}

async fn run_job_inner<T, F>(gate: &Gate, cancel: &Cancel, f: F) -> ApiResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Cancel) -> ApiResult<T> + Send + 'static,
{
    let slot = gate.acquire(cancel.deadline()).await?;
    cancel.check()?;
    let token = cancel.clone();
    let span = tracing::Span::current();
    let task = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        let _enter = span.enter();
        token.check()?;
        f(&token)
    });
    match tokio::time::timeout_at(cancel.deadline().into(), task).await {
        Err(_) => {
            cancel.cancel();
            Err(ApiError::timeout())
        }
        Ok(Err(join)) => {
            if join.is_panic() {
                tracing::error!("render job panicked");
                Err(ApiError::internal("the render job failed unexpectedly"))
            } else {
                Err(ApiError::internal("the render job was aborted"))
            }
        }
        Ok(Ok(result)) => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn gate_queues_then_rejects() {
        let metrics = Arc::new(Metrics::new());
        let gate = Arc::new(Gate::new(1, 1, Duration::from_millis(100), metrics));
        let far = Instant::now() + Duration::from_secs(10);
        let held = gate.acquire(far).await.unwrap();
        // One waiter is allowed; it times out because the slot stays taken.
        let g2 = gate.clone();
        let waiter = tokio::spawn(async move { g2.acquire(far).await.map(|_| ()) });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let full = gate.acquire(far).await.err().unwrap();
        assert_eq!(full.code, "overloaded");
        let timed_out = waiter.await.unwrap().err().unwrap();
        assert_eq!(timed_out.code, "busy");
        drop(held);
        assert!(gate.acquire(far).await.is_ok());
    }

    #[tokio::test]
    async fn abandoned_jobs_are_cancelled() {
        let gate = Arc::new(Gate::new(
            1,
            1,
            Duration::from_secs(1),
            Arc::new(Metrics::new()),
        ));
        let cancel = Cancel::new(Instant::now() + Duration::from_secs(30));
        let stopped = Arc::new(AtomicBool::new(false));
        let (s, c, g) = (stopped.clone(), cancel.clone(), gate.clone());
        let request = tokio::spawn(async move {
            run_job(&g, &c, move |c| {
                while !c.is_cancelled() {
                    std::thread::sleep(Duration::from_millis(5));
                }
                s.store(true, Ordering::SeqCst);
                Ok(())
            })
            .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        // The caller disconnects: axum drops the handler future.
        request.abort();
        let _ = request.await;
        for _ in 0..100 {
            if stopped.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(cancel.is_cancelled());
        assert!(
            stopped.load(Ordering::SeqCst),
            "the job saw the cancellation"
        );
        // Its slot is free again.
        let far = Instant::now() + Duration::from_secs(5);
        assert!(gate.acquire(far).await.is_ok());
        // A job that finishes normally leaves the token alone (later phases of the request reuse it).
        let ok = Cancel::new(far);
        assert_eq!(run_job(&gate, &ok, |_| Ok(1)).await.unwrap(), 1);
        assert!(!ok.is_cancelled());
    }

    #[tokio::test]
    async fn jobs_time_out_and_cancel() {
        let gate = Gate::new(2, 2, Duration::from_secs(1), Arc::new(Metrics::new()));
        let cancel = Cancel::new(Instant::now() + Duration::from_millis(50));
        let seen = Arc::new(AtomicBool::new(false));
        let s = seen.clone();
        let r: ApiResult<()> = run_job(&gate, &cancel, move |c| {
            while !c.is_cancelled() {
                std::thread::sleep(Duration::from_millis(5));
            }
            s.store(true, Ordering::SeqCst);
            // Finish well after the deadline so the timeout wins the race.
            std::thread::sleep(Duration::from_millis(100));
            Ok(())
        })
        .await;
        assert_eq!(r.err().unwrap().code, "timeout");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            seen.load(Ordering::SeqCst),
            "the job observed the cancellation"
        );
        let ok = run_job(
            &gate,
            &Cancel::new(Instant::now() + Duration::from_secs(5)),
            |_| Ok(7),
        )
        .await;
        assert_eq!(ok.unwrap(), 7);
        let panicked: ApiResult<()> = run_job(
            &gate,
            &Cancel::new(Instant::now() + Duration::from_secs(5)),
            |_| panic!("boom"),
        )
        .await;
        assert_eq!(panicked.err().unwrap().code, "internal");
    }
}
