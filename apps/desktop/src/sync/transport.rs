//! The Convex implementation of the sync [`Transport`]: `designs.commit`, `designs.load` (all pages) and the live
//! `designOps.since` subscription.

use std::time::Duration;

use desyn_core::model::Design;
use futures::future::{FutureExt, LocalBoxFuture};
use futures::stream::{LocalBoxStream, StreamExt};
use serde_json::json;

use super::driver::Transport;
use super::wire;
use crate::cloud::api::{self, CommitResult, LoadHeader, LoadPage, Since, f};
use crate::cloud::{Cloud, CloudError, runtime};

/// Loads a cloud design (every page) and returns it with the seq to subscribe from and the header.
pub async fn load_design(
    cloud: Cloud,
    design_id: String,
) -> Result<(Design, u64, LoadHeader), CloudError> {
    let mut pages: Vec<LoadPage> = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..1000 {
        let v = cloud
            .query(
                f::DESIGNS_LOAD,
                json!({ "designId": design_id, "cursor": cursor }),
            )
            .await?;
        let page: LoadPage = api::decode(v)?;
        let done = page.is_done;
        cursor = page.cursor.clone();
        pages.push(page);
        if done || cursor.is_none() {
            break;
        }
    }
    let header = pages
        .first()
        .and_then(|p| p.header.clone())
        .ok_or_else(|| CloudError::server("The design could not be loaded."))?;
    let (design, seq) = wire::assemble(&pages).map_err(CloudError::server)?;
    Ok((design, seq, header))
}

/// Convex transport for one design.
pub struct ConvexTransport {
    /// Cloud handle.
    pub cloud: Cloud,
    /// Convex design id.
    pub design_id: String,
}

impl Transport for ConvexTransport {
    fn commit(
        &self,
        tx_json: String,
        base_seq: u64,
    ) -> LocalBoxFuture<'static, Result<CommitResult, CloudError>> {
        let f = self.cloud.mutation(
            f::DESIGNS_COMMIT,
            json!({ "designId": self.design_id, "baseSeq": base_seq, "tx": tx_json }),
        );
        async move { f.await.and_then(api::decode) }.boxed_local()
    }

    fn load(&self) -> LocalBoxFuture<'static, Result<(Design, u64), CloudError>> {
        let f = load_design(self.cloud.clone(), self.design_id.clone());
        async move { f.await.map(|(d, s, _)| (d, s)) }.boxed_local()
    }

    fn since(&self, seq: u64) -> LocalBoxStream<'static, Result<Since, CloudError>> {
        let live = self
            .cloud
            .subscribe(f::SINCE, json!({ "designId": self.design_id, "seq": seq }));
        futures::stream::unfold(live, |mut live| async move {
            let r = live.next().await?;
            Some((r.and_then(api::decode::<Since>), live))
        })
        .boxed_local()
    }

    fn sleep(&self, d: Duration) -> LocalBoxFuture<'static, ()> {
        runtime::sleep(d).boxed_local()
    }
}
