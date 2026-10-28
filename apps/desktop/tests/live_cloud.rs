//! Live checks against a running Desyn Convex deployment (ignored by default; they need a server):
//!
//! ```sh
//! DESYN_LIVE_CONVEX_URL=http://127.0.0.1:3212 DESYN_LIVE_EMAIL=… DESYN_LIVE_PASSWORD=… \
//!   cargo test -p desyn-desktop --test live_cloud -- --ignored --nocapture
//! ```
//!
//! The account must exist with a verified email. The test signs in with email + password (the session token the
//! native flow also yields), opens the authenticated websocket, creates a cloud design, commits a transaction
//! through the sync engine's wire format, and reads it back through `designOps.since`.

use std::time::Duration;

use desyn_desktop::cloud::api::{self, CommitResult, DesignSummary, Page, Since, f};
use desyn_desktop::cloud::{Cloud, CloudCore, Connection, Endpoints, http, runtime};
use desyn_desktop::sync::{transport, wire};
use serde_json::{Value, json};

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

#[test]
#[ignore = "needs a running Convex deployment (DESYN_LIVE_CONVEX_URL)"]
fn sign_in_create_commit_and_follow() {
    let (Some(url), Some(email), Some(password)) = (
        env("DESYN_LIVE_CONVEX_URL"),
        env("DESYN_LIVE_EMAIL"),
        env("DESYN_LIVE_PASSWORD"),
    ) else {
        eprintln!("skipped: set DESYN_LIVE_CONVEX_URL, DESYN_LIVE_EMAIL, DESYN_LIVE_PASSWORD");
        return;
    };
    let endpoints = Endpoints::resolve(|k| (k == "DESYN_CONVEX_URL").then(|| url.clone()), None);
    let core = CloudCore::new(endpoints.clone());
    let cloud = Cloud {
        core: core.clone(),
        connection: Connection::Idle,
    };
    futures::executor::block_on(async {
        let site = endpoints.site_url.clone();
        let signed = runtime::spawn(async move {
            http::post_json(
                &format!("{site}/api/auth/sign-in/email"),
                &json!({ "email": email, "password": password }),
                None,
            )
            .await
        })
        .await
        .unwrap()
        .expect("sign in");
        let token = signed["token"].as_str().expect("token").to_string();
        let c2 = core.clone();
        runtime::spawn(async move { c2.set_session(Some(token)).await })
            .await
            .unwrap();

        let me = cloud.query(f::ME, json!({})).await.expect("me");
        let profile: api::Profile = api::decode(me).unwrap();
        eprintln!("signed in as {} ({})", profile.name, profile.user_id);
        let ws = profile.default_workspace_id.expect("workspace");

        // A live query delivers its first result.
        let mut live = cloud.subscribe(
            f::DESIGNS_LIST,
            json!({ "workspaceId": ws, "filter": "recent", "paginationOpts": api::page(12, None) }),
        );
        let first = tokio_timeout(live.next())
            .await
            .expect("list result (timed out)")
            .expect("stream")
            .expect("list");
        let page: Page<DesignSummary> = api::decode(first).unwrap();
        eprintln!("{} recent designs", page.page.len());

        let created = cloud
            .mutation(
                f::DESIGNS_CREATE,
                json!({ "workspaceId": ws, "presetId": "instagram-post", "name": "Live test" }),
            )
            .await
            .expect("create");
        let design_id = created["designId"].as_str().unwrap().to_string();
        let (design, seq, header) = transport::load_design(cloud.clone(), design_id.clone())
            .await
            .expect("load");
        assert_eq!(header.design_id, design_id);
        let page_id = design.page_ids()[0].clone();
        let tx = desyn_core::model::Transaction::new(
            "livetx000001",
            "Add rect",
            vec![desyn_core::model::Op::create(
                vec![desyn_core::model::Node::rect(
                    "liverect0001",
                    "Live",
                    10.0,
                    10.0,
                    100.0,
                    80.0,
                )],
                page_id,
                None,
            )],
        );
        let res: CommitResult = cloud
            .mutation(
                f::DESIGNS_COMMIT,
                json!({ "designId": design_id, "baseSeq": seq, "tx": wire::encode_tx(&tx) }),
            )
            .await
            .and_then(api::decode)
            .expect("commit");
        assert_eq!(res.seq, seq + 1);
        let again: CommitResult = cloud
            .mutation(
                f::DESIGNS_COMMIT,
                json!({ "designId": design_id, "baseSeq": seq, "tx": wire::encode_tx(&tx) }),
            )
            .await
            .and_then(api::decode)
            .expect("replay");
        assert!(again.duplicate, "idempotent on tx id");
        let mut since = cloud.subscribe(f::SINCE, json!({ "designId": design_id, "seq": seq }));
        let s: Since = api::decode(
            tokio_timeout(since.next())
                .await
                .expect("since (timed out)")
                .expect("stream")
                .expect("since ok"),
        )
        .unwrap();
        assert_eq!(s.ops.len(), 1);
        assert_eq!(s.ops[0].tx_id, "livetx000001");
        let entries = wire::decode_entries(&s.ops);
        assert_eq!(entries[0].tx.ops.len(), 1);
        let deleted: Value = cloud
            .mutation("designs/designs:delete", json!({ "designId": design_id }))
            .await
            .expect("trash");
        let _ = deleted;
        eprintln!("ok: seq {} committed and echoed", res.seq);
    });
}

async fn tokio_timeout<F: std::future::Future>(f: F) -> Option<F::Output> {
    use futures::future::{Either, select};
    let timer = runtime::sleep(Duration::from_secs(20));
    futures::pin_mut!(f);
    match select(f, Box::pin(timer)).await {
        Either::Left((v, _)) => Some(v),
        Either::Right(_) => None,
    }
}
