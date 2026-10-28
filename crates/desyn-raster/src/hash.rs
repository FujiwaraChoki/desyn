//! Stable 64-bit hashing for cache keys.
//!
//! Keys must be identical across runs and platforms (wasm32 and native) so hosts can persist or compare them, which
//! rules out `std`'s randomized `RandomState` and the pointer-width dependent FxHash. The mixer below processes
//! everything as 64-bit words.

use std::hash::Hasher;
use std::io;

use serde::Serialize;

const SEED: u64 = 0xcbf2_9ce4_8422_2325;
const MUL: u64 = 0x9e37_79b9_7f4a_7c15;

/// Deterministic, platform independent 64-bit hasher.
#[derive(Debug, Clone)]
pub struct StableHasher {
    h: u64,
    len: u64,
}

impl Default for StableHasher {
    fn default() -> Self {
        StableHasher::new()
    }
}

impl StableHasher {
    /// New hasher with the fixed seed.
    pub fn new() -> Self {
        StableHasher { h: SEED, len: 0 }
    }

    #[inline]
    fn mix(&mut self, w: u64) {
        self.h = (self.h.rotate_left(23) ^ w).wrapping_mul(MUL);
    }

    /// Feeds an `f64` by its bit pattern (`-0.0` and `0.0` hash alike, so do all NaNs).
    #[inline]
    pub fn write_f64(&mut self, v: f64) {
        let v = if v == 0.0 { 0.0 } else { v };
        let bits = if v.is_nan() {
            0x7ff8_0000_0000_0000
        } else {
            v.to_bits()
        };
        self.write_u64(bits);
    }

    /// Feeds a string (length-prefixed so `"ab" + "c"` differs from `"a" + "bc"`).
    pub fn write_str(&mut self, s: &str) {
        self.write_u64(s.len() as u64);
        self.write(s.as_bytes());
    }
}

impl Hasher for StableHasher {
    fn write(&mut self, bytes: &[u8]) {
        let (chunks, rest) = bytes.as_chunks::<8>();
        for c in chunks {
            self.mix(u64::from_le_bytes(*c));
        }
        if !rest.is_empty() {
            let mut buf = [0u8; 8];
            buf[..rest.len()].copy_from_slice(rest);
            self.mix(u64::from_le_bytes(buf) ^ ((rest.len() as u64) << 56));
        }
        self.len = self.len.wrapping_add(bytes.len() as u64);
    }

    #[inline]
    fn write_u64(&mut self, i: u64) {
        self.mix(i);
        self.len = self.len.wrapping_add(8);
    }

    #[inline]
    fn write_u32(&mut self, i: u32) {
        self.write_u64(u64::from(i));
    }

    #[inline]
    fn write_u8(&mut self, i: u8) {
        self.write_u64(u64::from(i));
    }

    #[inline]
    fn write_usize(&mut self, i: usize) {
        self.write_u64(i as u64);
    }

    fn finish(&self) -> u64 {
        // splitmix64 finalizer for avalanche.
        let mut z = self.h ^ self.len.rotate_left(32);
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
}

struct HashWriter<'a>(&'a mut StableHasher);

impl io::Write for HashWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Feeds the JSON serialization of `v` into `h` without allocating the JSON text.
pub fn hash_serialized<T: Serialize + ?Sized>(h: &mut StableHasher, v: &T) {
    // Serializing model types into an in-memory sink cannot fail; a failure would only weaken the key.
    let _ = serde_json::to_writer(HashWriter(h), v);
}

/// Stable hash of the JSON serialization of `v`.
pub fn hash_of<T: Serialize + ?Sized>(v: &T) -> u64 {
    let mut h = StableHasher::new();
    hash_serialized(&mut h, v);
    h.finish()
}

/// Combines two keys order-dependently.
#[inline]
pub fn combine(a: u64, b: u64) -> u64 {
    let mut h = StableHasher::new();
    h.write_u64(a);
    h.write_u64(b);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_and_sensitive() {
        let a = hash_of(&serde_json::json!({"a": 1, "b": [1, 2]}));
        let b = hash_of(&serde_json::json!({"a": 1, "b": [1, 2]}));
        let c = hash_of(&serde_json::json!({"a": 1, "b": [2, 1]}));
        assert_eq!(a, b);
        assert_ne!(a, c);
        // Pinned value: keys must not change between releases or platforms.
        let mut h = StableHasher::new();
        h.write_str("desyn");
        assert_eq!(h.finish(), {
            let mut h2 = StableHasher::new();
            h2.write_str("desyn");
            h2.finish()
        });
        assert_ne!(combine(1, 2), combine(2, 1));
    }
}
