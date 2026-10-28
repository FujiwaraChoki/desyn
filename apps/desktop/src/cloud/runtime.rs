//! The network runtime: one small tokio runtime shared by the Convex client, HTTP calls and the sign-in loopback
//! listener. GPUI has its own executors, so work is spawned here and handed back through `futures` channels that
//! any executor can await.

use std::future::Future;
use std::sync::OnceLock;
use std::time::Duration;

use futures::channel::oneshot;

static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

/// The shared runtime (created on first use with two worker threads).
pub fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| {
        // reqwest and the websocket use rustls with the ring provider (the workspace's TLS crypto).
        let _ = rustls::crypto::ring::default_provider().install_default();
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("desyn-net")
            .enable_all()
            .build()
            .expect("tokio runtime")
    })
}

/// Error when the runtime dropped a task (shutdown).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;

/// Runs `fut` on the network runtime; the returned future resolves on any executor.
pub fn spawn<F, T>(fut: F) -> impl Future<Output = Result<T, Cancelled>> + Send + 'static
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = oneshot::channel();
    runtime().spawn(async move {
        let _ = tx.send(fut.await);
    });
    async move { rx.await.map_err(|_| Cancelled) }
}

/// Runs `fut` with a timeout on the network runtime (`None` when it took longer).
pub fn spawn_timeout<F, T>(
    limit: Duration,
    fut: F,
) -> impl Future<Output = Option<T>> + Send + 'static
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let f = spawn(async move { tokio::time::timeout(limit, fut).await.ok() });
    async move { f.await.ok().flatten() }
}

/// A task on the network runtime that is aborted when this guard is dropped (subscriptions, listeners).
pub struct TaskGuard(tokio::task::AbortHandle);

impl TaskGuard {
    /// Spawns a guarded task.
    pub fn spawn<F>(fut: F) -> TaskGuard
    where
        F: Future<Output = ()> + Send + 'static,
    {
        TaskGuard(runtime().spawn(fut).abort_handle())
    }
}

impl Drop for TaskGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// A timer future usable from any executor (sleeps on the network runtime).
pub fn sleep(d: Duration) -> impl Future<Output = ()> + Send + 'static {
    // The timer must be created inside the runtime (it registers with its reactor).
    let f = spawn(async move { tokio::time::sleep(d).await });
    async move {
        let _ = f.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_resolves_on_another_executor() {
        let v = futures::executor::block_on(spawn(async { 21 * 2 }));
        assert_eq!(v, Ok(42));
        let slow = futures::executor::block_on(spawn_timeout(Duration::from_millis(10), async {
            tokio::time::sleep(Duration::from_secs(5)).await;
        }));
        assert_eq!(slow, None);
    }
}
