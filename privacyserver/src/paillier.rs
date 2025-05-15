// src/lib.rs

use rand::thread_rng;
use num_bigint::{BigUint, RandBigInt};
use num_traits::One;
use num_prime::nt_funcs::is_prime;
use num_prime::PrimalityTestConfig;

/// A Paillier keypair
#[derive(Debug)]
pub struct PaillierKey {
    pub n:         BigUint,
    pub n_squared: BigUint,
    pub g:         BigUint,
    pub lambda:    BigUint,
    pub mu:        BigUint,
}

impl PaillierKey {
    /// Generate a new keypair with `bits` total size.
    pub fn new(bits: usize) -> Self {
        let p = gen_prime(bits/2);
        let q = gen_prime(bits/2);

        let n         = &p * &q;
        let n_squared = &n * &n;
        let g         = &n + BigUint::one();
        let lambda    = (&p - BigUint::one()) * (&q - BigUint::one());
        let mu        = lambda.modinv(&n)
                             .expect("λ must be invertible mod n");

        PaillierKey { n, n_squared, g, lambda, mu }
    }
}

/// Generate a random prime of exactly `bits` length.
fn gen_prime(bits: usize) -> BigUint {
    let mut rng = thread_rng();
    loop {
        // 1) random < 2^bits
        let mut cand = rng.gen_biguint(bits.try_into().unwrap());
        // 2) ensure high bit is set -> exactly `bits` long
        cand |= BigUint::one() << (bits - 1);
        // 3) ensure odd
        cand |= BigUint::one();
        // 4) Miller–Rabin or BPSW probabilistic test
        if is_prime(&cand, Some(PrimalityTestConfig::default())).probably() {
            return cand;
        }
    }
}

/// A Paillier ciphertext
#[derive(Debug)]
#[derive(Clone)]
pub struct PaillierCiphertext {
    pub c:         BigUint,
    pub n_squared: BigUint,
}

impl PaillierCiphertext {
    pub fn new(c: BigUint, n_squared: BigUint) -> Self {
        PaillierCiphertext { c, n_squared }
    }
}

/// Encrypt `m` under `key`
pub fn encrypt(key: &PaillierKey, m: &BigUint) -> PaillierCiphertext {
    let mut rng = thread_rng();
    let r: BigUint = rng.gen_biguint_below(&key.n);

    let c = key.g.modpow(m, &key.n_squared)
          * r.modpow(&key.n, &key.n_squared)
          % &key.n_squared;

    PaillierCiphertext::new(c, key.n_squared.clone())
}

/// Decrypt a Paillier ciphertext
pub fn decrypt(key: &PaillierKey, ct: &PaillierCiphertext) -> BigUint {
    // m = L(c^λ mod n²) · μ mod n, where L(u) = (u − 1) / n
    let x = ct.c.modpow(&key.lambda, &key.n_squared);
    let l = (&x - BigUint::one()) / &key.n;
    (&l * &key.mu) % &key.n
}

/// Homomorphic addition of two ciphertexts
pub fn homomorphic_addition(
    c1: &PaillierCiphertext,
    c2: &PaillierCiphertext,
    n_squared: &BigUint
) -> PaillierCiphertext {
    let c = (&c1.c * &c2.c) % n_squared;
    PaillierCiphertext::new(c, n_squared.clone())
}
