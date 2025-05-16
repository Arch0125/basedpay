use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use num_bigint::BigUint;
use num_traits::{Zero, FromPrimitive};

use privacyserver::paillier::{
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
    // e.g. 2048-bit modulus; pick your size
    PaillierKey::new(2048)
});

/// Helper: get the last encrypted balance for `wallet`,
/// or an encryption of zero if none exists yet.
fn last_balance(wallet: &str) -> PaillierCiphertext {
    let ledger = LEDGER.lock().unwrap();
    if let Some(rec) = ledger.iter().rev().find(|r| r.wallet == wallet) {
        rec.ct.clone()
    } else {
        encrypt(&KEY, &BigUint::zero())
    }
}

/// Incoming transaction request now carries plaintext `amount`
#[derive(Deserialize)]
struct TxRequest {
    wallet: String,
    amount: u64,
}

/// Response wrapping the new ciphertext
#[derive(Serialize)]
struct TxResponse {
    wallet: String,
    /// the Paillier ciphertext of the new net balance, as a decimal string
    c:      String,
}

/// POST /credit
/// { "wallet": "...", "amount": 100 }
async fn credit(body: web::Json<TxRequest>) -> impl Responder {
    // 1) turn the u64 into a BigUint
    let m = BigUint::from_u64(body.amount).unwrap();

    // 2) encrypt(m) then homomorphically add to prior balance
    let ct_m    = encrypt(&KEY, &m);
    let prev_ct = last_balance(&body.wallet);
    let new_ct  = homomorphic_addition(&prev_ct, &ct_m, &KEY.n_squared);

    // 3) append to ledger
    LEDGER.lock().unwrap().push(Record {
        wallet: body.wallet.clone(),
        ct:     new_ct.clone(),
    });

    // 4) return the new net‐balance ciphertext
    HttpResponse::Ok().json(TxResponse {
        wallet: body.wallet.clone(),
        c:      new_ct.c.to_str_radix(10),
    })
}

/// POST /debit
/// { "wallet": "...", "amount": 40 }
async fn debit(body: web::Json<TxRequest>) -> impl Responder {
    let m = BigUint::from_u64(body.amount).unwrap();

    // to subtract, encrypt (n - m) which is equivalent to (-m mod n)
    let neg_m  = &KEY.n - &m;
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
/// Returns `{ wallet: "...", c: "<decimal>" }`
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
    Lazy::force(&KEY);
    println!("Starting server on 127.0.0.1:8085");
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
