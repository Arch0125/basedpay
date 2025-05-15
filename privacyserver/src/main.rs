use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use num_bigint::BigUint;
use num_traits::Zero;

use privacyserver::paillier::{           // import your library from lib.rs
    PaillierKey,
    PaillierCiphertext,
    encrypt,
    homomorphic_addition,
};

/// Single ledger entry, storing the raw ciphertext
struct Record {
    wallet: String,
    ct:     PaillierCiphertext,
}

/// In‐memory, append‐only ledger
static LEDGER: Lazy<Mutex<Vec<Record>>> =
    Lazy::new(|| Mutex::new(Vec::new()));

/// Generate one Paillier keypair on startup
static KEY: Lazy<PaillierKey> = Lazy::new(|| {
    PaillierKey::new(16)
});

/// Helper: get the last encrypted balance for `wallet`,
/// or an encryption of zero if none exists yet.
fn last_balance(wallet: &str) -> PaillierCiphertext {
    let ledger = LEDGER.lock().unwrap();
    if let Some(rec) = ledger.iter().rev().find(|r| r.wallet == wallet) {
        rec.ct.clone()
    } else {
        // encrypt(0) under public key
        encrypt(&KEY, &BigUint::zero())
    }
}

/// Incoming transaction request
#[derive(Deserialize)]
struct TxRequest {
    wallet: String,
    /// ciphertext as a decimal‐string of the BigUint `c`
    c:      String,
}

/// Response wrapping the new ciphertext
#[derive(Serialize)]
struct TxResponse {
    wallet: String,
    c:      String,
}

/// POST /credit
/// { "wallet": "...", "c": "<decimal‐string>" }
async fn credit(body: web::Json<TxRequest>) -> impl Responder {
    // parse the incoming ciphertext
    let m = match BigUint::parse_bytes(body.c.as_bytes(), 10) {
        Some(x) => x,
        None    => return HttpResponse::BadRequest().body("Invalid ciphertext"),
    };

    // encrypt(m) then homomorphically add to prior balance
    let ct_m     = encrypt(&KEY, &m);
    let prev_ct  = last_balance(&body.wallet);
    let new_ct   = homomorphic_addition(&prev_ct, &ct_m, &KEY.n_squared);

    // record it
    LEDGER.lock().unwrap().push(Record {
        wallet: body.wallet.clone(),
        ct:     new_ct.clone(),
    });

    // return the new balance ciphertext as decimal
    HttpResponse::Ok().json(TxResponse {
        wallet: body.wallet.clone(),
        c:      new_ct.c.to_str_radix(10),
    })
}

/// POST /debit
/// same shape as credit, but subtracts `m`
/// via encrypt(n − m) + prior
async fn debit(body: web::Json<TxRequest>) -> impl Responder {
    let m = match BigUint::parse_bytes(body.c.as_bytes(), 10) {
        Some(x) => x,
        None    => return HttpResponse::BadRequest().body("Invalid ciphertext"),
    };

    // compute ciphertext of (−m mod n)
    let neg_m = &KEY.n - &m;
    let ct_neg = encrypt(&KEY, &neg_m);

    let prev_ct = last_balance(&body.wallet);
    let new_ct  = homomorphic_addition(&prev_ct, &ct_neg, &KEY.n_squared);

    LEDGER.lock().unwrap().push(Record {
        wallet: body.wallet.clone(),
        ct:     new_ct.clone(),
    });

    HttpResponse::Ok().json(TxResponse {
        wallet: body.wallet.clone(),
        c:      new_ct.c.to_str_radix(10),
    })
}

/// GET /net/{wallet}
/// Returns `{ wallet: "...", c: "<decimal‐string>" }` or 404
async fn get_net(path: web::Path<String>) -> impl Responder {
    let wallet = path.into_inner();
    let ledger = LEDGER.lock().unwrap();
    if let Some(rec) = ledger.iter().rev().find(|r| r.wallet == wallet) {
        HttpResponse::Ok().json(TxResponse {
            wallet: wallet.clone(),
            c:      rec.ct.c.to_str_radix(10),
        })
    } else {
        HttpResponse::NotFound().body("No records for that wallet")
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // force key generation on start
    Lazy::force(&KEY);

    println!("Starting server...");

    HttpServer::new(|| {
        App::new()
            .route("/credit", web::post().to(credit))
            .route("/debit",  web::post().to(debit))
            .route("/net/{wallet}", web::get().to(get_net))
    })
    .bind(("127.0.0.1", 8085))?
    .run()
    .await
}
